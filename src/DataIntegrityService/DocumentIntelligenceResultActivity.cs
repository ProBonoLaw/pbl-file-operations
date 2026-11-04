using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Azure;
using Azure.AI.DocumentIntelligence;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration
{
	public class DocumentIntelligenceResultActivity
	{
		private const int MaxXlsxFastPathBytes = 128 * 1024 * 1024; // 128 MB
		private const long MaxXlsxCharactersInPart = 128_000_000;
		private const int MaxWorksheetRows = 20_000;
		private const int MaxWorksheetColumns = 200;
		private const int MaxCellCharacters = 4_000;
		private const int MaxMarkdownCharacters = 8_000_000;
		private const string OutputTruncationNotice = "_Output truncated due to safety limits._";

		private readonly DocumentIntelligenceClient documentIntelligenceClient;
		private readonly ILogger<DocumentIntelligenceResultActivity> logger;
		private readonly BlobServiceClient blobServiceClient;
		private readonly TelemetryClient telemetryClient;

		public DocumentIntelligenceResultActivity(
			ILogger<DocumentIntelligenceResultActivity> logger,
			DocumentIntelligenceClient documentIntelligenceClient,
			BlobServiceClient blobServiceClient,
			TelemetryClient telemetryClient)
		{
			this.documentIntelligenceClient = documentIntelligenceClient;
			this.logger = logger;
			this.blobServiceClient = blobServiceClient;
			this.telemetryClient = telemetryClient;
		}
		public async Task<NeedAnalysis> RunAsync(DocumentIntelligenceInput input, CancellationToken cancellationToken)
		{
		using IDisposable telemetryScope = DataIntegrityTelemetryContext.Begin(logger, input.AccountId, input.SourceId);
			var blobContainerClient = blobServiceClient.GetBlobContainerClient(input.Container);
			var blobClient = blobContainerClient.GetBlobClient(input.FilePath);
			bool isCsvFile = string.Equals(ExtractionPolicy.Extension(input.Filename, input.FilePath), ".csv", StringComparison.OrdinalIgnoreCase);
			if (isCsvFile && input.HasExclusionZones)
				throw new InvalidDataException("CSV has no physical page coordinates for exclusion zones.");
			if (isCsvFile)
			{
				var properties = await blobClient.GetPropertiesAsync(cancellationToken: cancellationToken);
				if (properties.Value.ContentLength > CsvMarkdownConverter.MaxSourceBytes)
					throw new InvalidDataException("CSV source exceeds 128 MB.");
				var source = await blobClient.DownloadStreamingAsync(new Azure.Storage.Blobs.Models.BlobDownloadOptions
					{ Conditions = new Azure.Storage.Blobs.Models.BlobRequestConditions { IfMatch = properties.Value.ETag } }, cancellationToken);
				await using var csv = source.Value.Content;
				return new NeedAnalysis(false, Content: CsvMarkdownConverter.Convert(csv, cancellationToken));
			}
			logger.LogInformation(
				"Checking if {FilePath} exists in container {Container}.",
				input.FilePath,
				input.Container
			);
			if (!await blobClient.ExistsAsync(cancellationToken))
			{
				throw new FileNotFoundException("Document Not Found!");
			}
			logger.LogInformation(
				"Confirmed that {FilePath} exists in container {Container}. Proceeding with download.",
				input.FilePath,
				input.Container
			);
			var downloadResult = await blobClient.DownloadContentAsync(cancellationToken);
			bool hasExclusionZones = input.HasExclusionZones;

			byte[] rawFileContent = downloadResult.Value.Content.ToArray();
			if (input.NormalizeEncryptedPdf)
				rawFileContent = await PdfNormalizer.DecryptAsync(rawFileContent,
					input.ExpectedPageCount ?? throw new InvalidDataException("PDF page count is required for normalization."),
					cancellationToken);
			try
			{
				bool isXlsxFile = IsXlsxFile(input.Filename ?? input.FilePath) &&
					!rawFileContent.AsSpan().StartsWith("%PDF-"u8);
				if (isXlsxFile && hasExclusionZones)
				{
					logger.LogInformation(
						"Skipping XLSX fast-path for {FilePath} because exclusion zones require positional analysis.",
						input.FilePath
					);
				}
				if (isXlsxFile && !hasExclusionZones)
				{
					if (rawFileContent.Length > MaxXlsxFastPathBytes)
					{
						logger.LogWarning(
							"Skipping XLSX fast-path for {FilePath} because file size {FileSizeBytes} exceeds limit {MaxFastPathBytes}. Proceeding with OCR.",
							input.FilePath,
							rawFileContent.Length,
							MaxXlsxFastPathBytes
						);
					}
					else
					{
					try
					{
						using var stream = new MemoryStream(rawFileContent);
						var openSettings = new OpenSettings
						{
							MaxCharactersInPart = MaxXlsxCharactersInPart,
						};
						using var spreadsheet = SpreadsheetDocument.Open(stream, false, openSettings);
						var workbookPart = spreadsheet.WorkbookPart
							?? throw new InvalidDataException("XLSX workbook could not be loaded.");

						bool hasImages = XlsxContainsImages(workbookPart);
						if (!hasImages)
						{
							logger.LogInformation(
								"Detected plain XLSX without images for {FilePath}. Converting to markdown without OCR.",
								input.FilePath
							);
							string xlsxMarkdown = ConvertPlainXlsxToMarkdown(workbookPart);
							return new NeedAnalysis(false, Content: xlsxMarkdown);
						}
					}
					catch (Exception ex)
					{
						logger.LogWarning(
							ex,
							"Unable to process XLSX fast-path for {FilePath}. Falling back to OCR.",
							input.FilePath
						);
					}
					}

					logger.LogInformation(
						"Proceeding with OCR for XLSX file {FilePath}.",
						input.FilePath
					);
				}

				logger.LogInformation("Analyzing document {FilePath}.", input.FilePath);
				var request = new AnalyzeDocumentOptions(
					"prebuilt-layout",
					BinaryData.FromBytes(rawFileContent)
				)
				{
					OutputContentFormat = DocumentContentFormat.Markdown
				};
				if (input.HighRes)
				{
					request.Features.Add(DocumentAnalysisFeature.OcrHighResolution);
				}
				var response2 = await documentIntelligenceClient.AnalyzeDocumentAsync(
					WaitUntil.Completed,
					request,
					cancellationToken
				);
				if (response2.HasCompleted && response2.HasValue)
				{
					if (input.PreserveDocumentPages && response2.Value.Pages.Count != input.ExpectedPageCount)
						throw new InvalidDataException("Document Intelligence did not analyze every source page.");
					logger.LogInformation("Analysis of document {FilePath} completed.", input.FilePath);
					telemetryClient.TrackEvent("DocumentAnalysisCompleted",
						new Dictionary<string, string> { { "sourceId", input.SourceId }, {"accountId", input.AccountId }, { "sessionId", response2.Id } },
						new Dictionary<string, double> { { "pagesAnalyzed", response2.Value.Pages.Count } });
					Azure.Response result = response2.GetRawResponse();
					DocumentIntelligenceResult? documentIntelligenceResult = null;
					if (hasExclusionZones)
					{
						documentIntelligenceResult =
							JsonSerializer.Deserialize<DocumentIntelligenceResult>(
								result.Content,
								new JsonSerializerOptions
								{
									PropertyNameCaseInsensitive = true,
									UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip,
								}
							);
					}
					string content = input.PreserveDocumentPages
						? DocumentIntelligencePageMarkdown.Insert(response2.Value.Content,
							response2.Value.Pages.Select(page => (page.PageNumber,
								page.Spans.Count == 0 ? (int?)null : page.Spans.Min(span => span.Offset))).ToArray())
						: response2.Value.Content;
					return new NeedAnalysis(
						hasExclusionZones,
						documentIntelligenceResult,
						content
					);
				}
			}
			catch (RequestFailedException re)
			{
				logger.LogError(re, "Error occurred while analyzing document.");
				var request3 = new AnalyzeDocumentOptions(
					"prebuilt-layout",
					BinaryData.FromBytes(rawFileContent)
				)
				{
					OutputContentFormat = DocumentContentFormat.Markdown,
					Locale = "en-US",
				};
				try
				{
					var response3 = await documentIntelligenceClient.AnalyzeDocumentAsync(
						WaitUntil.Completed,
						request3,
						cancellationToken
					);
					if (response3.HasCompleted && response3.HasValue)
					{
							if (input.PreserveDocumentPages && response3.Value.Pages.Count != input.ExpectedPageCount)
								throw new InvalidDataException("Document Intelligence did not analyze every source page.");
						DocumentIntelligenceResult? fallbackResult = null;
						if (hasExclusionZones)
						{
							fallbackResult = JsonSerializer.Deserialize<DocumentIntelligenceResult>(
								response3.GetRawResponse().Content,
								new JsonSerializerOptions
								{
									PropertyNameCaseInsensitive = true,
									UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip,
								}
							);
							if (fallbackResult is null)
							{
								throw new UnprocessableDocumentException(
									"Document did not contain positional data required to apply exclusions.");
							}
						}
						string content = input.PreserveDocumentPages
							? DocumentIntelligencePageMarkdown.Insert(response3.Value.Content,
								response3.Value.Pages.Select(page => (page.PageNumber,
									page.Spans.Count == 0 ? (int?)null : page.Spans.Min(span => span.Offset))).ToArray())
							: response3.Value.Content;
						return new NeedAnalysis(
							hasExclusionZones,
							fallbackResult,
							content
						);
					}
				}
				catch (RequestFailedException exception) when (
					exception.Status != 400 && exception.Status != 413 &&
					exception.Status != 415 && exception.Status != 422)
				{
					throw;
				}
				catch (RequestFailedException)
				{
					throw new UnprocessableDocumentException("Data provided was not processable.");
				}
			}

			throw new UnprocessableDocumentException("Data provided was not processable.");
		}

		private static bool IsXlsxFile(string? filePath)
		{
			return string.Equals(
				Path.GetExtension(filePath),
				".xlsx",
				StringComparison.OrdinalIgnoreCase
			);
		}

		private static bool XlsxContainsImages(WorkbookPart workbookPart)
		{
			return workbookPart.WorksheetParts.Any(
				ws =>
					ws.DrawingsPart != null
					&& ws.DrawingsPart.ImageParts.Any()
			);
		}

		private static string ConvertPlainXlsxToMarkdown(WorkbookPart workbookPart)
		{
			var sheets = workbookPart.Workbook.Sheets?.Elements<Sheet>() ?? Enumerable.Empty<Sheet>();
			var markdown = new StringBuilder();
			bool outputTruncated = false;

			foreach (var sheet in sheets)
			{
				if (!TryAppendLine(markdown, $"## {EscapeMarkdownText(sheet.Name?.Value ?? "Worksheet")}", ref outputTruncated))
				{
					break;
				}
				if (!TryAppendLine(markdown, string.Empty, ref outputTruncated))
				{
					break;
				}

				if (sheet.Id?.Value == null)
				{
					if (!TryAppendLine(markdown, "_Empty worksheet_", ref outputTruncated))
					{
						break;
					}
					if (!TryAppendLine(markdown, string.Empty, ref outputTruncated))
					{
						break;
					}
					continue;
				}

				var worksheetPart = (WorksheetPart)workbookPart.GetPartById(sheet.Id.Value);
				var sheetData = worksheetPart.Worksheet.Elements<SheetData>().FirstOrDefault();
				var rows = new List<Row>();
				bool rowsTruncated = false;
				if (sheetData != null)
				{
					int rowCount = 0;
					foreach (var row in sheetData.Elements<Row>())
					{
						if (rowCount >= MaxWorksheetRows)
						{
							rowsTruncated = true;
							break;
						}
						rows.Add(row);
						rowCount++;
					}
				}

				if (!rows.Any())
				{
					if (!TryAppendLine(markdown, "_Empty worksheet_", ref outputTruncated))
					{
						break;
					}
					if (!TryAppendLine(markdown, string.Empty, ref outputTruncated))
					{
						break;
					}
					continue;
				}

				var orderedRows = rows
					.Select((row, index) =>
					{
						var values = BuildRowValues(row, workbookPart, out bool rowColumnsTruncated);
						return new
						{
							RowNumber = (uint)(row.RowIndex?.Value ?? (uint)(index + 1)),
							Values = values,
							ColumnsTruncated = rowColumnsTruncated,
						};
					})
					.OrderBy(x => x.RowNumber)
					.ToList();

				int maxColumn = orderedRows
					.SelectMany(r => r.Values.Keys)
					.DefaultIfEmpty(0)
					.Max();
				bool columnsTruncated = orderedRows.Any(row => row.ColumnsTruncated);

				if (maxColumn <= 0)
				{
					string emptyMessage = columnsTruncated
						? $"_No cells within the first {MaxWorksheetColumns} columns._"
						: "_Empty worksheet_";
					if (!TryAppendLine(markdown, emptyMessage, ref outputTruncated))
					{
						break;
					}
					if (rowsTruncated || columnsTruncated)
					{
						if (!TryAppendLine(markdown, "_Worksheet output truncated due to safety limits._", ref outputTruncated))
						{
							break;
						}
					}
					if (!TryAppendLine(markdown, string.Empty, ref outputTruncated))
					{
						break;
					}
					continue;
				}

				var headerBuilder = new StringBuilder("|");
				for (int col = 1; col <= maxColumn; col++)
				{
					headerBuilder.Append($" Column {col} |");
				}
				if (!TryAppendLine(markdown, headerBuilder.ToString(), ref outputTruncated))
				{
					break;
				}

				var dividerBuilder = new StringBuilder("|");
				for (int col = 1; col <= maxColumn; col++)
				{
					dividerBuilder.Append(" --- |");
				}
				if (!TryAppendLine(markdown, dividerBuilder.ToString(), ref outputTruncated))
				{
					break;
				}

				foreach (var row in orderedRows)
				{
					var rowBuilder = new StringBuilder("|");
					var cells = row.Values;
					for (int col = 1; col <= maxColumn; col++)
					{
						cells.TryGetValue(col, out var value);
						rowBuilder.Append($" {EscapeMarkdownText(value)} |");
					}
					if (!TryAppendLine(markdown, rowBuilder.ToString(), ref outputTruncated))
					{
						break;
					}
				}

				if (outputTruncated)
				{
					break;
				}

				if (rowsTruncated || columnsTruncated)
				{
					if (!TryAppendLine(markdown, "_Worksheet output truncated due to safety limits._", ref outputTruncated))
					{
						break;
					}
				}

				if (!TryAppendLine(markdown, string.Empty, ref outputTruncated))
				{
					break;
				}
			}

			if (outputTruncated)
			{
				markdown.AppendLine(OutputTruncationNotice);
			}

			return markdown.ToString().TrimEnd();
		}

		private static Dictionary<int, string> BuildRowValues(
			Row row,
			WorkbookPart workbookPart,
			out bool columnsTruncated)
		{
			var result = new Dictionary<int, string>();
			columnsTruncated = false;
			int nextColumn = 1;
			foreach (var cell in row.Elements<Cell>())
			{
				int column = GetColumnIndex(cell.CellReference?.Value);
				if (column <= 0)
				{
					column = nextColumn;
				}
				if (column > MaxWorksheetColumns)
				{
					columnsTruncated = true;
					nextColumn = Math.Max(nextColumn, column + 1);
					continue;
				}

				result[column] = GetCellText(cell, workbookPart);
				nextColumn = Math.Max(nextColumn, column + 1);
			}

			return result;
		}

		private static string GetCellText(Cell cell, WorkbookPart workbookPart)
		{
			string value = cell.CellValue?.InnerText ?? string.Empty;

			if (cell.DataType == null)
			{
				return LimitCellText(value);
			}

			var dataType = cell.DataType.Value;
			if (dataType == CellValues.SharedString)
			{
				return GetSharedStringValue(value, workbookPart);
			}
			if (dataType == CellValues.Boolean)
			{
				return value == "1" ? "TRUE" : "FALSE";
			}
			if (dataType == CellValues.InlineString)
			{
				return LimitCellText(cell.InlineString?.InnerText ?? string.Empty);
			}

			return LimitCellText(value);
		}

		private static string GetSharedStringValue(string value, WorkbookPart workbookPart)
		{
			if (!int.TryParse(value, out int stringIndex))
			{
				return value;
			}

			var sharedStringTable = workbookPart.SharedStringTablePart?.SharedStringTable;
			if (sharedStringTable == null)
			{
				return value;
			}

			if (stringIndex < 0 || stringIndex >= sharedStringTable.ChildElements.Count)
			{
				return value;
			}

			var sharedStringItem = sharedStringTable.ChildElements[stringIndex] as SharedStringItem;
			return LimitCellText(sharedStringItem?.InnerText ?? value);
		}

		private static int GetColumnIndex(string? cellReference)
		{
			if (string.IsNullOrWhiteSpace(cellReference))
			{
				return 0;
			}

			int columnIndex = 0;
			foreach (char ch in cellReference)
			{
				if (!char.IsLetter(ch))
				{
					break;
				}
				columnIndex = (columnIndex * 26) + (char.ToUpperInvariant(ch) - 'A' + 1);
			}

			return columnIndex;
		}

		private static string EscapeMarkdownText(string? input)
		{
			if (string.IsNullOrEmpty(input))
			{
				return string.Empty;
			}

			return input
				.Replace("\\", "\\\\", StringComparison.Ordinal)
				.Replace("|", "\\|", StringComparison.Ordinal)
				.Replace("\r\n", "<br/>", StringComparison.Ordinal)
				.Replace("\n", "<br/>", StringComparison.Ordinal)
				.Replace("\r", "<br/>", StringComparison.Ordinal);
		}

		private static string LimitCellText(string value)
		{
			if (value.Length <= MaxCellCharacters)
			{
				return value;
			}

			return value[..MaxCellCharacters];
		}

		private static bool TryAppendLine(StringBuilder markdown, string line, ref bool outputTruncated)
		{
			if (outputTruncated)
			{
				return false;
			}

			int additionalLength = line.Length + Environment.NewLine.Length;
			int contentLimit = MaxMarkdownCharacters
				- OutputTruncationNotice.Length
				- Environment.NewLine.Length;
			if (markdown.Length + additionalLength > contentLimit)
			{
				outputTruncated = true;
				return false;
			}

			markdown.AppendLine(line);
			return true;
		}
	}
}
