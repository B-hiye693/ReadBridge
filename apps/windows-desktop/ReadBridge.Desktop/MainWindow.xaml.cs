using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace ReadBridge.Desktop;

public partial class MainWindow : Window
{
    private const int CaptureHotkeyId = 0x5242;
    private const int ExplainHotkeyId = 0x5243;
    private readonly SettingsStore _store = new();
    private readonly SelectionCaptureService _capture = new();
    private readonly SpeechService _speech = new();
    private readonly DocumentLibraryService _library = new();
    private readonly Forms.NotifyIcon _tray;
    private readonly DispatcherTimer _targetTracker;
    private FloatingBallWindow? _floatingBall;
    private AppSettings _settings;
    private ApiClient _api;
    private CancellationTokenSource? _operation;
    private IntPtr _handle, _lastTargetWindow;
    private long _generation;
    private bool _reallyExit, _suppressInputChanged;
    private bool _sideBySide;
    private bool _stepMode;
    private int _stepIndex;
    private EasyReadDocument? _currentEasyRead;
    private LibraryItem? _currentLibraryItem;
    private string _source = "手动输入";

    public MainWindow()
    {
        InitializeComponent();
        _settings = _store.Load();
        _api = new ApiClient(_settings.ApiBaseUrl);
        Topmost = _settings.AlwaysOnTop;
        TopmostButton.Content = Topmost ? "▣" : "□";
        OutputLanguage.SelectedIndex = _settings.OutputLanguage switch { "zh-CN" => 1, "en-US" => 2, _ => 0 };
        VoiceRate.Value = _settings.VoiceRate;
        SelectionHelp.Text = $"选中文字后按 {_settings.HotkeyText} 读取；按 Ctrl+Alt+E 直接解释";
        _tray = new Forms.NotifyIcon { Text = "阅桥 ReadBridge", Icon = System.Drawing.SystemIcons.Information, Visible = true };
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("显示阅桥", null, (_, _) => ShowAndActivate());
        menu.Items.Add("读取选区", null, async (_, _) => await CaptureFromTargetAsync(_lastTargetWindow));
        menu.Items.Add("读取并解释", null, async (_, _) => await CaptureFromTargetAsync(_lastTargetWindow, true));
        menu.Items.Add("框选识字", null, (_, _) => Dispatcher.Invoke(async () => await StartOcrAsync()));
        menu.Items.Add("文件库", null, (_, _) => Dispatcher.Invoke(OpenLibraryDialog));
        menu.Items.Add("退出", null, (_, _) => Dispatcher.Invoke(ExitApp));
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => Dispatcher.Invoke(ShowAndActivate);
        SourceInitialized += OnSourceInitialized;
        Loaded += async (_, _) => await LoadVoicesWithRetryAsync();
        // 切换到浏览器、PDF 或其他窗口时继续生成。只有新任务、编辑原文、取消或退出才终止旧任务。
        _targetTracker = new DispatcherTimer(TimeSpan.FromMilliseconds(250), DispatcherPriority.Background, TrackTarget, Dispatcher);
        _targetTracker.Start();
    }

    private void TitleBarMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2) { ToggleMaximizeWindow(sender, e); return; }
        if (e.LeftButton == MouseButtonState.Pressed) DragMove();
    }
    private void MinimizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void ToggleMaximizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void CloseChrome(object sender, RoutedEventArgs e) => Close();

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _handle = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(_handle).AddHook(WndProc);
        RegisterHotkeys();
    }
    private void TrackTarget(object? sender, EventArgs e)
    {
        var foreground = NativeMethods.GetForegroundWindow();
        if (foreground != IntPtr.Zero && foreground != _handle) _lastTargetWindow = foreground;
    }
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != NativeMethods.WM_HOTKEY) return IntPtr.Zero;
        var id = wParam.ToInt32();
        if (id is CaptureHotkeyId or ExplainHotkeyId)
        {
            var window = NativeMethods.GetForegroundWindow();
            _ = CaptureFromTargetAsync(window, id == ExplainHotkeyId);
            handled = true;
        }
        return IntPtr.Zero;
    }
    private void RegisterHotkeys()
    {
        NativeMethods.UnregisterHotKey(_handle, CaptureHotkeyId);
        NativeMethods.UnregisterHotKey(_handle, ExplainHotkeyId);
        var captureOk = NativeMethods.RegisterHotKey(_handle, CaptureHotkeyId, _settings.HotkeyModifiers | NativeMethods.MOD_NOREPEAT, (uint)_settings.HotkeyKey);
        var explainOk = NativeMethods.RegisterHotKey(_handle, ExplainHotkeyId, NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT | NativeMethods.MOD_NOREPEAT, 0x45);
        if (!captureOk || !explainOk) SetStatus("快捷键注册失败（可能与其他软件冲突）。读取快捷键可在设置中更换；解释快捷键为 Ctrl+Alt+E。", false);
    }
    private async Task CaptureFromTargetAsync(IntPtr window, bool autoExplain = false)
    {
        var (token, generation) = BeginOperation("正在读取目标应用的文字选区…");
        CaptureResult result;
        try { result = await _capture.CaptureAsync(window, token); }
        catch (OperationCanceledException) { return; }
        if (!IsCurrent(generation, token)) return;
        ShowAndActivate();
        if (!result.Success) { SetStatus(result.Message, false); EndBusy(); return; }
        ApplyCapture(result);
        if (autoExplain) await RunExplainAsync();
    }
    private async void CaptureSelection(object sender, RoutedEventArgs e) => await CaptureFromTargetAsync(_lastTargetWindow);
    private async void CaptureOcr(object sender, RoutedEventArgs e) => await StartOcrAsync();
    private async Task StartOcrAsync()
    {
        CancelCurrent(); Hide();
        CaptureResult result;
        try
        {
            await Task.Delay(180);
            var overlay = new RegionOverlay(_settings.OcrLanguageMode);
            overlay.RecognitionStarted += (_, _) => Dispatcher.Invoke(() => { ShowAndActivate(); Progress.Visibility = Visibility.Visible; SetStatus("正在本机识别中文和英文，请稍候…", true); });
            overlay.Show();
            result = await overlay.Completion;
        }
        catch (Exception ex) { result = CaptureResult.Fail("无法启动框选识字：" + ex.Message); }
        ShowAndActivate(); EndBusy();
        if (result.Success) ApplyCapture(result); else SetStatus(result.Message, false);
    }
    private void ApplyCapture(CaptureResult result, LibraryItem? libraryItem = null)
    {
        CancelCurrent();
        SelectionExplainPopup.IsOpen = false;
        _currentLibraryItem = libraryItem;
        _currentEasyRead = null;
        _stepMode = false;
        _source = result.Source;
        SourceText.Text = "来源：" + _source;
        _suppressInputChanged = true; InputText.Text = result.Text; _suppressInputChanged = false;
        OutputText.Clear(); OriginalCount.Text = $"{result.Text.Length:N0} 字符"; UpdateDetectedLanguage(); SetStatus(result.Message, true); InputText.Focus();
    }
    private async void PasteText(object sender, RoutedEventArgs e)
    {
        SetStatus("正在读取剪贴板…", true);
        try
        {
            var text = await ClipboardService.GetTextAsync(TimeSpan.FromSeconds(2));
            if (string.IsNullOrWhiteSpace(text)) SetStatus("剪贴板中没有文本。", false);
            else ApplyCapture(new(true, text, "手动粘贴", "已从剪贴板粘贴，可编辑后操作"));
        }
        catch (TimeoutException) { SetStatus("剪贴板响应超时，可能正被其他软件占用，请稍后重试。", false); }
        catch (Exception ex) { SetStatus("无法读取剪贴板：" + ex.Message, false); }
    }
    private async void OpenFile(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = DocumentImportService.Filter, Multiselect = false };
        if (dialog.ShowDialog(this) == true) await ImportFileAsync(dialog.FileName);
    }
    private void OnDragOver(object sender, System.Windows.DragEventArgs e) { e.Effects = e.Data.GetDataPresent(System.Windows.DataFormats.FileDrop) ? System.Windows.DragDropEffects.Copy : System.Windows.DragDropEffects.None; e.Handled = true; }
    private async void OnFileDrop(object sender, System.Windows.DragEventArgs e)
    {
        if (e.Data.GetData(System.Windows.DataFormats.FileDrop) is string[] files && files.Length > 0) await ImportFileAsync(files[0]);
    }
    private async Task ImportFileAsync(string path)
    {
        var (token, generation) = BeginOperation("正在读取文件全文…");
        try
        {
            var text = await DocumentImportService.ReadAsync(path, token);
            if (!IsCurrent(generation, token)) return;
            try
            {
                var item = await _library.AddOrUpdateAsync(path, text, token);
                if (IsCurrent(generation, token)) ApplyCapture(new(true, text, $"文件库 · {item.Name}", $"已读取全文并自动保存到本机文件库，共 {text.Length:N0} 个字符。"), item);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception libraryError)
            {
                if (IsCurrent(generation, token)) ApplyCapture(new(true, text, $"文件全文 · {Path.GetFileName(path)}", $"文件已读取，但保存到文件库失败：{libraryError.Message}"));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus("文件读取失败：" + ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private void OpenLibrary(object sender, RoutedEventArgs e) => OpenLibraryDialog();
    private async void OpenLibraryDialog()
    {
        var dialog = new LibraryWindow(_library) { Owner = this };
        if (dialog.ShowDialog() == true && dialog.SelectedItem is LibraryItem item)
        {
            ApplyCapture(new(true, dialog.SelectedText, $"文件库 · {item.Name}", $"已从文件库打开，共 {dialog.SelectedText.Length:N0} 个字符。"), item);
            var analysis = await _library.ReadAnalysisAsync(item);
            RestoreSavedAnalysis(analysis);
        }
    }

    private async void Explain(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(InputText.Text)) { await DelayedCaptureAndExplainAsync(); return; }
        await RunExplainAsync(InputText.SelectionLength > 0 ? InputText.SelectedText : null);
    }
    private async Task DelayedCaptureAndExplainAsync()
    {
        CancelCurrent();
        _tray.ShowBalloonTip(3500, "请选择要解释的文字", "请在 4 秒内切换到目标应用并选中文字，阅桥随后会自动读取和解释。", Forms.ToolTipIcon.Info);
        Hide();
        await Task.Delay(4000);
        var target = NativeMethods.GetForegroundWindow();
        await CaptureFromTargetAsync(target, true);
    }
    private Task RunExplainAsync(string? selectedText = null) => RunExplainTextAsync(string.IsNullOrWhiteSpace(selectedText) ? InputText.Text.Trim() : selectedText.Trim());
    private async Task RunExplainTextAsync(string text)
    {
        if (text.Length == 0) { SetStatus("请先选择或输入需要解释的文字。", false); return; }
        SelectionExplainPopup.IsOpen = false;
        var language = SelectedOutputLanguage();
        var (token, generation) = BeginOperation("正在生成简单解释…");
        try
        {
            if (!await _api.IsOnlineAsync(token)) throw new InvalidOperationException("本机 FastAPI 未启动。取文、OCR 和文件读取仍可使用；启动后端后再调用 AI。");
            var result = await _api.ExplainAsync(text, language, token);
            if (!IsCurrent(generation, token)) return;
            ShowExplainDocument(result);
            SetStatus(language == "auto" ? "解释完成，输出语言已跟随原文" : "解释完成", true);
            if (_currentLibraryItem is not null) await _library.SaveExplanationAsync(_currentLibraryItem, text, language, result, CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus(ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private async void EasyRead(object sender, RoutedEventArgs e) => await RunEasyReadAsync();
    private async Task RunEasyReadAsync()
    {
        var text = InputText.Text.Trim();
        if (text.Length == 0) { SetStatus("请先读取、框选、粘贴、输入文字或打开文件。", false); return; }
        var (token, generation) = BeginOperation("正在生成易读版本…");
        try
        {
            if (!await _api.IsOnlineAsync(token)) throw new InvalidOperationException("本机 FastAPI 未启动。请启动后端后再调用 AI。");
            var document = await _api.EasyReadAsync(text, _source, SelectedOutputLanguage(), new Progress<string>(s => SetStatus(s, true)), token);
            if (IsCurrent(generation, token))
            {
                ShowEasyReadDocument(document);
                SetStatus(document.PartCount == 1 ? "生成完成" : $"全文 {document.PartCount} 个部分均已处理完成，没有跳过中间内容。", true);
                if (_currentLibraryItem is not null) await _library.SaveEasyReadAsync(_currentLibraryItem, SelectedOutputLanguage(), document, CancellationToken.None);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus(ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private void ShowEasyReadDocument(EasyReadDocument document)
    {
        _currentEasyRead = document;
        _stepMode = false;
        _stepIndex = 0;
        OutputText.Text = document.PlainText;
        ResultModeLabel.Text = "一键易读";
        SummaryLabel.Text = "全文概览";
        ResultTitle.Text = document.Title;
        SummaryText.Text = document.Summary;
        CoverageText.Text = document.PartCount == 1 ? $"文章全貌 · 共整理出 {document.Cards.Count} 个内容模块" : $"全文已完整分为 {document.PartCount} 部分处理 · 共整理出 {document.Cards.Count} 个内容模块";
        CoveragePanel.Visibility = Visibility.Visible;
        ResultCards.ItemsSource = document.Cards;
        var sectionCount = document.Cards.Count(card => card.Kind == "section");
        StepModeButton.Visibility = sectionCount > 1 ? Visibility.Visible : Visibility.Collapsed;
        StepModeButton.Content = "逐段阅读";
        StepPager.Visibility = Visibility.Collapsed;
        OutputText.Visibility = Visibility.Collapsed;
        ResultScroll.Visibility = Visibility.Visible;
    }
    private void ShowExplainDocument(ExplainDocument document)
    {
        _currentEasyRead = null;
        _stepMode = false;
        OutputText.Text = document.PlainText;
        ResultModeLabel.Text = "简单解释";
        SummaryLabel.Text = "用简单的话来说";
        ResultTitle.Text = document.Title;
        SummaryText.Text = document.Summary;
        CoveragePanel.Visibility = Visibility.Collapsed;
        StepModeButton.Visibility = Visibility.Collapsed;
        StepPager.Visibility = Visibility.Collapsed;
        ResultCards.ItemsSource = document.Cards;
        OutputText.Visibility = Visibility.Collapsed;
        ResultScroll.Visibility = Visibility.Visible;
        ResultScroll.ScrollToTop();
    }
    private void RestoreSavedAnalysis(LibraryAnalysis analysis)
    {
        if (analysis.LastResultKind == "easy-read" && analysis.EasyReadResults.TryGetValue(analysis.LastResultKey, out var easyRead))
        {
            ShowEasyReadDocument(easyRead);
            SetStatus("已恢复文件库中保存的一键易读结果，无需重新生成。", true);
            return;
        }
        if (analysis.LastResultKind == "explain")
        {
            var split = analysis.LastResultKey.IndexOf('\n');
            var language = split >= 0 ? analysis.LastResultKey[..split] : analysis.LastResultKey;
            var text = split >= 0 ? analysis.LastResultKey[(split + 1)..] : "";
            var saved = analysis.Explanations.FirstOrDefault(value => value.OutputLanguage == language && value.Text == text);
            if (saved is not null)
            {
                if (saved.Document is not null) ShowExplainDocument(saved.Document);
                else
                {
                    OutputText.Text = saved.Result;
                    OutputText.Visibility = Visibility.Visible;
                    ResultScroll.Visibility = Visibility.Collapsed;
                }
                SetStatus("已恢复文件库中保存的简单解释，无需重新生成。", true);
                return;
            }
        }
        SetStatus(analysis.EasyReadResults.Count + analysis.Explanations.Count > 0 ? "文件已打开；已保存的其他语言或选段结果仍保留在文件库中。" : "文件已打开，尚无保存的 AI 结果。", true);
    }
    private List<ResultCard> StepSections => _currentEasyRead?.Cards.Where(card => card.Kind == "section").ToList() ?? [];
    private void ToggleStepMode(object sender, RoutedEventArgs e)
    {
        if (_currentEasyRead is null) return;
        _stepMode = !_stepMode;
        _stepIndex = 0;
        StepModeButton.Content = _stepMode ? "查看全部" : "逐段阅读";
        StepPager.Visibility = _stepMode ? Visibility.Visible : Visibility.Collapsed;
        RenderStepMode();
    }
    private void PreviousStep(object sender, RoutedEventArgs e) { if (_stepIndex > 0) { _stepIndex--; RenderStepMode(); } }
    private void NextStep(object sender, RoutedEventArgs e) { if (_stepIndex + 1 < StepSections.Count) { _stepIndex++; RenderStepMode(); } }
    private void RenderStepMode()
    {
        if (_currentEasyRead is null) return;
        if (!_stepMode) { ResultCards.ItemsSource = _currentEasyRead.Cards; return; }
        var sections = StepSections;
        if (sections.Count == 0) return;
        _stepIndex = Math.Clamp(_stepIndex, 0, sections.Count - 1);
        ResultCards.ItemsSource = new[] { sections[_stepIndex] };
        StepProgressText.Text = $"第 {_stepIndex + 1} / {sections.Count} 段";
        PreviousStepButton.IsEnabled = _stepIndex > 0;
        NextStepButton.IsEnabled = _stepIndex + 1 < sections.Count;
        ResultScroll.ScrollToTop();
    }

    private void InputSelectionChanged(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded || InputText.SelectionLength <= 0 || string.IsNullOrWhiteSpace(InputText.SelectedText)) { SelectionExplainPopup.IsOpen = false; return; }
        Dispatcher.BeginInvoke(() =>
        {
            if (InputText.SelectionLength <= 0) return;
            var rect = InputText.GetRectFromCharacterIndex(InputText.SelectionStart + InputText.SelectionLength, true);
            SelectionExplainPopup.HorizontalOffset = Math.Clamp(rect.Right + 8, 8, Math.Max(8, InputText.ActualWidth - 130));
            SelectionExplainPopup.VerticalOffset = Math.Clamp(rect.Bottom + 4, 8, Math.Max(8, InputText.ActualHeight - 45));
            SelectionExplainPopup.IsOpen = true;
        }, DispatcherPriority.Background);
    }
    private async void ExplainSelection(object sender, RoutedEventArgs e)
    {
        var selected = InputText.SelectedText;
        if (!string.IsNullOrWhiteSpace(selected)) await RunExplainAsync(selected);
    }
    private async Task RunTextOperation(string status, Func<string, string, CancellationToken, Task<string>> action)
    {
        var text = InputText.Text.Trim();
        if (text.Length == 0) { SetStatus("请先读取、框选、粘贴、输入文字或打开文件。", false); return; }
        var language = SelectedOutputLanguage();
        var (token, generation) = BeginOperation(status);
        try
        {
            if (!await _api.IsOnlineAsync(token)) throw new InvalidOperationException("本机 FastAPI 未启动。取文、OCR 和文件读取仍可使用；启动后端后再调用 AI。");
            var result = await action(text, language, token);
            if (IsCurrent(generation, token)) { OutputText.Text = result; OutputText.Visibility = Visibility.Visible; ResultScroll.Visibility = Visibility.Collapsed; SetStatus(language == "auto" ? "生成完成，输出语言已跟随原文" : "生成完成", true); }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus(ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private async Task<bool> LoadVoicesAsync()
    {
        try
        {
            var voices = await _api.GetVoicesAsync(CancellationToken.None);
            VoiceBox.ItemsSource = voices.Voices;
            VoiceBox.SelectedItem = voices.Voices.FirstOrDefault(v => v.Id == _settings.VoiceId) ?? voices.Voices.FirstOrDefault(v => v.Id == voices.DefaultVoice) ?? voices.Voices.FirstOrDefault();
            return VoiceBox.SelectedItem is VoiceInfo { Id.Length: > 0 };
        }
        catch { VoiceBox.ItemsSource = new[] { new VoiceInfo { Id = "", Name = "Windows 系统语音（后端暂不可用）", Language = "自动" } }; VoiceBox.SelectedIndex = 0; return false; }
    }
    private async Task LoadVoicesWithRetryAsync()
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            if (await LoadVoicesAsync())
            {
                if (attempt > 0) SetStatus("后端已就绪，神经语音音色已自动恢复。", true);
                return;
            }
            await Task.Delay(attempt < 3 ? 700 : 1400);
        }
        SetStatus("后端语音暂不可用；阅桥会在首次朗读时继续自动重试。", false);
    }
    private async Task<VoiceInfo?> EnsureVoiceAsync()
    {
        if (VoiceBox.SelectedItem is VoiceInfo { Id.Length: > 0 } voice) return voice;
        SetStatus("正在重新连接神经语音并刷新音色…", true);
        return await LoadVoicesAsync() ? VoiceBox.SelectedItem as VoiceInfo : null;
    }
    private async void RefreshVoices(object sender, RoutedEventArgs e)
    {
        var available = await LoadVoicesAsync();
        SetStatus(available ? "神经语音音色已刷新" : "暂时无法连接神经语音，朗读时将继续自动重试", available);
    }
    private void VoiceRateChanged(object sender, RoutedPropertyChangedEventArgs<double> e) { if (VoiceRateLabel is not null) VoiceRateLabel.Text = $"{e.NewValue:0.0}×"; }
    private async void Speak(object sender, RoutedEventArgs e)
    {
        var text = (string.IsNullOrWhiteSpace(OutputText.Text) ? InputText.Text : OutputText.Text).Trim();
        if (text.Length == 0) { SetStatus("没有可朗读的文字。", false); return; }
        var detected = LanguageDetector.Detect(text);
        var voice = await EnsureVoiceAsync();
        var (token, generation) = BeginOperation("正在准备语音…");
        try
        {
            var status = await _speech.SpeakAsync(text, _api, detected, voice?.Id ?? "", VoiceRate.Value, token);
            if (IsCurrent(generation, token)) SetStatus(status, true);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus("语音失败：" + ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private async void SpeakCard(object sender, RoutedEventArgs e)
    {
        if (sender is not System.Windows.Controls.Button { Tag: ResultCard card }) return;
        await SpeakTextAsync($"{card.Heading}。{card.Content}");
    }
    private async Task SpeakTextAsync(string text)
    {
        var voice = await EnsureVoiceAsync();
        var (token, generation) = BeginOperation("正在准备此模块的语音…");
        try
        {
            var status = await _speech.SpeakAsync(text, _api, LanguageDetector.Detect(text), voice?.Id ?? "", VoiceRate.Value, token);
            if (IsCurrent(generation, token)) SetStatus(status, true);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { if (IsCurrent(generation, token)) SetStatus("语音失败：" + ex.Message, false); }
        finally { if (generation == _generation) EndBusy(); }
    }
    private void LocateSource(object sender, RoutedEventArgs e)
    {
        if (sender is not System.Windows.Controls.Button { Tag: ResultCard card } || string.IsNullOrWhiteSpace(card.SourceText)) return;
        var source = card.SourceText.Trim();
        var index = InputText.Text.IndexOf(source, StringComparison.CurrentCulture);
        var length = source.Length;
        if (index < 0)
        {
            var fragment = source.Split(['。', '！', '？', '.', '!', '?', '\n'], StringSplitOptions.RemoveEmptyEntries).OrderByDescending(s => s.Length).FirstOrDefault()?.Trim() ?? source;
            if (fragment.Length > 80) fragment = fragment[..80];
            index = InputText.Text.IndexOf(fragment, StringComparison.CurrentCultureIgnoreCase);
            length = fragment.Length;
        }
        if (index < 0) { SetStatus("没有在当前原文中找到完全对应的句子；原文可能在生成后被编辑过。", false); return; }
        InputText.Focus(); InputText.Select(index, length); InputText.ScrollToLine(InputText.GetLineIndexFromCharacterIndex(index));
        SetStatus("已定位并高亮对应原文。", true);
    }
    private void ToggleLayout(object sender, RoutedEventArgs e)
    {
        _sideBySide = !_sideBySide;
        if (_sideBySide)
        {
            OriginalRow.Height = new GridLength(1, GridUnitType.Star); SplitterRow.Height = new GridLength(0); ResultRow.Height = new GridLength(0);
            OriginalColumn.Width = new GridLength(1, GridUnitType.Star); SplitterColumn.Width = new GridLength(8); ResultColumn.Width = new GridLength(1, GridUnitType.Star);
            Grid.SetRow(OriginalPanel, 0); Grid.SetColumn(OriginalPanel, 0); Grid.SetRow(ResultPanel, 0); Grid.SetColumn(ResultPanel, 2); Grid.SetRow(ContentSplitter, 0); Grid.SetColumn(ContentSplitter, 1);
            ContentSplitter.ResizeDirection = GridResizeDirection.Columns; ContentSplitter.Width = 8; ContentSplitter.Height = double.NaN; ContentSplitter.HorizontalAlignment = System.Windows.HorizontalAlignment.Center; ContentSplitter.VerticalAlignment = System.Windows.VerticalAlignment.Stretch;
            LayoutButton.Content = "⇅"; SetStatus("已切换为左右对照布局，可拖动中间分隔线调整宽度。", true);
        }
        else
        {
            OriginalRow.Height = new GridLength(1, GridUnitType.Star); SplitterRow.Height = new GridLength(8); ResultRow.Height = new GridLength(1, GridUnitType.Star);
            OriginalColumn.Width = new GridLength(1, GridUnitType.Star); SplitterColumn.Width = new GridLength(0); ResultColumn.Width = new GridLength(0);
            Grid.SetRow(OriginalPanel, 0); Grid.SetColumn(OriginalPanel, 0); Grid.SetRow(ResultPanel, 2); Grid.SetColumn(ResultPanel, 0); Grid.SetRow(ContentSplitter, 1); Grid.SetColumn(ContentSplitter, 0);
            ContentSplitter.ResizeDirection = GridResizeDirection.Rows; ContentSplitter.Height = 8; ContentSplitter.Width = double.NaN; ContentSplitter.HorizontalAlignment = System.Windows.HorizontalAlignment.Stretch; ContentSplitter.VerticalAlignment = System.Windows.VerticalAlignment.Center;
            LayoutButton.Content = "⇆"; SetStatus("已切换为上下布局，可拖动中间分隔线调整高度。", true);
        }
    }
    private string SelectedOutputLanguage() => (OutputLanguage.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "auto";
    private void OutputLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        _settings.OutputLanguage = SelectedOutputLanguage(); _store.Save(_settings);
    }
    private void UpdateDetectedLanguage()
    {
        var text = InputText.Text.Trim();
        DetectedLanguageText.Text = text.Length == 0 ? "语言：等待内容" : "原文语言：" + LanguageDetector.DisplayName(LanguageDetector.Detect(text));
    }
    private (CancellationToken Token, long Generation) BeginOperation(string status) { CancelCurrent(); var operation = new CancellationTokenSource(); _operation = operation; var g = _generation; Progress.Visibility = Visibility.Visible; SetStatus(status, true); return (operation.Token, g); }
    private bool IsCurrent(long generation, CancellationToken token) => generation == _generation && !token.IsCancellationRequested;
    private void CancelCurrent() { _generation++; var operation = Interlocked.Exchange(ref _operation, null); if (operation is not null) { try { operation.Cancel(); } finally { operation.Dispose(); } } _speech.Stop(); EndBusy(); }
    private void EndBusy() => Progress.Visibility = Visibility.Collapsed;
    private void CancelWork(object sender, RoutedEventArgs e) { CancelCurrent(); SetStatus("已取消当前操作", true); }
    private void StopSpeech(object sender, RoutedEventArgs e) { _speech.Stop(); SetStatus("已停止朗读", true); }
    private void InputChanged(object sender, TextChangedEventArgs e) { if (IsLoaded && !_suppressInputChanged) { CancelCurrent(); _currentLibraryItem = null; _currentEasyRead = null; _stepMode = false; SelectionExplainPopup.IsOpen = false; StepModeButton.Visibility = Visibility.Collapsed; StepPager.Visibility = Visibility.Collapsed; OutputText.Clear(); ResultCards.ItemsSource = null; ResultScroll.Visibility = Visibility.Collapsed; OutputText.Visibility = Visibility.Visible; UpdateDetectedLanguage(); OriginalCount.Text = $"{InputText.Text.Length:N0} 字符"; } }
    private void ToggleTopmost(object sender, RoutedEventArgs e) { Topmost = !Topmost; _settings.AlwaysOnTop = Topmost; _store.Save(_settings); TopmostButton.Content = Topmost ? "▣" : "□"; TopmostButton.ToolTip = Topmost ? "取消置顶" : "置顶"; }
    private void CollapseToBall(object sender, RoutedEventArgs e)
    {
        _floatingBall ??= new FloatingBallWindow(() => Dispatcher.Invoke(ShowAndActivate));
        Hide();
        _floatingBall.Show();
        _floatingBall.Activate();
        SetStatus("阅桥已收起为悬浮球；当前生成任务会继续运行。", true);
    }
    private void OpenSettings(object sender, RoutedEventArgs e) { var dialog = new SettingsWindow(_settings) { Owner = this }; if (dialog.ShowDialog() == true) { _settings = dialog.Value; _store.Save(_settings); _api.Dispose(); _api = new ApiClient(_settings.ApiBaseUrl); Topmost = _settings.AlwaysOnTop; RegisterHotkeys(); SelectionHelp.Text = $"选中文字后按 {_settings.HotkeyText} 读取；按 Ctrl+Alt+E 直接解释"; _ = LoadVoicesAsync(); SetStatus("设置已保存", true); } }
    private void LargerFont(object sender, RoutedEventArgs e) => SetFont(InputText.FontSize + 1);
    private void SmallerFont(object sender, RoutedEventArgs e) => SetFont(InputText.FontSize - 1);
    private void SetFont(double size)
    {
        size = Math.Clamp(size, 12, 34);
        Resources["ReadingFontSize"] = size;
        Resources["ReadingLineHeight"] = Math.Max(22, size * 1.65);
        Resources["ReadingHeadingFontSize"] = Math.Max(12, size - 1);
        Resources["ReadingTitleFontSize"] = Math.Min(38, size + 4);
        Resources["ReadingSmallFontSize"] = Math.Max(11, size - 3);
        InputText.FontSize = OutputText.FontSize = SummaryText.FontSize = size;
        SummaryText.LineHeight = Math.Max(22, size * 1.65);
        ResultTitle.FontSize = Math.Min(38, size + 4);
        CoverageText.FontSize = Math.Max(11, size - 2);
    }
    private void OnPreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e) { if (Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && (e.Key == Key.Add || e.Key == Key.OemPlus)) { SetFont(InputText.FontSize + 1); e.Handled = true; } else if (Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && (e.Key == Key.Subtract || e.Key == Key.OemMinus)) { SetFont(InputText.FontSize - 1); e.Handled = true; } else if (e.Key == Key.Escape) { CancelCurrent(); SetStatus("已取消当前操作", true); } }
    private void SetStatus(string text, bool normal) { StatusText.Text = text; StatusText.Foreground = new System.Windows.Media.SolidColorBrush((System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(normal ? "#514879" : "#B42318")); }
    private void ShowAndActivate() { _floatingBall?.Hide(); Show(); WindowState = WindowState.Normal; Activate(); }
    private void OnClosing(object? sender, CancelEventArgs e) { if (!_reallyExit) { e.Cancel = true; CancelCurrent(); _floatingBall?.Hide(); Hide(); _tray.ShowBalloonTip(1500, "阅桥仍在运行", "双击托盘图标可恢复。", Forms.ToolTipIcon.Info); } }
    private void ExitApp() { _settings.VoiceId = (VoiceBox.SelectedItem as VoiceInfo)?.Id ?? ""; _settings.VoiceRate = VoiceRate.Value; _store.Save(_settings); _reallyExit = true; CancelCurrent(); NativeMethods.UnregisterHotKey(_handle, CaptureHotkeyId); NativeMethods.UnregisterHotKey(_handle, ExplainHotkeyId); _targetTracker.Stop(); _floatingBall?.Close(); _tray.Visible = false; _tray.Dispose(); _api.Dispose(); _speech.Dispose(); Close(); System.Windows.Application.Current.Shutdown(); }
}
