using System.Windows;
using System.IO;

namespace ReadBridge.Desktop;

public partial class App : System.Windows.Application
{
    private MainWindow? _window;
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args.Length == 3 && e.Args[0] == "--ocr-test")
        {
            try { File.WriteAllText(e.Args[2], OfflineEnglishOcr.Recognize(File.ReadAllBytes(e.Args[1]))); Shutdown(0); }
            catch (Exception ex) { CrashLogger.Write("OcrSelfTest", ex); File.WriteAllText(e.Args[2], "ERROR: " + CrashLogger.Describe(ex)); Shutdown(1); }
            return;
        }
        if (e.Args.Length == 3 && e.Args[0] == "--import-test")
        {
            try { File.WriteAllText(e.Args[2], DocumentImportService.ReadAsync(e.Args[1], CancellationToken.None).GetAwaiter().GetResult()); Shutdown(0); }
            catch (Exception ex) { CrashLogger.Write("ImportSelfTest", ex); File.WriteAllText(e.Args[2], "ERROR: " + CrashLogger.Describe(ex)); Shutdown(1); }
            return;
        }
        if (e.Args.Length == 2 && e.Args[0] == "--ball-test")
        {
            var restored = false;
            var ball = new FloatingBallWindow(() => restored = true);
            ball.Show();
            _ = Dispatcher.InvokeAsync(async () =>
            {
                await Task.Delay(250);
                File.WriteAllText(e.Args[1], $"visible={ball.IsVisible};topmost={ball.Topmost};restored={restored};size={ball.ActualWidth:0}x{ball.ActualHeight:0}");
                ball.Close(); Shutdown(0);
            });
            return;
        }
        if (e.Args.Length == 3 && e.Args[0] == "--library-test")
        {
            try
            {
                var root = Path.Combine(Path.GetTempPath(), "readbridge-library-test-" + Guid.NewGuid().ToString("N"));
                var library = new DocumentLibraryService(root);
                var text = DocumentImportService.ReadAsync(e.Args[1], CancellationToken.None).GetAwaiter().GetResult();
                var first = Task.Run(() => library.AddOrUpdateAsync(e.Args[1], text, CancellationToken.None)).GetAwaiter().GetResult();
                var second = Task.Run(() => library.AddOrUpdateAsync(e.Args[1], text, CancellationToken.None)).GetAwaiter().GetResult();
                Task.Run(() => library.UpdateMetadataAsync(first, "测试重命名.txt", new[] { "测试", "文档" })).GetAwaiter().GetResult();
                var items = Task.Run(() => library.ListAsync()).GetAwaiter().GetResult();
                var restored = Task.Run(() => library.ReadTextAsync(first)).GetAwaiter().GetResult();
                Task.Run(() => library.DeleteAsync(first)).GetAwaiter().GetResult();
                var remaining = Task.Run(() => library.ListAsync()).GetAwaiter().GetResult();
                var trash = Task.Run(() => library.ListTrashAsync()).GetAwaiter().GetResult();
                Task.Run(() => library.RestoreAsync(trash.Single())).GetAwaiter().GetResult();
                var afterRestore = Task.Run(() => library.ListAsync()).GetAwaiter().GetResult();
                File.WriteAllText(e.Args[2], $"added={first.Id == second.Id};deduplicated={items.Count == 1};metadata={items.Single().Name == "测试重命名.txt" && items.Single().Tags.Count == 2};restored={restored == text};trashed={remaining.Count == 0 && trash.Count == 1};recovered={afterRestore.Count == 1}");
                Directory.Delete(root, true); Shutdown(0);
            }
            catch (Exception ex) { File.WriteAllText(e.Args[2], "ERROR: " + ex.Message); Shutdown(1); }
            return;
        }
        if (e.Args.Length == 2 && e.Args[0] == "--library-window-test")
        {
            var root = Path.Combine(Path.GetTempPath(), "readbridge-library-ui-" + Guid.NewGuid().ToString("N"));
            var window = new LibraryWindow(new DocumentLibraryService(root));
            window.Show();
            _ = Dispatcher.InvokeAsync(async () =>
            {
                await Task.Delay(300);
                File.WriteAllText(e.Args[1], $"visible={window.IsVisible};size={window.ActualWidth:0}x{window.ActualHeight:0}");
                window.Close(); Directory.Delete(root, true); Shutdown(0);
            });
            return;
        }
        DispatcherUnhandledException += (_, args) =>
        {
            CrashLogger.Write("DispatcherUnhandledException", args.Exception);
            System.Windows.MessageBox.Show("阅桥遇到了一个错误，但已阻止程序直接退出。\n\n" + args.Exception.Message + "\n\n日志：" + CrashLogger.LogPath, "阅桥", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) => { if (args.ExceptionObject is Exception ex) CrashLogger.Write("AppDomain.UnhandledException", ex); };
        TaskScheduler.UnobservedTaskException += (_, args) => { CrashLogger.Write("TaskScheduler.UnobservedTaskException", args.Exception); args.SetObserved(); };
        _window = new MainWindow();
        _window.Show();
    }
}
