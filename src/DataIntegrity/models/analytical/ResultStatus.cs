using System.Runtime.Serialization;
using System.Text.Json.Serialization;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	[JsonConverter(typeof(JsonStringEnumConverter))]
	public enum ResultStatus
	{
		Unknown,

		[EnumMember(Value = "running")]
		Running,

		[EnumMember(Value = "failed")]
		Failed,

		[EnumMember(Value = "succeeded")]
		Succeeded,
	}
}
