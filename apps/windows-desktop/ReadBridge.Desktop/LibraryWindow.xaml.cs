using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace ReadBridge.Desktop;

public partial class LibraryWindow : Window
{
    private readonly DocumentLibraryService _library;
    private List<LibraryItem> _items = [];
    public LibraryItem? SelectedItem { get; private set; }
    public string SelectedText { get; private set; } = "";
    public LibraryWindow(DocumentLibraryService library) { InitializeComponent(); _library = library; Loaded += async (_, _) => await ReloadAsync(); }
    private void TitleBarMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2) { ToggleMaximizeWindow(sender, e); return; }
        if (e.LeftButton == MouseButtonState.Pressed) DragMove();
    }
    private void MinimizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void ToggleMaximizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void CloseChrome(object sender, RoutedEventArgs e) => Close();
    private async Task ReloadAsync()
    {
        var selectedTag = TagFilter.SelectedItem as string ?? "全部标签";
        _items = await _library.ListAsync();
        var tags = _items.SelectMany(item => item.Tags ?? []).Distinct(StringComparer.CurrentCultureIgnoreCase).OrderBy(value => value, StringComparer.CurrentCultureIgnoreCase).ToList();
        TagFilter.ItemsSource = new[] { "全部标签", "未分类" }.Concat(tags).ToList();
        TagFilter.SelectedItem = TagFilter.Items.Cast<string>().FirstOrDefault(value => string.Equals(value, selectedTag, StringComparison.CurrentCultureIgnoreCase)) ?? "全部标签";
        ApplyFilter();
    }
    private void ApplyFilter()
    {
        var query = SearchBox.Text.Trim();
        IEnumerable<LibraryItem> shown = _items;
        if (!string.IsNullOrWhiteSpace(query)) shown = shown.Where(item =>
            item.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
            (item.Tags ?? []).Any(tag => tag.Contains(query, StringComparison.CurrentCultureIgnoreCase)));
        var tagFilter = TagFilter.SelectedItem as string ?? "全部标签";
        if (tagFilter == "未分类") shown = shown.Where(item => item.Tags is not { Count: > 0 });
        else if (tagFilter != "全部标签") shown = shown.Where(item => (item.Tags ?? []).Contains(tagFilter, StringComparer.CurrentCultureIgnoreCase));
        var sort = (SortBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "opened";
        shown = sort switch
        {
            "imported" => shown.OrderByDescending(item => item.ImportedAt),
            "name" => shown.OrderBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase),
            "chars" => shown.OrderByDescending(item => item.CharacterCount),
            "size" => shown.OrderByDescending(item => item.FileSize),
            _ => shown.OrderByDescending(item => item.LastOpenedAt)
        };
        var list = shown.ToList();
        LibraryList.ItemsSource = list;
        CountText.Text = tagFilter == "全部标签" ? $"共 {list.Count} 个文件" : $"{tagFilter} · {list.Count} 个文件";
    }
    private void SearchChanged(object sender, TextChangedEventArgs e) { if (IsLoaded) ApplyFilter(); }
    private void FilterChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) ApplyFilter(); }
    private void SelectOnRightClick(object sender, MouseButtonEventArgs e)
    {
        var element = e.OriginalSource as DependencyObject;
        while (element is not null && element is not ListBoxItem) element = System.Windows.Media.VisualTreeHelper.GetParent(element);
        if (element is ListBoxItem item) item.IsSelected = true;
    }
    private async void OpenSelected(object sender, RoutedEventArgs e)
    {
        if (LibraryList.SelectedItem is not LibraryItem item) { System.Windows.MessageBox.Show("请先选择一个文件。", "文件库", MessageBoxButton.OK, MessageBoxImage.Information); return; }
        try { SelectedText = await _library.ReadTextAsync(item); SelectedItem = item; DialogResult = true; }
        catch (Exception ex) { System.Windows.MessageBox.Show(ex.Message, "无法打开文件", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }
    private void OpenSelected(object sender, MouseButtonEventArgs e) { if (e.ChangedButton == MouseButton.Left) OpenSelected(sender, new RoutedEventArgs()); }
    private async void DeleteSelected(object sender, RoutedEventArgs e)
    {
        if (LibraryList.SelectedItem is not LibraryItem item) return;
        if (System.Windows.MessageBox.Show($"确定把“{item.Name}”移到文件库回收站吗？之后仍可恢复。", "移到回收站", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        await _library.DeleteAsync(item); await ReloadAsync();
    }
    private async void ReextractSelected(object sender, RoutedEventArgs e)
    {
        if (LibraryList.SelectedItem is not LibraryItem item) return;
        var choice = System.Windows.MessageBox.Show("重新提取会更新文件库中的原文。\n\n选择“是”：保留已有 AI 结果；\n选择“否”：同时清除旧 AI 结果；\n选择“取消”：不执行。", "重新提取全文", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
        if (choice == MessageBoxResult.Cancel) return;
        try
        {
            await _library.ReextractAsync(item, clearSavedResults: choice == MessageBoxResult.No);
            await ReloadAsync();
            System.Windows.MessageBox.Show("全文已重新提取。", "文件库", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex) { System.Windows.MessageBox.Show(ex.Message, "重新提取失败", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }
    private async void OpenTrash(object sender, RoutedEventArgs e)
    {
        var dialog = new LibraryTrashWindow(_library) { Owner = this };
        dialog.ShowDialog();
        if (dialog.Changed) await ReloadAsync();
    }
    private async void EditSelected(object sender, RoutedEventArgs e)
    {
        if (LibraryList.SelectedItem is not LibraryItem item)
        {
            System.Windows.MessageBox.Show("请先选择一个文件。", "文件库", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var dialog = new LibraryItemEditWindow(item) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        try
        {
            await _library.UpdateMetadataAsync(item, dialog.ItemName, dialog.Tags);
            await ReloadAsync();
            LibraryList.SelectedItem = _items.FirstOrDefault(value => value.Id == item.Id);
        }
        catch (Exception ex) { System.Windows.MessageBox.Show(ex.Message, "无法保存文件信息", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }
    private void CloseWindow(object sender, RoutedEventArgs e) => Close();
}
