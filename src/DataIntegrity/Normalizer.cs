using System.Collections.Generic;
using System.Collections.Immutable;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Text;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity
{
	public class Normalizer
	{
		private PageExclusionZone? defaultExclusionZones;
		private readonly SortedDictionary<int, AdjustedPage> adjustedPages;
		private readonly List<TableContent> applicableTables;
		private readonly List<SectionContent> sections;
		private readonly DocumentIntelligenceResult languageResult;
		private readonly string filename;
		private readonly string location;
		private bool isClosed;

		public Normalizer(DocumentIntelligenceResult input, string filename, string location)
		{
			this.languageResult = input;
			this.filename = filename;
			this.location = location;
			this.applicableTables =
				input.AnalyzeResult.Tables?.ToList() ?? new List<TableContent>();
			this.sections = input.AnalyzeResult.Sections?.ToList() ?? new List<SectionContent>();
			var candidateParagraphs = input.AnalyzeResult.Paragraphs.ToList();
			this.adjustedPages = new SortedDictionary<int, AdjustedPage>(
				input
					.AnalyzeResult.Pages.Select(x => PreparePage(x, candidateParagraphs))
					.ToDictionary(x => x.PageNumber)
			);
		}

		public void AddExclusionZone(ExclusionZones? exclusionZones)
		{
			if (exclusionZones?.Default != null)
			{
				this.defaultExclusionZones = exclusionZones.Default;
			}
			if (exclusionZones?.Pages != null)
			{
				foreach (var pageExclusionZone in exclusionZones.Pages)
				{
					int startingPage = pageExclusionZone.StartingPage ?? 1;
					int pageCount =
						pageExclusionZone.PageCount
						?? languageResult.AnalyzeResult.Pages.Count - startingPage + 1;
					for (
						int pageIndex = startingPage;
						pageIndex < pageCount + startingPage;
						pageIndex++
					)
					{
						adjustedPages[pageIndex].AddExclusionZone(pageExclusionZone);
						foreach (var table in this.applicableTables.ToList())
						{
							if (table.IsInExclusionZone(pageExclusionZone, pageIndex))
							{
								applicableTables.Remove(table);
							}
						}
					}
				}
			}
		}

		public void Close()
		{
			if (!isClosed)
			{
				this.isClosed = true;
				var candidateTables = this.applicableTables;
				foreach (var adjustedPage in this.adjustedPages.Values)
				{
					if (this.defaultExclusionZones != null)
					{
						if (!adjustedPage.HasExclusionZones)
						{
							adjustedPage.AddExclusionZone(this.defaultExclusionZones);
							foreach (var applicableTable in candidateTables.ToArray())
							{
								if (
									applicableTable.IsInExclusionZone(
										this.defaultExclusionZones,
										adjustedPage.PageNumber
									)
								)
								{
									candidateTables.Remove(applicableTable);
								}
							}
						}
					}
					foreach (var applicableTable in candidateTables.ToArray())
					{
						if (applicableTable != null && adjustedPage.IsApplicable(applicableTable))
						{
							candidateTables.Remove(applicableTable);
						}
					}
					foreach (var section in this.sections)
					{
						if (section != null)
						{
							adjustedPage.AddSection(section);
						}
					}
					adjustedPage.Close();
				}
			}
		}

		public ImmutableArray<AdjustedPage> Pages
		{
			get => this.adjustedPages.Values.ToImmutableArray();
		}

		public string ToString(int start = 1, int length = -1)
		{
			StringBuilder stringBuilder = new StringBuilder();
			stringBuilder.AppendLine($"# [{this.filename}]({this.location})");
			var lastPage = length == -1 ? this.adjustedPages.Count + 1 : start + length;
			var desiredPages = this.adjustedPages.Values.Where(x =>
				x.PageNumber >= start && x.PageNumber < lastPage
			);
			foreach (var page in desiredPages)
			{
				var pageContent = page.ToString();
				if (string.IsNullOrWhiteSpace(pageContent))
				{
					continue;
				}

				stringBuilder.AppendLine(pageContent);
			}

			if (desiredPages.Count() == 0 && this.languageResult.AnalyzeResult.Content != null)
			{
				stringBuilder.AppendLine(this.languageResult.AnalyzeResult.Content);
			}

			return stringBuilder.ToString();
		}

		private static AdjustedPage PreparePage(
			PageContent currentPage,
			List<ParagraphContent> candidateParagraphs
		)
		{
			var page = new AdjustedPage(currentPage);
			foreach (var paragraph in candidateParagraphs.ToList())
			{
				if (paragraph != null && page.IsApplicable(paragraph))
				{
					candidateParagraphs.Remove(paragraph);
				}
			}
			return page;
		}
	}
}
