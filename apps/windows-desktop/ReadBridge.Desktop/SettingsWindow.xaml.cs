using System.Windows;

namespace ReadBridge.Desktop;

public partial class SettingsWindow : Window
{
    public AppSettings Value { get; private set; }
    public SettingsWindow(AppSettings value)
    {
        InitializeComponent(); Value = value;
        for (var c = 'A'; c <= 'Z'; c++) KeyBox.Items.Add(c.ToString());
        ApiUrl.Text = value.ApiBaseUrl; Ctrl.IsChecked = (value.HotkeyModifiers & NativeMethods.MOD_CONTROL) != 0; Alt.IsChecked = (value.HotkeyModifiers & NativeMethods.MOD_ALT) != 0; Shift.IsChecked = (value.HotkeyModifiers & NativeMethods.MOD_SHIFT) != 0; KeyBox.SelectedItem = ((char)value.HotkeyKey).ToString(); AlwaysTop.IsChecked = value.AlwaysOnTop;
        OcrLanguage.SelectedIndex = value.OcrLanguageMode switch { "zh-Hans-CN" => 1, "en-US" => 2, _ => 0 };
    }
    private void Save(object sender, RoutedEventArgs e)
    {
        if (!Uri.TryCreate(ApiUrl.Text, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) { System.Windows.MessageBox.Show("请输入有效的 HTTP 地址。", "设置", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        uint mods = 0; if (Ctrl.IsChecked == true) mods |= NativeMethods.MOD_CONTROL; if (Alt.IsChecked == true) mods |= NativeMethods.MOD_ALT; if (Shift.IsChecked == true) mods |= NativeMethods.MOD_SHIFT;
        if (mods == 0 || KeyBox.SelectedItem is not string key) { System.Windows.MessageBox.Show("快捷键至少需要一个修饰键和一个字母。", "设置", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        Value = new() { ApiBaseUrl = uri.ToString().TrimEnd('/'), HotkeyModifiers = mods, HotkeyKey = key[0], AlwaysOnTop = AlwaysTop.IsChecked == true, OcrLanguageMode = OcrLanguage.SelectedIndex switch { 1 => "zh-Hans-CN", 2 => "en-US", _ => "auto" }, OutputLanguage = Value.OutputLanguage, VoiceId = Value.VoiceId, VoiceRate = Value.VoiceRate }; DialogResult = true;
    }
}
