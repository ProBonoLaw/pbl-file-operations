using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text.Json.Serialization;
using Clipper2Lib;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion
{
	public class PageExclusionZone
	{
		private Collection<PathsD> pointDs;

		[JsonConstructor]
		public PageExclusionZone(
			Collection<Collection<PointD>> points,
			int? startingPage = null,
			int? pageCount = null
		)
		{
			this.Points = points;
			this.StartingPage = startingPage;
			this.PageCount = pageCount;
			this.pointDs = [];
			foreach (var pointCollection in points)
			{
				var pointDs = new PathD();
				foreach (var point in pointCollection)
				{
					pointDs.Add(point);
				}
				this.pointDs.Add(new PathsD { pointDs });
			}
		}

		public Collection<Collection<PointD>> Points { get; init; }
		public int? StartingPage { get; init; }
		public int? PageCount { get; init; }

		[JsonIgnore]
		internal Collection<PathsD> Zones
		{
			get => this.pointDs;
		}

		public bool IsInExclusionZone(IEnumerable<decimal> input)
		{
			var inputPath = new PathsD
			{
				Clipper.MakePath(input.Select(decimal.ToDouble).ToArray()),
			};
			foreach (var zone in this.Zones)
			{
				var result = Clipper.Intersect(inputPath, zone, FillRule.NonZero, 4);
				if (result.Count > 0)
				{
					return true;
				}
			}

			return false;
		}
	}
}
