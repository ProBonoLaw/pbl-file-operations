namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record ParagraphContent(
		Collection<SpanContent> Spans,
		Collection<BoundingRegion> BoundingRegions,
		string Content,
		RoleType? Role = null
	);
}
