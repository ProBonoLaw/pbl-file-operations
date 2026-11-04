using System.Runtime.Serialization;
using System.Text.Json.Serialization;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models
{
	[JsonConverter(typeof(JsonStringEnumConverter))]
	public enum MeasurementUnit
	{
		None,

		[EnumMember(Value = "inch")]
		Inch,

		[EnumMember(Value = "px")]
		Pixel,

		[EnumMember(Value = "cm")]
		Centimeter,
	}
}
