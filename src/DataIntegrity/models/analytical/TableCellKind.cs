using System.Runtime.Serialization;
using System.Text.Json.Serialization;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	[JsonConverter(typeof(JsonStringEnumConverter))]
	public enum TableCellKind
	{
		[EnumMember(Value = "columnHeader")]
		ColumnHeader,

		[EnumMember(Value = "content")]
		Content,

		[EnumMember(Value = "description")]
		Description,

		[EnumMember(Value = "rowHeader")]
		RowHeader,

		[EnumMember(Value = "stubHead")]
		StubHead,
	}
}
