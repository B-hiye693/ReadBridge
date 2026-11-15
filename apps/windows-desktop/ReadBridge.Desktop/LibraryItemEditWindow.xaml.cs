using System.Windows;

namespace ReadBridge.Desktop;

public partial class LibraryItemEditWindow : Window
{
    public string ItemName => NameBox.Text.Trim();
    public IReadOnlyList<string> Tags => TagsBox.Text
        .Split([',', '，', ';', '；'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public LibraryItemEditWindow(LibraryItem item)
    {
        InitializeComponent();
        NameBox.Text = item.Name;
        TagsBox.Text = string.Join(", ", item.Tags ?? []);
        Loaded += (_, _) => { NameBox.Focus(); NameBox.SelectAll(); };
    }

    private void Save(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(ItemName))
        {
            System.Windows.MessageBox.Show("文件名称不能为空。", "编辑文件信息", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        DialogResult = true;
    }
}
