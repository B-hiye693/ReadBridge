namespace ReadBridge.Desktop;

internal static class ClipboardService
{
    public static async Task<string> GetTextAsync(TimeSpan timeout)
    {
        var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                for (var attempt = 0; attempt < 5; attempt++)
                {
                    try { completion.TrySetResult(System.Windows.Clipboard.ContainsText() ? System.Windows.Clipboard.GetText() : ""); return; }
                    catch (System.Runtime.InteropServices.COMException) when (attempt < 4) { Thread.Sleep(80); }
                }
            }
            catch (Exception ex) { completion.TrySetException(ex); }
        }) { IsBackground = true, Name = "ReadBridge Clipboard Reader" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return await completion.Task.WaitAsync(timeout);
    }
}
