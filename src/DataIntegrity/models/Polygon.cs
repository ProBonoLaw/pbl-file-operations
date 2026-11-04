namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models
{
	using System.Collections.ObjectModel;

	public record struct Polygon(Collection<decimal> Points, MeasurementUnit Unit);
}
