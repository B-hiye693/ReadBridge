using System.Windows;

namespace ReadBridge.Desktop;

public partial class LibraryTrashWindow : Window
{
    private readonly DocumentLibraryService _library;
    public bool Changed { get; private set; }
    public LibraryTrashWindow(DocumentLibraryService library) { InitializeComponent(); _library = library; Loaded += async (_, _) => await ReloadAsync(); }
    private async Task ReloadAsync() { var items = await _library.ListTrashAsync(); TrashList.ItemsSource = items; CountText.Text = $"共 {items.Count} 个文件"; }
    private async void RestoreSelected(object sender, RoutedEventArgs e)
    {
        if (TrashList.SelectedItem is not LibraryTrashEntry entry) return;
        try { await _library.RestoreAsync(entry); Changed = true; await ReloadAsync(); }
        catch (Exception ex) { System.Windows.MessageBox.Show(ex.Message, "无法恢复", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }
    private async void DeletePermanently(object sender, RoutedEventArgs e)
    {
        if (TrashList.SelectedItem is not LibraryTrashEntry entry) return;
        if (System.Windows.MessageBox.Show($"确定永久删除“{entry.Item.Name}”吗？此操作无法恢复。", "永久删除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await _library.DeletePermanentlyAsync(entry); Changed = true; await ReloadAsync();
    }
    private void CloseWindow(object sender, RoutedEventArgs e) => Close();
}
