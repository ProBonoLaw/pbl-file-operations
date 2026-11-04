namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record SectionContent(Collection<SpanContent> Spans, Collection<string> Elements);
}
