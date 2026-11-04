namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record WordContent(
		string Content,
		Collection<decimal> Polygon,
		SpanContent Span,
		decimal Confidence
	) : ContentShape(Content, Polygon, Span);
}
