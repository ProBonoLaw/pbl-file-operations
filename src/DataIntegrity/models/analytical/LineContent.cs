namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record LineContent(string Content, Collection<decimal> Polygon, SpanContent Span)
		: ContentShape(Content, Polygon, Span);
}
