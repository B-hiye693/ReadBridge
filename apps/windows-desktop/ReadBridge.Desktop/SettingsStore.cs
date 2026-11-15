using System.Text.Json;
using System.IO;

namespace ReadBridge.Desktop;

internal sealed class SettingsStore
{
    private readonly string _path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReadBridge", "settings.json");
    public AppSettings Load()
    {
        try { return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_path)) ?? new(); }
        catch { return new(); }
    }
    public void Save(AppSettings value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
    }
}
