namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public class PageContent
	{
		public int PageNumber { get; set; }

		public decimal Angle { get; set; }

		public decimal Width { get; set; }
		public decimal Height { get; set; }
		public MeasurementUnit Unit { get; set; }
		public required Collection<WordContent> Words { get; set; }
		public required Collection<LineContent> Lines { get; set; }
		public required Collection<SpanContent> Spans { get; set; }
	}
}
