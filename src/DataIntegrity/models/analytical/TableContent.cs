using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Net;
using System.Text;
using Clipper2Lib;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	public record TableContent(
		Collection<SpanContent> Spans,
		Collection<BoundingRegion> BoundingRegions,
		int RowCount,
		int ColumnCount,
		Collection<TableCellContent> Cells,
		Collection<TableFootnoteCaptionContent> Footnotes,
		CaptionContent Caption
	)
	{
		public bool IsInExclusionZone(PageExclusionZone exclusionZones, int pageNumber)
		{
			int startingPage = exclusionZones.StartingPage ?? pageNumber;
			long endingPageExclusive =
				(long)startingPage + (exclusionZones.PageCount ?? int.MaxValue);
			foreach (var boundingRegion in BoundingRegions)
			{
				if (
					startingPage <= boundingRegion.PageNumber
					&& boundingRegion.PageNumber < endingPageExclusive
				)
				{
					if (exclusionZones.IsInExclusionZone(boundingRegion.Polygon))
					{
						return true;
					}
				}
			}

			return false;
		}

		public override string ToString()
		{
			StringBuilder results = new StringBuilder("<table style=\"border: 1px solid;\">");
			if (Caption != null)
			{
				results.Append("<caption>");
				results.Append(Caption.Content);
				results.Append("</caption>");
			}
			var workingCells = Cells.ToList();
			var spannedCells = new List<TableCellContent>();
			for (int rowIndex = 0; rowIndex < RowCount; rowIndex++)
			{
				if (rowIndex == 0)
				{
					results.AppendLine("<thead>");
				}
				else if (rowIndex == 1)
				{
					results.AppendLine("<tbody>");
				}
				results.AppendLine("<tr style=\"border: 1px solid;\">");
				for (int columnIndex = 0; columnIndex < ColumnCount; columnIndex++)
				{
					if (!IsCovered(spannedCells, rowIndex, columnIndex))
					{
						bool cellAddressed = false;
						foreach (TableCellContent cell in workingCells.ToArray())
						{
							if (cell.ColumnIndex == columnIndex && cell.RowIndex == rowIndex)
							{
								workingCells.Remove(cell);
								cellAddressed = true;
								if (cell.ColumnSpan > 1 || cell.RowSpan > 1)
								{
									if (cell.Kind == TableCellKind.ColumnHeader)
									{
										results.Append("<th");
									}
									else
									{
										results.Append("<td");
									}
									if (cell.ColumnSpan > 0)
									{
										results.Append($" colspan={cell.ColumnSpan}");
									}
									if (cell.RowSpan > 0)
									{
										results.Append($" rowspan={cell.RowSpan}");
									}
									results.Append($" style=\"border: 1px solid;\">");
									spannedCells.Add(cell);
									columnIndex += Math.Max(cell.ColumnSpan, 1) - 1;
								}
								else
								{
									if (cell.Kind == TableCellKind.ColumnHeader)
									{
										results.Append("<th style=\"border: 1px solid;\">");
									}
									else
									{
										results.Append("<td style=\"border: 1px solid;\">");
									}
								}
								results.Append(WebUtility.HtmlEncode(cell.Content));
								if (cell.Kind == TableCellKind.ColumnHeader)
								{
									results.Append("</th>");
								}
								else
								{
									results.Append("</td>");
								}

								break;
							}
						}

						if (!cellAddressed)
						{
							results.Append("<td style=\"border: 1px solid;\"></td>");
						}
					}
				}
				results.Append("</tr>");
				if (rowIndex == 0)
				{
					results.AppendLine("</thead>");
				}
			}
			results.Append("</tbody>");
			results.Append("</table>");
			return results.ToString();
		}

		private static bool IsCovered(
			List<TableCellContent> spannedItems,
			int rowIndex,
			int columnIndex
		)
		{
			foreach (TableCellContent cell in spannedItems)
			{
				long rowEndExclusive = (long)cell.RowIndex + Math.Max(cell.RowSpan, 1);
				long columnEndExclusive = (long)cell.ColumnIndex + Math.Max(cell.ColumnSpan, 1);
				if (
					cell.RowIndex <= rowIndex
					&& rowIndex < rowEndExclusive
					&& cell.ColumnIndex <= columnIndex
					&& columnIndex < columnEndExclusive
				)
				{
					return true;
				}
			}

			return false;
		}
	}

	public record TableCellContent(
		Collection<SpanContent> Spans,
		Collection<BoundingRegion> BoundingRegions,
		int ColumnIndex,
		[DefaultValue(0)] int ColumnSpan,
		int RowIndex,
		[DefaultValue(0)] int RowSpan,
		string Content,
		Collection<string> Elements,
		[DefaultValue(TableCellKind.Content)] TableCellKind? Kind
	);

	public record TableFootnoteCaptionContent(
		Collection<SpanContent> Spans,
		Collection<BoundingRegion> BoundingRegions,
		string Content,
		Collection<string> Elements
	);
}
