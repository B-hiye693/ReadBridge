using System.Net.Http.Json;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ReadBridge.Desktop;

internal sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    public ApiClient(string baseUrl) => _http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(60) };
    public async Task<bool> IsOnlineAsync(CancellationToken token)
    {
        try { using var r = await _http.GetAsync("health", token); return r.IsSuccessStatusCode; } catch { return false; }
    }
    public async Task<ExplainDocument> ExplainAsync(string text, string outputLanguage, CancellationToken token)
    {
        if (text.Length > 10_000) text = text[..10_000];
        using var response = await _http.PostAsJsonAsync("api/explain", new { text, output_language = outputLanguage, generation_mode = "fast" }, token);
        var envelope = await ReadAsync<ExplainData>(response, token);
        var d = envelope.Data!;
        if (outputLanguage == "en-US" && IsMostlyChinese(string.Join(" ", new[] { d.Simple, d.Example }.Concat(d.Keywords.SelectMany(k => new[] { k.Word, k.Explanation })))))
            throw new InvalidOperationException("后端返回的解释仍是中文，未满足 Output: English。请关闭旧后端窗口，再从“一键启动阅桥”重新启动。");
        var b = new StringBuilder(d.Simple);
        if (d.Keywords.Count > 0) { b.AppendLine().AppendLine().AppendLine("关键词"); foreach (var k in d.Keywords) b.AppendLine($"• {k.Word}：{k.Explanation}"); }
        if (!string.IsNullOrWhiteSpace(d.Example)) b.AppendLine().AppendLine("例子").Append(d.Example);
        var document = new ExplainDocument
        {
            Title = text.Length <= 42 ? $"“{text}”" : "所选内容",
            Summary = d.Simple,
            PlainText = b.ToString()
        };
        document.Cards.AddRange(d.Keywords.Select(k => new ResultCard
        {
            Icon = "📖", Heading = k.Word, Content = k.Explanation, SourceText = text, Kind = "word"
        }));
        if (!string.IsNullOrWhiteSpace(d.Example)) document.Cards.Add(new ResultCard
        {
            Icon = "💡", Heading = "帮助理解的例子", Content = d.Example, SourceText = text, Kind = "example"
        });
        return document;
    }
    public async Task<EasyReadDocument> EasyReadAsync(string text, string source, string outputLanguage, IProgress<string>? progress, CancellationToken token)
    {
        // Qwen Provider 会在单次输入预算外做抽样。桌面全文必须预先按自然边界分块，
        // 确保每个字符都进入某一次请求，而不是只保留开头、中间和结尾。
        var chunks = SplitText(text, 12_000);
        var document = new EasyReadDocument { Title = source, PartCount = chunks.Count };
        var output = new StringBuilder();
        var completed = 0;
        using var concurrency = new SemaphoreSlim(Math.Min(3, chunks.Count));
        async Task<(int Index, EasyReadData Data)> ProcessChunkAsync(int index)
        {
            await concurrency.WaitAsync(token);
            try
            {
                token.ThrowIfCancellationRequested();
                var partTitle = chunks.Count == 1 ? source : $"{source}（第 {index + 1}/{chunks.Count} 部分）";
                using var response = await _http.PostAsJsonAsync("api/easy-read", new { text = chunks[index], title = partTitle, url = "", content_blocks = Array.Empty<object>(), strategy = "desktop-document-parallel-v2-fast", truncated = false, output_language = outputLanguage, generation_mode = "fast" }, token);
                var data = (await ReadAsync<EasyReadData>(response, token)).Data!;
                ValidateOutputLanguage(data, outputLanguage);
                var done = Interlocked.Increment(ref completed);
                progress?.Report(chunks.Count == 1 ? "正在生成易读版本…" : $"全文并行处理中：已完成 {done}/{chunks.Count} 部分");
                return (index, data);
            }
            finally { concurrency.Release(); }
        }
        progress?.Report(chunks.Count == 1 ? "正在生成易读版本…" : $"正在并行处理全文，共 {chunks.Count} 部分…");
        var parts = (await Task.WhenAll(Enumerable.Range(0, chunks.Count).Select(ProcessChunkAsync))).OrderBy(item => item.Index);
        foreach (var part in parts)
        {
            var index = part.Index;
            var d = part.Data;
            if (output.Length > 0) output.AppendLine().AppendLine("──────────").AppendLine();
            output.Append(FormatEasyRead(d));
            if (!string.IsNullOrWhiteSpace(d.OneSentence))
            {
                if (document.Summary.Length > 0) document.Summary += "\n";
                document.Summary += chunks.Count == 1 ? d.OneSentence : $"第 {index + 1} 部分：{d.OneSentence}";
            }
            document.Cards.AddRange(d.Sections.Select(s => new ResultCard { Icon = s.Icon, Heading = s.Heading, Content = s.Content, SourceText = s.SourceText, Kind = "section" }));
            if (d.KeyPoints.Count > 0) document.Cards.Add(new ResultCard { Icon = "📌", Heading = "重点信息", Content = string.Join("\n", d.KeyPoints.Select(p => $"• {p.Label}：{p.Value}")), SourceText = string.Join("\n", d.KeyPoints.Select(p => p.SourceText).Where(s => !string.IsNullOrWhiteSpace(s))), Kind = "key" });
            foreach (var word in d.DifficultWords) document.Cards.Add(new ResultCard { Icon = "📖", Heading = word.Word, Content = "简单解释：" + word.Simple, SourceText = word.SourceText, Kind = "word" });
            if (d.Action.Needed) document.Cards.Add(new ResultCard { Icon = "✅", Heading = d.Action.Title, Content = string.Join("\n", d.Action.Steps.Select((s, i) => $"{i + 1}. {s}")), SourceText = d.Action.SourceText, Kind = "action" });
        }
        document.PlainText = output.ToString().Trim();
        return document;
    }
    private static string FormatEasyRead(EasyReadData d)
    {
        var b = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(d.Title)) b.AppendLine(d.Title);
        b.AppendLine(d.OneSentence);
        foreach (var s in d.Sections) b.AppendLine().AppendLine(s.Heading).AppendLine(s.Content);
        if (d.KeyPoints.Count > 0) { b.AppendLine().AppendLine("重点"); foreach (var p in d.KeyPoints) b.AppendLine($"• {p.Label}：{p.Value}"); }
        if (d.DifficultWords.Count > 0) { b.AppendLine().AppendLine("难词"); foreach (var w in d.DifficultWords) b.AppendLine($"• {w.Word}：{w.Simple}"); }
        if (d.Action.Needed) { b.AppendLine().AppendLine(d.Action.Title); for (var i = 0; i < d.Action.Steps.Count; i++) b.AppendLine($"{i + 1}. {d.Action.Steps[i]}"); }
        return b.ToString().Trim();
    }
    private static void ValidateOutputLanguage(EasyReadData data, string requested)
    {
        if (requested != "en-US") return;
        var visible = string.Join(" ", new[] { data.Title, data.OneSentence }
            .Concat(data.Sections.SelectMany(s => new[] { s.Heading, s.Content }))
            .Concat(data.KeyPoints.SelectMany(p => new[] { p.Label, p.Value }))
            .Concat(data.DifficultWords.SelectMany(w => new[] { w.Word, w.Simple }))
            .Concat(data.Action.Steps));
        if (IsMostlyChinese(visible))
            throw new InvalidOperationException("后端返回的仍是中文，未满足 Output: English。当前运行的后端可能是旧版本，请关闭旧后端窗口，再从“一键启动阅桥”重新启动；阅桥不会把这次错误结果显示出来。");
    }
    private static bool IsMostlyChinese(string value)
    {
        var chinese = Regex.Matches(value, "[\\u3400-\\u9fff]").Count;
        var latin = Regex.Matches(value, "[A-Za-z]").Count;
        return chinese > Math.Max(2, latin / 5);
    }
    public async Task<VoicesResponse> GetVoicesAsync(CancellationToken token)
    {
        using var response = await _http.GetAsync("api/tts/voices", token);
        if (!response.IsSuccessStatusCode) await ThrowApiAsync(response, token);
        return JsonSerializer.Deserialize<VoicesResponse>(await response.Content.ReadAsStringAsync(token), JsonOptions) ?? new();
    }
    public async Task<(byte[] Audio, string MediaType)> SpeechAsync(string text, string language, string voice, double rate, CancellationToken token)
    {
        if (text.Length > 600) text = text[..600];
        using var response = await _http.PostAsJsonAsync("api/tts", new { text, language, voice, rate, style = "warm" }, token);
        if (!response.IsSuccessStatusCode) await ThrowApiAsync(response, token);
        return (await response.Content.ReadAsByteArrayAsync(token), response.Content.Headers.ContentType?.MediaType ?? "audio/mpeg");
    }
    private static List<string> SplitText(string text, int limit)
    {
        if (text.Length <= limit) return [text];
        var result = new List<string>();
        var remaining = text;
        while (remaining.Length > limit)
        {
            var cut = remaining.LastIndexOf('\n', limit, limit);
            if (cut < limit / 2) cut = remaining.LastIndexOfAny(['。', '.', '!', '?'], limit - 1, limit);
            if (cut < limit / 2) cut = limit;
            result.Add(remaining[..cut].Trim());
            remaining = remaining[cut..].TrimStart();
        }
        if (remaining.Length > 0) result.Add(remaining);
        return result;
    }
    private static async Task<ApiEnvelope<T>> ReadAsync<T>(HttpResponseMessage response, CancellationToken token)
    {
        var json = await response.Content.ReadAsStringAsync(token);
        var data = JsonSerializer.Deserialize<ApiEnvelope<T>>(json, JsonOptions);
        if (!response.IsSuccessStatusCode || data?.Success != true || data.Data is null)
            throw new InvalidOperationException(data?.Error?.Message + (string.IsNullOrWhiteSpace(data?.Error?.RequestId) ? "" : $"（request_id: {data.Error.RequestId}）"));
        return data;
    }
    private static async Task ThrowApiAsync(HttpResponseMessage response, CancellationToken token)
    {
        var json = await response.Content.ReadAsStringAsync(token);
        try { var e = JsonSerializer.Deserialize<ApiEnvelope<object>>(json, JsonOptions); throw new InvalidOperationException(e?.Error?.Message ?? $"服务返回 {response.StatusCode}"); }
        catch (JsonException) { throw new InvalidOperationException($"服务返回 {response.StatusCode}"); }
    }
    public void Dispose() => _http.Dispose();
}
