using System.Text.Json.Serialization;

namespace ReadBridge.Desktop;

public sealed class AppSettings
{
    public string ApiBaseUrl { get; set; } = "http://127.0.0.1:8000";
    public uint HotkeyModifiers { get; set; } = NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT;
    public int HotkeyKey { get; set; } = 0x52;
    public bool AlwaysOnTop { get; set; } = true;
    public string OcrLanguageMode { get; set; } = "auto";
    public string OutputLanguage { get; set; } = "auto";
    public string VoiceId { get; set; } = "";
    public double VoiceRate { get; set; } = 0.9;
    [JsonIgnore] public string HotkeyText => $"{((HotkeyModifiers & NativeMethods.MOD_CONTROL) != 0 ? "Ctrl+" : "")}{((HotkeyModifiers & NativeMethods.MOD_ALT) != 0 ? "Alt+" : "")}{((HotkeyModifiers & NativeMethods.MOD_SHIFT) != 0 ? "Shift+" : "")}{(char)HotkeyKey}";
}

public sealed record CaptureResult(bool Success, string Text, string Source, string Message)
{
    public static CaptureResult Fail(string message) => new(false, "", "", message);
}

public sealed class ApiEnvelope<T> { [JsonPropertyName("success")] public bool Success { get; set; } [JsonPropertyName("data")] public T? Data { get; set; } [JsonPropertyName("error")] public ApiError? Error { get; set; } }
public sealed class ApiError { [JsonPropertyName("message")] public string Message { get; set; } = "请求失败"; [JsonPropertyName("request_id")] public string RequestId { get; set; } = ""; }
public sealed class ExplainData { [JsonPropertyName("simple")] public string Simple { get; set; } = ""; [JsonPropertyName("keywords")] public List<Keyword> Keywords { get; set; } = []; [JsonPropertyName("example")] public string Example { get; set; } = ""; }
public sealed class ExplainDocument
{
    public string Title { get; set; } = "简单解释";
    public string Summary { get; set; } = "";
    public List<ResultCard> Cards { get; set; } = [];
    public string PlainText { get; set; } = "";
}
public sealed class Keyword { [JsonPropertyName("word")] public string Word { get; set; } = ""; [JsonPropertyName("explanation")] public string Explanation { get; set; } = ""; }
public sealed class EasyReadData { [JsonPropertyName("title")] public string Title { get; set; } = ""; [JsonPropertyName("one_sentence")] public string OneSentence { get; set; } = ""; [JsonPropertyName("sections")] public List<EasySection> Sections { get; set; } = []; [JsonPropertyName("key_points")] public List<KeyPoint> KeyPoints { get; set; } = []; [JsonPropertyName("difficult_words")] public List<DifficultWord> DifficultWords { get; set; } = []; [JsonPropertyName("action")] public ActionData Action { get; set; } = new(); }
public sealed class EasySection { [JsonPropertyName("icon")] public string Icon { get; set; } = "📌"; [JsonPropertyName("heading")] public string Heading { get; set; } = ""; [JsonPropertyName("content")] public string Content { get; set; } = ""; [JsonPropertyName("source_text")] public string SourceText { get; set; } = ""; }
public sealed class KeyPoint { [JsonPropertyName("label")] public string Label { get; set; } = ""; [JsonPropertyName("value")] public string Value { get; set; } = ""; [JsonPropertyName("source_text")] public string SourceText { get; set; } = ""; }
public sealed class DifficultWord { [JsonPropertyName("word")] public string Word { get; set; } = ""; [JsonPropertyName("simple")] public string Simple { get; set; } = ""; [JsonPropertyName("source_text")] public string SourceText { get; set; } = ""; }
public sealed class ActionData { [JsonPropertyName("needed")] public bool Needed { get; set; } [JsonPropertyName("title")] public string Title { get; set; } = ""; [JsonPropertyName("steps")] public List<string> Steps { get; set; } = []; [JsonPropertyName("source_text")] public string SourceText { get; set; } = ""; }
public sealed class EasyReadDocument
{
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public List<ResultCard> Cards { get; set; } = [];
    public string PlainText { get; set; } = "";
    public int PartCount { get; set; }
}
public sealed class SavedExplanation
{
    public string Text { get; set; } = "";
    public string OutputLanguage { get; set; } = "auto";
    public string Result { get; set; } = "";
    public ExplainDocument? Document { get; set; }
    public DateTime SavedAt { get; set; }
}
public sealed class LibraryAnalysis
{
    public Dictionary<string, EasyReadDocument> EasyReadResults { get; set; } = [];
    public List<SavedExplanation> Explanations { get; set; } = [];
    public string LastResultKind { get; set; } = "";
    public string LastResultKey { get; set; } = "";
}
public sealed class ResultCard
{
    public string Icon { get; set; } = "📌";
    public string Heading { get; set; } = "";
    public string Content { get; set; } = "";
    public string SourceText { get; set; } = "";
    public string Kind { get; set; } = "section";
    [JsonIgnore] public bool HasSource => !string.IsNullOrWhiteSpace(SourceText);
}
public sealed class VoiceInfo { [JsonPropertyName("id")] public string Id { get; set; } = ""; [JsonPropertyName("name")] public string Name { get; set; } = ""; [JsonPropertyName("language")] public string Language { get; set; } = "zh-CN"; public override string ToString() => $"{Name} · {Language}"; }
public sealed class VoicesResponse { [JsonPropertyName("default_voice")] public string DefaultVoice { get; set; } = ""; [JsonPropertyName("voices")] public List<VoiceInfo> Voices { get; set; } = []; }
