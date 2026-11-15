using System.Drawing;
using System.Drawing.Imaging;
using System.Windows;
using System.Windows.Input;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;
using System.IO;
using System.Windows.Controls;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows.Interop;

namespace ReadBridge.Desktop;

public partial class RegionOverlay : Window
{
    private NativeMethods.POINT _start;
    private bool _drawing;
    private bool _completed;
    private readonly string _languageMode;
    private readonly TaskCompletionSource<CaptureResult> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public CaptureResult Result { get; private set; } = CaptureResult.Fail("已取消框选识字。");
    public Task<CaptureResult> Completion => _completion.Task;
    public event EventHandler? RecognitionStarted;
    public RegionOverlay(string languageMode)
    {
        InitializeComponent(); _languageMode = languageMode;
        var bounds = System.Windows.Forms.SystemInformation.VirtualScreen;
        Left = bounds.Left; Top = bounds.Top; Width = bounds.Width; Height = bounds.Height;
        SourceInitialized += (_, _) => NativeMethods.SetWindowPos(new WindowInteropHelper(this).Handle, new IntPtr(-1), bounds.Left, bounds.Top, bounds.Width, bounds.Height, 0x0040);
        Loaded += (_, _) => { Activate(); Focus(); };
        Closed += (_, _) => Complete(CaptureResult.Fail("已取消框选识字。"), closeWindow: false);
    }
    private void OnDown(object sender, MouseButtonEventArgs e) { NativeMethods.GetCursorPos(out _start); _drawing = true; Selection.Visibility = Visibility.Visible; CaptureMouse(); }
    private void OnMove(object sender, System.Windows.Input.MouseEventArgs e) { if (!_drawing) return; NativeMethods.GetCursorPos(out var point); Draw(point); }
    private async void OnUp(object sender, MouseButtonEventArgs e)
    {
        if (!_drawing) return; _drawing = false; ReleaseMouseCapture(); NativeMethods.GetCursorPos(out var end); Draw(end);
        var x = Math.Min(_start.X, end.X); var y = Math.Min(_start.Y, end.Y);
        var w = Math.Abs(end.X - _start.X); var h = Math.Abs(end.Y - _start.Y);
        if (w < 4 || h < 4) { Complete(CaptureResult.Fail("框选区域太小，未进行识别。")); return; }
        Hide();
        await Task.Delay(100);
        byte[] png;
        try { png = CapturePng(new System.Drawing.Rectangle(x, y, w, h)); }
        catch (Exception ex) { Complete(CaptureResult.Fail("无法截取所选区域：" + ex.Message)); return; }
        RecognitionStarted?.Invoke(this, EventArgs.Empty);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try { Complete(await RecognizeAsync(png, _languageMode, timeout.Token)); }
        catch (OperationCanceledException) { Complete(CaptureResult.Fail("OCR 在 20 秒内没有完成，请缩小框选区域或检查 Windows OCR 语言包。")); }
        catch (Exception ex) { Complete(CaptureResult.Fail("OCR 无法完成：" + ex.Message)); }
    }
    private void Draw(NativeMethods.POINT physical) { var a = PointFromScreen(new System.Windows.Point(_start.X, _start.Y)); var p = PointFromScreen(new System.Windows.Point(physical.X, physical.Y)); Canvas.SetLeft(Selection, Math.Min(a.X, p.X)); Canvas.SetTop(Selection, Math.Min(a.Y, p.Y)); Selection.Width = Math.Abs(p.X - a.X); Selection.Height = Math.Abs(p.Y - a.Y); }
    private void OnKeyDown(object sender, System.Windows.Input.KeyEventArgs e) { if (e.Key == Key.Escape) Complete(CaptureResult.Fail("已取消框选识字。")); }
    private void Complete(CaptureResult result, bool closeWindow = true)
    {
        if (_completed) return;
        _completed = true; Result = result; _completion.TrySetResult(result);
        if (closeWindow) Close();
    }
    private static byte[] CapturePng(System.Drawing.Rectangle rect)
    {
        using var bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(rect.Location, System.Drawing.Point.Empty, rect.Size, CopyPixelOperation.SourceCopy);
        using var ms = new MemoryStream(); bitmap.Save(ms, ImageFormat.Png); return ms.ToArray();
    }
    private static Task<CaptureResult> RecognizeAsync(byte[] png, string languageMode, CancellationToken token) => Task.Run(async () =>
    {
        token.ThrowIfCancellationRequested();
        using var stream = new InMemoryRandomAccessStream();
        using (var output = stream.GetOutputStreamAt(0)) { await output.WriteAsync(png.AsBuffer()).AsTask(token); await output.FlushAsync().AsTask(token); }
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream).AsTask(token);
        var longest = Math.Max(decoder.PixelWidth, decoder.PixelHeight);
        var scale = longest > OcrEngine.MaxImageDimension ? (double)OcrEngine.MaxImageDimension / longest : 1d;
        var transform = new BitmapTransform { ScaledWidth = Math.Max(1, (uint)Math.Round(decoder.PixelWidth * scale)), ScaledHeight = Math.Max(1, (uint)Math.Round(decoder.PixelHeight * scale)) };
        using var software = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform, ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage).AsTask(token);
        var englishLanguage = new Language("en-US"); var chineseLanguage = new Language("zh-Hans-CN");
        var englishSupported = OcrEngine.IsLanguageSupported(englishLanguage); var chineseSupported = OcrEngine.IsLanguageSupported(chineseLanguage);
        if (languageMode == "zh-Hans-CN" && !chineseSupported)
            return CaptureResult.Fail("尚未安装 Windows 简体中文 OCR。请在 Windows 设置 → 时间和语言 → 语言和区域中安装简体中文语言功能。");
        var requested = languageMode == "auto" ? new[] { "en-US", "zh-Hans-CN" } : new[] { languageMode };
        var candidates = new List<(string Language, string Text)>();
        if (languageMode is "auto" or "en-US")
        {
            try
            {
                var offlineEnglish = OfflineEnglishOcr.Recognize(png);
                if (!string.IsNullOrWhiteSpace(offlineEnglish)) candidates.Add(("en-US", offlineEnglish));
            }
            catch (Exception ex) when (languageMode == "auto") { CrashLogger.Write("OfflineEnglishOcr", ex); }
            catch (Exception ex) { CrashLogger.Write("OfflineEnglishOcr", ex); return CaptureResult.Fail("离线英语 OCR 无法启动：" + CrashLogger.Describe(ex)); }
        }
        foreach (var tag in requested)
        {
            if (tag == "en-US" && candidates.Any(x => x.Language == "en-US")) continue;
            var language = new Language(tag);
            if (!OcrEngine.IsLanguageSupported(language)) continue;
            var engine = OcrEngine.TryCreateFromLanguage(language);
            if (engine is null) continue;
            var recognized = await engine.RecognizeAsync(software).AsTask(token);
            var value = recognized.Text?.Trim() ?? "";
            if (value.Length > 0) candidates.Add((tag, value));
        }
        if (candidates.Count == 0) return CaptureResult.Fail("没有可用的 OCR 结果。请安装对应的 Windows OCR 语言包，并在阅桥设置中选择该语言。");
        var best = languageMode == "auto" ? SelectAutoCandidate(candidates) : candidates[0];
        var label = best.Language == "en-US" ? "English" : "中文";
        return new(true, best.Text, $"屏幕框选 OCR（{label}，仅当前可见区域）", $"OCR 完成，自动选择：{label}；截图未保存或上传");
    }, token);

    private static (string Language, string Text) SelectAutoCandidate(List<(string Language, string Text)> candidates)
    {
        var english = candidates.FirstOrDefault(x => x.Language == "en-US");
        var chinese = candidates.FirstOrDefault(x => x.Language == "zh-Hans-CN");
        if (string.IsNullOrEmpty(english.Text)) return chinese;
        if (string.IsNullOrEmpty(chinese.Text)) return english;
        static (int Latin, int Cjk, int Meaningful) Counts(string text)
        {
            var latin = text.Count(c => char.IsLetter(c) && c <= '\u024F');
            var cjk = text.Count(c => c is >= '\u3400' and <= '\u9FFF');
            return (latin, cjk, text.Count(char.IsLetterOrDigit));
        }
        var en = Counts(english.Text); var zh = Counts(chinese.Text);
        var enLatinRatio = en.Meaningful == 0 ? 0 : (double)en.Latin / en.Meaningful;
        if (enLatinRatio >= 0.72 && en.Meaningful >= zh.Meaningful * 0.65) return english;
        var zhCjkRatio = zh.Meaningful == 0 ? 0 : (double)zh.Cjk / zh.Meaningful;
        if (zhCjkRatio >= 0.08) return chinese;
        return en.Meaningful >= zh.Meaningful ? english : chinese;
    }
}
