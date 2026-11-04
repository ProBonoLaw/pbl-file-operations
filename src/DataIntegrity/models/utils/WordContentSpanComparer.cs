using System;
using System.Collections.Generic;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.utils
{
	public class WordContentSpanComparer : IComparer<WordContent>
	{
		public int Compare(WordContent? x, WordContent? y)
		{
			if (x == null)
			{
				throw new ArgumentNullException("x");
			}

			if (y == null)
			{
				throw new ArgumentNullException("y");
			}

			var offsetComparison = x.Span.Offset.CompareTo(y.Span.Offset);
			if (offsetComparison == 0)
			{
				return x.Span.Length.CompareTo(y.Span.Length);
			}

			return offsetComparison;
		}
	}
}
