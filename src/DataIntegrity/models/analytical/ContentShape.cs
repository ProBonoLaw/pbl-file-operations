namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Collections.ObjectModel;
	using System.Linq;
	using Clipper2Lib;

	public record ContentShape(string Content, Collection<decimal>? Polygon, SpanContent Span)
	{
		private PathsD? pointDs =
			Polygon != null
				? new PathsD
				{
					Clipper.MakePath(Polygon.Select(static p => decimal.ToDouble(p)).ToArray()),
				}
				: null;
		public PathsD? Paths
		{
			get => this.pointDs;
		}
	}
}
