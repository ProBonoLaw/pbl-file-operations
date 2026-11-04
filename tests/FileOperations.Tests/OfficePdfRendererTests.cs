using System.Security.Cryptography;
using System.Text.RegularExpressions;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using W = DocumentFormat.OpenXml.Wordprocessing;
using P = DocumentFormat.OpenXml.Presentation;
using A = DocumentFormat.OpenXml.Drawing;
using S = DocumentFormat.OpenXml.Spreadsheet;
using X = DocumentFormat.OpenXml.Drawing.Spreadsheet;
using Xunit;

namespace FileOperations.Tests;

public class OfficePdfRendererTests
{
    [Theory]
    [InlineData("docx")]
    [InlineData("pptx")]
    public async Task RendersTwoPhysicalPagesAndRecordsBothByteHashes(string extension)
    {
        string directory = Path.Combine(Path.GetTempPath(), "office-render-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string input = Path.Combine(directory, "source." + extension), pdf = Path.Combine(directory, "source.pdf");
            OfficeFixtures.Create(input);
            var rendition = await new OfficePdfRenderer().RenderFileAsync(input, pdf, "original." + extension, CancellationToken.None);
            var original = await File.ReadAllBytesAsync(input);
            var rendered = await File.ReadAllBytesAsync(pdf);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(original)), rendition.OriginalSha256);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(rendered)), rendition.PdfSha256);
            Assert.Equal("%PDF-", System.Text.Encoding.ASCII.GetString(rendered[..5]));
            Assert.Equal(2, Regex.Matches(System.Text.Encoding.Latin1.GetString(rendered), @"/Type\s*/Page\b").Count);
            Assert.Contains("LibreOffice", rendition.RendererVersion);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RendersOnlyWorkbooksWithEmbeddedImages(bool withImage)
    {
        using var source = new MemoryStream();
        SpreadsheetFixtures.Create(source, withImage);
        source.Position = 0;
        Assert.Equal(withImage, OfficePdfRenderer.RequiresPdf(source, "records.XLSX"));
    }

    [Fact]
    public async Task WorkbookPdfRetainsImagesOutsidePrintAreaAndOnHiddenSheets()
    {
        string directory = Path.Combine(Path.GetTempPath(), "workbook-render-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string input = Path.Combine(directory, "source.xlsx"), pdf = Path.Combine(directory, "source.pdf");
            using (var source = File.Create(input)) SpreadsheetFixtures.Create(source, true);
            byte[] original = await File.ReadAllBytesAsync(input);
            var rendition = await new OfficePdfRenderer().RenderFileAsync(input, pdf, "photos.xlsx", CancellationToken.None);
            byte[] rendered = await File.ReadAllBytesAsync(pdf);
            Assert.Equal(original, await File.ReadAllBytesAsync(input));
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(original)), rendition.OriginalSha256);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(rendered)), rendition.PdfSha256);
            string structure = System.Text.Encoding.Latin1.GetString(rendered);
            Assert.Equal(2, Regex.Matches(structure, @"/Type\s*/Page\b").Count);
            Assert.Matches(@"/Subtype\s*/Image\b", structure);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}

public static class SpreadsheetFixtures
{
    public static void Create(Stream source, bool withImage, byte[]? imageBytes = null)
    {
        // A PNG fixture is sufficient to check PDF image retention; live OCR uses a text-bearing image.
        imageBytes ??= Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAN0lEQVR4nO3PMQ0AMAzAsPDn3GoYdvSzZAJu6lTtLQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBXw+tvexqvW886wAAAABJRU5ErkJggg==");
        using var document = SpreadsheetDocument.Create(source, SpreadsheetDocumentType.Workbook, true);
        var workbook = document.AddWorkbookPart();
        workbook.Workbook = new S.Workbook(new S.Sheets());
        for (int index = 0; index < 2; index++)
        {
            var worksheet = workbook.AddNewPart<WorksheetPart>();
            worksheet.Worksheet = new S.Worksheet(new S.SheetData(
                new S.Row(new S.Cell(new S.InlineString(new S.Text($"Worksheet {index + 1} records")))
                    { CellReference = "A1", DataType = S.CellValues.InlineString }) { RowIndex = 1 },
                new S.Row(new S.Cell(new S.InlineString(new S.Text("00123")))
                    { CellReference = "A2", DataType = S.CellValues.InlineString }) { RowIndex = 2 }));
            workbook.Workbook.Sheets!.Append(new S.Sheet
            {
                Name = "Sheet" + (index + 1), SheetId = (uint)(index + 1), Id = workbook.GetIdOfPart(worksheet),
                State = index == 0 ? S.SheetStateValues.Visible : S.SheetStateValues.Hidden
            });
            if (withImage)
            {
                var drawing = worksheet.AddNewPart<DrawingsPart>();
                var image = drawing.AddImagePart(ImagePartType.Png);
                using (var bytes = new MemoryStream(imageBytes)) image.FeedData(bytes);
                drawing.WorksheetDrawing = new X.WorksheetDrawing(new X.OneCellAnchor(
                    new X.FromMarker(new X.ColumnId("2"), new X.ColumnOffset("0"), new X.RowId("3"), new X.RowOffset("0")),
                    new X.Extent { Cx = 3657600, Cy = 1828800 },
                    new X.Picture(
                        new X.NonVisualPictureProperties(new X.NonVisualDrawingProperties { Id = 1, Name = "Photo" },
                            new X.NonVisualPictureDrawingProperties()),
                        new X.BlipFill(new A.Blip { Embed = drawing.GetIdOfPart(image) }, new A.Stretch(new A.FillRectangle())),
                        new X.ShapeProperties(new A.Transform2D(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = 3657600, Cy = 1828800 }),
                            new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle })),
                    new X.ClientData { PrintWithSheet = false }));
                drawing.WorksheetDrawing.Save();
                worksheet.Worksheet.Append(new S.Drawing { Id = worksheet.GetIdOfPart(drawing) });
            }
            worksheet.Worksheet.Save();
        }
        workbook.Workbook.Append(new S.DefinedNames(new S.DefinedName("Sheet1!$A$1:$A$2")
            { Name = "_xlnm.Print_Area", LocalSheetId = 0 }));
        workbook.Workbook.Save();
    }
}

public static class OfficeFixtures
{
    public static void Create(string path)
    {
        if (Path.GetExtension(path) == ".docx")
        {
            using var document = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
            var part = document.AddMainDocumentPart();
            part.Document = new W.Document(new W.Body(
                new W.Paragraph(new W.Run(new W.Text("Synthetic source: page one. The blue car stopped at noon."))),
                new W.Paragraph(new W.Run(new W.Break { Type = W.BreakValues.Page }, new W.Text("Synthetic source: page two. No private case data.")))));
            part.Document.Save();
        }
        else
        {
            using var document = PresentationDocument.Create(path, PresentationDocumentType.Presentation);
            var part = document.AddPresentationPart();
            part.Presentation = new P.Presentation(new P.SlideIdList(),
                new P.SlideSize { Cx = 9144000, Cy = 6858000 }, new P.NotesSize { Cx = 6858000, Cy = 9144000 });
            for (int index = 1; index <= 2; index++)
            {
                var slide = part.AddNewPart<SlidePart>();
                slide.Slide = new P.Slide(new P.CommonSlideData(new P.ShapeTree(
                    new P.NonVisualGroupShapeProperties(new P.NonVisualDrawingProperties { Id = 1, Name = "" },
                        new P.NonVisualGroupShapeDrawingProperties(), new P.ApplicationNonVisualDrawingProperties()),
                    new P.GroupShapeProperties(new A.TransformGroup(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = 0, Cy = 0 },
                        new A.ChildOffset { X = 0, Y = 0 }, new A.ChildExtents { Cx = 0, Cy = 0 })),
                    new P.Shape(new P.NonVisualShapeProperties(new P.NonVisualDrawingProperties { Id = 2, Name = "Title" },
                        new P.NonVisualShapeDrawingProperties { TextBox = true }, new P.ApplicationNonVisualDrawingProperties()),
                        new P.ShapeProperties(new A.Transform2D(new A.Offset { X = 914400, Y = 914400 }, new A.Extents { Cx = 7315200, Cy = 1828800 }),
                            new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle }),
                        new P.TextBody(new A.BodyProperties(), new A.ListStyle(), new A.Paragraph(new A.Run(
                            new A.RunProperties { Language = "en-US", FontSize = 2400 }, new A.Text($"Synthetic slide {index}. No private case data."))))))));
                slide.Slide.Save();
                part.Presentation.SlideIdList!.Append(new P.SlideId { Id = (uint)(255 + index), RelationshipId = part.GetIdOfPart(slide) });
            }
            part.Presentation.Save();
        }
    }
}
