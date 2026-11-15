using System.Text.RegularExpressions;

namespace ReadBridge.Desktop;

internal static partial class LanguageDetector
{
    public static string Detect(string text)
    {
        var chinese = Chinese().Matches(text).Count;
        var latin = Latin().Matches(text).Count;
        return chinese > 0 && chinese * 2 >= latin ? "zh-CN" : "en-US";
    }

    public static string DisplayName(string language) => language == "zh-CN" ? "中文" : "English";

    [GeneratedRegex("[\\u3400-\\u9fff]")]
    private static partial Regex Chinese();
    [GeneratedRegex("[A-Za-z]")]
    private static partial Regex Latin();
}
