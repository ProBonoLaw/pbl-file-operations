using System.Collections.ObjectModel;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	public record CaptionContent(
		Collection<SpanContent> Spans,
		Collection<BoundingRegion> BoundingRegions,
		string Content,
		Collection<string> Elements
	);
}
