using System.IO;

namespace ReadBridge.Desktop;

internal static class CrashLogger
{
    internal static string LogPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReadBridge", "logs", "desktop-errors.log");
    internal static void Write(string source, Exception exception)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"[{DateTimeOffset.Now:O}] {source}{Environment.NewLine}{exception}{Environment.NewLine}{Environment.NewLine}");
        }
        catch { }
    }
    internal static string Describe(Exception exception)
    {
        var current = exception;
        while (current.InnerException is not null) current = current.InnerException;
        return $"{current.GetType().Name}: {current.Message}";
    }
}
