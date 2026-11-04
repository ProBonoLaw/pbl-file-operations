using System.Collections.ObjectModel;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion
{
	public record ExclusionZones(
		Collection<PageExclusionZone>? Pages = null,
		PageExclusionZone? Default = null
	)
	{
		public PageExclusionZone? GetPageExclusionZone(int pageNumber)
		{
			var result = this.Default;
			if (Pages != null)
			{
				foreach (var page in Pages)
				{
					if (
						page.StartingPage == pageNumber
						|| (
							pageNumber > page.StartingPage
							&& pageNumber < page.StartingPage + page.PageCount
						)
					)
					{
						result = page;
						break;
					}
				}
			}

			return result;
		}

		public static bool hasExclusionZones(ExclusionZones? exclusionZones)
		{
			if (exclusionZones != null)
			{
				return (
						exclusionZones.Default != null
						&& exclusionZones.Default.Points != null
						&& exclusionZones.Default.Points.Count > 0
					) || (exclusionZones.Pages != null && exclusionZones.Pages.Count > 0);
			}

			return false;
		}
	}
}
