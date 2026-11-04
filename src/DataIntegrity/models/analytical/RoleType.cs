namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	using System.Runtime.Serialization;
	using System.Text.Json.Serialization;

	[JsonConverter(typeof(JsonStringEnumConverter))]
	public enum RoleType
	{
		None,

		[EnumMember(Value = "sectionHeading")]
		SectionHeading,

		[EnumMember(Value = "pageFooter")]
		PageFooter,

		[EnumMember(Value = "title")]
		Title,

		[EnumMember(Value = "footnote")]
		Footnote,

		[EnumMember(Value = "formulaBlock")]
		FormulaBlock,

		[EnumMember(Value = "pageHeader")]
		PageHeader,

		[EnumMember(Value = "pageNumber")]
		PageNumber,
	}
}
