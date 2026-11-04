using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using Clipper2Lib;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.utils;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models
{
	public class AdjustedParagraph
	{
		private static readonly WordContentSpanComparer wordContentComparer =
			new WordContentSpanComparer();
		private PathsD paragraphPaths;
		private bool isClosed;
		private string? content;
		public ParagraphContent Paragraph { get; init; }
		public Collection<WordContent> Exclusions { get; private set; }
		public SortedSet<WordContent> CompositionTokens { get; private set; }
		public Collection<SectionContent> Sections { get; private set; }

		public AdjustedParagraph(ParagraphContent paragraph)
		{
			this.Paragraph = paragraph;
			this.Exclusions = new Collection<WordContent>();
			this.CompositionTokens = new SortedSet<WordContent>(wordContentComparer);
			this.Sections = new Collection<SectionContent>();
			this.paragraphPaths = new PathsD();
			this.isClosed = false;
			foreach (BoundingRegion boundingRegion in paragraph.BoundingRegions)
			{
				var path = Clipper.MakePath(
					boundingRegion.Polygon.Select(static p => decimal.ToDouble(p)).ToArray()
				);
				paragraphPaths.Add(path);
			}
		}

		public bool IsApplicable(WordContent candidateWord)
		{
			if (candidateWord == null)
			{
				throw new ArgumentNullException(nameof(candidateWord));
			}
			bool isApplicable = false;
			var candidateStartPosition = candidateWord.Span.Offset;
			var candidateEndPosition = candidateStartPosition + candidateWord.Span.Length - 1;
			foreach (var span in this.Paragraph.Spans)
			{
				var positionStart = span.Offset;
				var positionEnd = positionStart + span.Length - 1;
				if (candidateStartPosition >= positionStart && positionEnd >= candidateEndPosition)
				{
					isApplicable = true;
					break;
				}
			}
			if (!isApplicable)
			{
				return false;
			}
			else if (candidateWord.Polygon == null)
			{
				return true;
			}

			var candidate = new PathsD
			{
				Clipper.MakePath(
					candidateWord.Polygon.Select(static p => decimal.ToDouble(p)).ToArray()
				),
			};
			var result = Clipper.Intersect(paragraphPaths, candidate, FillRule.NonZero);
			if (result.Count > 0)
			{
				this.CompositionTokens.Add(candidateWord);
				return true;
			}
			return false;
		}

		public bool IsApplicable(TableContent candidateTable)
		{
			if (candidateTable == null)
			{
				throw new ArgumentNullException(nameof(candidateTable));
			}
			bool isApplicable = false;
			foreach (var spanCandidate in candidateTable.Spans)
			{
				var candidateStartPosition = spanCandidate.Offset;
				var candidateEndPosition = candidateStartPosition + spanCandidate.Length - 1;
				foreach (var span in this.Paragraph.Spans)
				{
					var positionStart = span.Offset;
					var positionEnd = positionStart + span.Length - 1;
					if (
						candidateStartPosition <= positionStart
						&& positionEnd <= candidateEndPosition
					)
					{
						foreach (var wordCandidate in this.CompositionTokens.ToList())
						{
							if (
								wordCandidate.Span.Offset >= candidateStartPosition
								&& wordCandidate.Span.Length + wordCandidate.Span.Offset
									<= candidateEndPosition
							)
							{
								this.CompositionTokens.Remove(wordCandidate);
								if (this.Exclusions.IndexOf(wordCandidate) == -1)
								{
									this.Exclusions.Add(wordCandidate);
								}

								isApplicable = true;
							}
						}
					}
				}
			}
			return isApplicable;
		}

		public bool IsApplicable(SectionContent sectionContent)
		{
			if (sectionContent == null)
			{
				throw new ArgumentNullException(nameof(sectionContent));
			}

			bool isApplicable = false;

			foreach (var spanCandidate in sectionContent.Spans)
			{
				var candidateStartPosition = spanCandidate.Offset;
				var candidateEndPosition = candidateStartPosition + spanCandidate.Length - 1;
				foreach (var span in this.Paragraph.Spans)
				{
					var positionStart = span.Offset;
					var positionEnd = positionStart + span.Length - 1;
					if (
						candidateStartPosition <= positionStart
						&& positionEnd <= candidateEndPosition
					)
					{
						this.Sections.Add(sectionContent);
						isApplicable = true;
						break;
					}
				}
			}

			return isApplicable;
		}

		public void AddExcludedWord(WordContent candidateWord)
		{
			if (IsApplicable(candidateWord))
			{
				this.CompositionTokens.Remove(candidateWord);
				if (this.Exclusions.IndexOf(candidateWord) == -1)
				{
					this.Exclusions.Add(candidateWord);
				}
			}
		}

		public bool Close()
		{
			if (!this.isClosed)
			{
				this.isClosed = true;
				StringBuilder result = new StringBuilder(this.Paragraph.Content);
				foreach (var excludedWord in this.Exclusions.OrderByDescending(x => x.Span.Offset))
				{
					int startOffset = 0;
					SpanContent excludedSpan = excludedWord.Span;
					foreach (var paragraphSpan in Paragraph.Spans)
					{
						if (
							excludedSpan.Offset >= paragraphSpan.Offset
							&& excludedSpan.Offset + excludedSpan.Length
								<= paragraphSpan.Offset + paragraphSpan.Length
						)
						{
							var length = excludedSpan.Length;
							if (
								excludedSpan.Offset + excludedSpan.Length
								< paragraphSpan.Offset + paragraphSpan.Length
							)
							{
								length++;
								result.Remove(
									excludedSpan.Offset - paragraphSpan.Offset + startOffset,
									excludedSpan.Length + 1
								);
								result.Insert(
									excludedSpan.Offset - paragraphSpan.Offset + startOffset,
									'\n'
								);
							}
							else
							{
								result.Remove(
									excludedSpan.Offset - paragraphSpan.Offset + startOffset,
									excludedSpan.Length
								);
							}
							break;
						}
						startOffset += paragraphSpan.Length;
					}
				}

				if (
					this.Paragraph.Role == RoleType.SectionHeading
					|| this.Paragraph.Role == RoleType.Title
				)
				{
					while (
						result.Length > 0
						&& (result[0] == '\n' || result[0] == '\r' || result[0] == '\t')
					)
					{
						result.Remove(0, 1);
					}

					result.Insert(0, ' ');
					for (int i = this.Sections.Count; i > 0; i--)
					{
						result.Insert(0, '#');
					}
				}

				this.content = result.ToString().Trim();
			}

			return this.isClosed;
		}

		public override string ToString()
		{
			if (string.IsNullOrWhiteSpace(this.Paragraph.Content))
			{
				return string.Empty;
			}

			if (this.isClosed && this.content != null)
			{
				return this.content.Length == 1 && !char.IsLetterOrDigit(this.Paragraph.Content[0])
					? string.Empty
					: this.content;
			}

			StringBuilder result = new StringBuilder();
			if (this.Paragraph.Role == RoleType.SectionHeading)
			{
				for (int i = this.Sections.Count; i > 0; i--)
				{
					result.Append('#');
				}
			}

			result.AppendJoin(' ', this.CompositionTokens.Select(x => x.Content));
			result.AppendLine();
			return result.ToString();
		}
	}
}
