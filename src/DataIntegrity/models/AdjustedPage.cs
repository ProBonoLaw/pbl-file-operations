using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using Clipper2Lib;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.utils;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models
{
	public class AdjustedPage
	{
		private static readonly AdjustedParagraphSpanComparer comparer =
			new AdjustedParagraphSpanComparer();
		public int PageNumber { get; init; }
		public SpanContent PageSpan { get; init; }
		private readonly PageContent content;
		private readonly SortedSet<AdjustedParagraph> paragraphs;
		private readonly List<PageExclusionZone> exclusionZones;
		private readonly Collection<WordContent> excludedWords;
		private Dictionary<AdjustedParagraph, TableContent> tableContents;
		private Dictionary<AdjustedParagraph, SectionContent> sectionContents;

		private bool isClosed = false;

		public AdjustedPage(PageContent content)
		{
			this.PageNumber = content.PageNumber;
			this.content = content;
			this.paragraphs = new SortedSet<AdjustedParagraph>(comparer);
			this.exclusionZones = new List<PageExclusionZone>();
			this.tableContents = new Dictionary<AdjustedParagraph, TableContent>();
			this.sectionContents = new Dictionary<AdjustedParagraph, SectionContent>();
			int offset = -1;
			long pageEnd = -1;
			foreach (var span in content.Spans.OrderBy(x => x.Offset))
			{
				if (offset == -1)
				{
					offset = span.Offset;
				}
				pageEnd = Math.Max(pageEnd, (long)span.Offset + span.Length);
			}
			this.PageSpan = new SpanContent(offset, checked((int)(pageEnd - offset)));
			this.excludedWords = new Collection<WordContent>();
		}

		public bool IsApplicable(ParagraphContent paragraph)
		{
			var firstParagraphSpan = paragraph.Spans.First();
			if (
				firstParagraphSpan.Offset >= this.PageSpan.Offset
				&& firstParagraphSpan.Offset + firstParagraphSpan.Length
					<= this.PageSpan.Offset + this.PageSpan.Length
			)
			{
				if (!this.paragraphs.Any(x => x.Equals(paragraph)))
				{
					var adjParagraph = new AdjustedParagraph(paragraph);
					this.paragraphs.Add(adjParagraph);
					foreach (var wordCandidate in content.Words)
					{
						adjParagraph.IsApplicable(wordCandidate);
					}
				}

				return true;
			}
			return false;
		}

		public bool IsApplicable(TableContent tableContent)
		{
			bool isApplicable = false;
			var testParagraphs = this.paragraphs.ToList();
			foreach (var tableSpan in tableContent.Spans)
			{
				if (
					tableSpan.Offset >= this.PageSpan.Offset
					&& tableSpan.Offset + tableSpan.Length
						<= this.PageSpan.Offset + this.PageSpan.Length
				)
				{
					if (!this.tableContents.Any(x => x.Equals(tableContent)))
					{
						foreach (var adjParagraph in testParagraphs.ToArray())
						{
							if (adjParagraph.IsApplicable(tableContent))
							{
								this.tableContents[adjParagraph] = tableContent;
								isApplicable = true;
								testParagraphs.Remove(adjParagraph);
							}
						}
					}
				}
			}

			return isApplicable;
		}

		public void AddSection(SectionContent sectionContent)
		{
			var testParagraphs = this.paragraphs.ToList();
			foreach (var tableSpan in sectionContent.Spans)
			{
				if (
					tableSpan.Offset >= this.PageSpan.Offset
					&& tableSpan.Offset + tableSpan.Length
						<= this.PageSpan.Offset + this.PageSpan.Length
				)
				{
					if (!this.tableContents.Any(x => x.Equals(sectionContent)))
					{
						foreach (var adjParagraph in testParagraphs.ToArray())
						{
							if (adjParagraph.IsApplicable(sectionContent))
							{
								this.sectionContents[adjParagraph] = sectionContent;
							}
						}
					}
				}
			}
		}

		public void AddExclusionZone(PageExclusionZone exclusionZones)
		{
			if (this.isClosed)
			{
				throw new InvalidOperationException("The Page is closed to additional changes.");
			}

			if (exclusionZones.StartingPage != null)
			{
				int startingPage = (int)exclusionZones.StartingPage;
				long endingPageExclusive =
					(long)startingPage + (exclusionZones.PageCount ?? int.MaxValue);
				if (this.PageNumber < startingPage || this.PageNumber >= endingPageExclusive)
				{
					return;
				}
			}

			this.exclusionZones.Add(exclusionZones);
			this.ProcessExcludedWords();
		}

		public bool HasExclusionZones
		{
			get => this.exclusionZones.Any();
		}

		public ImmutableArray<AdjustedParagraph> Paragraphs
		{
			get => this.paragraphs.ToImmutableArray();
		}

		public ImmutableArray<WordContent> ExcludedWords
		{
			get => this.excludedWords.ToImmutableArray();
		}

		public void Close()
		{
			if (this.isClosed)
			{
				return;
			}
			this.isClosed = true;
			var unclaimedExcludedWords = new List<WordContent>(this.excludedWords);
			foreach (var paragraph in this.paragraphs)
			{
				foreach (var wordCandidate in unclaimedExcludedWords.ToArray())
				{
					if (paragraph.IsApplicable(wordCandidate))
					{
						paragraph.AddExcludedWord(wordCandidate);
						unclaimedExcludedWords.Remove(wordCandidate);
					}
				}
				paragraph.Close();
			}
		}

		public override string ToString()
		{
			StringBuilder result = new StringBuilder();
			result.AppendLine($"<!-- Page {this.content.PageNumber} -->");
			HashSet<TableContent> usedTables = new HashSet<TableContent>();
			foreach (var paragraph in this.paragraphs)
			{
				if (tableContents.TryGetValue(paragraph, out var tableContent))
				{
					if (!usedTables.Contains(tableContent))
					{
						result.AppendLine(tableContent.ToString());
						usedTables.Add(tableContent);
					}
					continue;
				}
				if (string.IsNullOrWhiteSpace(paragraph.ToString()))
				{
					continue;
				}
				result.AppendLine(paragraph.ToString());
				result.AppendLine();
			}

			return result.ToString().Trim();
		}

		private void ProcessExcludedWords()
		{
			if (this.isClosed)
			{
				throw new InvalidOperationException("The Page is closed to additional changes.");
			}
			foreach (var pageExclusionZone in this.exclusionZones)
			{
				foreach (var exclusionZone in pageExclusionZone.Zones)
				{
					var wordCandidates = content.Words.Where(x =>
						!excludedWords.Any(y => x.Equals(y))
					);
					foreach (var wordCandidate in wordCandidates)
					{
						if (
							wordCandidate?.Paths != null
							&& Clipper
								.Intersect(wordCandidate.Paths, exclusionZone, FillRule.NonZero)
								.Count > 0
						)
						{
							excludedWords.Add(wordCandidate);
						}
					}
				}
			}
		}
	}
}
