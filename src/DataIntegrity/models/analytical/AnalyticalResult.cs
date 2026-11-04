namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record AnalyticalResult(
		string Content,
		Collection<PageContent> Pages,
		Collection<ParagraphContent> Paragraphs,
		Collection<TableContent> Tables,
		Collection<SectionContent> Sections
	);
}
