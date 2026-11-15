using System.Windows.Automation;

namespace ReadBridge.Desktop;

internal sealed class SelectionCaptureService
{
    public async Task<CaptureResult> CaptureAsync(IntPtr targetWindow, CancellationToken token)
    {
        try { return await Task.Run(() => Capture(targetWindow, token), token).WaitAsync(TimeSpan.FromSeconds(3), token); }
        catch (TimeoutException) { return CaptureResult.Fail("目标应用在 3 秒内没有返回选区，请改用框选识字或手动粘贴。"); }
    }
    private static CaptureResult Capture(IntPtr targetWindow, CancellationToken token)
    {
        if (targetWindow == IntPtr.Zero) return CaptureResult.Fail("没有可读取的目标窗口。");
        try
        {
            RestoreTargetFocus(targetWindow);
            token.ThrowIfCancellationRequested();
            var focused = AutomationElement.FocusedElement;
            if (focused is null) return CaptureResult.Fail("无法访问目标控件，请改用框选识字或手动粘贴。");
            if (focused.Current.IsPassword) return CaptureResult.Fail("出于安全原因，阅桥不会读取密码控件。");
            if (!focused.TryGetCurrentPattern(TextPattern.Pattern, out var pattern))
                return CaptureResult.Fail("该应用未提供可访问的文字选区，请改用框选识字或手动粘贴。");
            var ranges = ((TextPattern)pattern).GetSelection();
            var text = string.Join(Environment.NewLine, ranges.Select(r => r.GetText(10000).Trim()).Where(t => t.Length > 0)).Trim();
            return text.Length == 0 ? CaptureResult.Fail("没有检测到选中文字，请先选中文字后重试。") : new(true, text, "UI Automation 选区", "已读取当前选区");
        }
        catch (ElementNotAvailableException) { return CaptureResult.Fail("目标窗口已关闭或选区已失效。"); }
        catch (UnauthorizedAccessException) { return CaptureResult.Fail("目标窗口权限高于阅桥，无法读取。请使用框选识字，或在确认安全后以相同权限运行。"); }
        catch (OperationCanceledException) { throw; }
        catch { return CaptureResult.Fail("无法读取该应用的选区，请改用框选识字或手动粘贴。"); }
    }
    private static void RestoreTargetFocus(IntPtr window)
    {
        NativeMethods.SetForegroundWindow(window);
        Thread.Sleep(80);
    }
}
