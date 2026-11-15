using System.IO.Compression;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.PageSegmenter;
using UglyToad.PdfPig.DocumentLayoutAnalysis.ReadingOrderDetector;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;
using UglyToad.PdfPig.DocumentLayoutAnalysis.WordExtractor;

namespace ReadBridge.Desktop;

internal static partial class DocumentImportService
{
    private const long MaxFileBytes = 30 * 1024 * 1024;
    public static readonly string Filter = "支持的文档|*.txt;*.md;*.log;*.csv;*.html;*.htm;*.docx;*.pdf|文本|*.txt;*.md;*.log;*.csv|Word 文档|*.docx|PDF 文档|*.pdf|网页文件|*.html;*.htm";

    public static Task<string> ReadAsync(string path, CancellationToken token) => Task.Run(() => Read(path, token), token);

    private static string Read(string path, CancellationToken token)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("文件不存在。", path);
        if (info.Length > MaxFileBytes) throw new InvalidOperationException("文件超过 30 MB。请先拆分后再导入。 ");
        var extension = info.Extension.ToLowerInvariant();
        var text = extension switch
        {
            ".txt" or ".md" or ".log" or ".csv" => File.ReadAllText(path),
            ".html" or ".htm" => ReadHtml(path),
            ".docx" => ReadDocx(path, token),
            ".pdf" => ReadPdf(path, token),
            _ => throw new InvalidOperationException("暂不支持此文件类型。支持 TXT、Markdown、HTML、DOCX 和文字型 PDF。")
        };
        text = Normalize(text);
        if (string.IsNullOrWhiteSpace(text))
            throw new InvalidOperationException(extension == ".pdf" ? "没有从 PDF 提取到文字。它可能是扫描件，请使用“框选识字”。" : "文件中没有可读取的文字。");
        return text;
    }

    private static string ReadHtml(string path)
    {
        var html = File.ReadAllText(path);
        html = ScriptAndStyle().Replace(html, " ");
        return WebUtility.HtmlDecode(Tags().Replace(html, "\n"));
    }

    private static string ReadDocx(string path, CancellationToken token)
    {
        using var archive = ZipFile.OpenRead(path);
        var entry = archive.GetEntry("word/document.xml") ?? throw new InvalidOperationException("DOCX 文档结构无效。");
        using var stream = entry.Open();
        var doc = XDocument.Load(stream);
        XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        var paragraphs = doc.Descendants(w + "p").Select(p => string.Concat(p.Descendants(w + "t").Select(t => t.Value)));
        token.ThrowIfCancellationRequested();
        return string.Join("\n", paragraphs);
    }

    private static string ReadPdf(string path, CancellationToken token)
    {
        var builder = new StringBuilder();
        using var document = PdfDocument.Open(path);
        foreach (var page in document.GetPages())
        {
            token.ThrowIfCancellationRequested();
            // 先从字符坐标恢复单词，再按版面块和阅读顺序重建段落。
            // 这比 page.Text 或单纯内容流排序更能保留英文词间空格和多栏结构。
            var words = NearestNeighbourWordExtractor.Instance.GetWords(page.Letters).ToList();
            if (words.Count > 0)
            {
                var blocks = DocstrumBoundingBoxes.Instance.GetBlocks(words);
                var ordered = UnsupervisedReadingOrderDetector.Instance.Get(blocks);
                foreach (var block in ordered)
                {
                    var lines = block.TextLines
                        .Select(line => string.Join(" ", line.Words
                            .Select(word => word.Text.Trim())
                            .Where(text => text.Length > 0)))
                        .Where(line => line.Length > 0)
                        .ToList();
                    if (lines.Count > 0)
                        builder.AppendLine(string.Join(Environment.NewLine, lines)).AppendLine();
                }
            }
            else builder.AppendLine(ContentOrderTextExtractor.GetText(page)).AppendLine();
        }
        return builder.ToString();
    }

    private static string Normalize(string value) => Regex.Replace(value.Replace("\0", ""), @"[ \t]+", " ").Replace("\r\n", "\n").Trim();
    [GeneratedRegex(@"<(script|style)\b[^>]*>[\s\S]*?</\1>", RegexOptions.IgnoreCase)] private static partial Regex ScriptAndStyle();
    [GeneratedRegex(@"<[^>]+>", RegexOptions.IgnoreCase)] private static partial Regex Tags();
}
