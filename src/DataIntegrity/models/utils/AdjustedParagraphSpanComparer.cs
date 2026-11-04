using System;
using System.Collections.Generic;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.utils
{
	public class AdjustedParagraphSpanComparer : IComparer<AdjustedParagraph>
	{
		public int Compare(AdjustedParagraph? x, AdjustedParagraph? y)
		{
			if (x == null)
			{
				throw new ArgumentNullException("x");
			}

			if (y == null)
			{
				throw new ArgumentNullException("y");
			}

			int commonSize = Math.Min(x.Paragraph.Spans.Count, y.Paragraph.Spans.Count);
			if (commonSize > 0)
			{
				for (int i = 0; i < commonSize; i++)
				{
					SpanContent xSpan = x.Paragraph.Spans[i];
					SpanContent ySpan = y.Paragraph.Spans[i];
					var offsetComparison = xSpan.Offset.CompareTo(ySpan.Offset);
					if (offsetComparison == 0)
					{
						var lengthComparison = xSpan.Length.CompareTo(ySpan.Length);
						if (lengthComparison != 0)
						{
							return lengthComparison;
						}
					}
					else
					{
						return offsetComparison;
					}
				}
			}

			return x.Paragraph.Spans.Count.CompareTo(y.Paragraph.Spans.Count);
		}
	}
}
