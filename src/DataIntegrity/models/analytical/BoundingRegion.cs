namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;

	public record BoundingRegion(int PageNumber, Collection<decimal> Polygon);
}
