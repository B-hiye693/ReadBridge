using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace ReadBridge.Desktop;

public sealed class LibraryItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string OriginalName { get; set; } = "";
    public List<string> Tags { get; set; } = [];
    public string Extension { get; set; } = "";
    public string StoredFile { get; set; } = "";
    public string StoredText { get; set; } = "";
    public string StoredAnalysis { get; set; } = "";
    public int CharacterCount { get; set; }
    public long FileSize { get; set; }
    public DateTime ImportedAt { get; set; }
    public DateTime LastOpenedAt { get; set; }
    public string Language { get; set; } = "";
    public int SavedResultCount { get; set; }
    public string DisplayMeta => $"{Extension.TrimStart('.').ToUpperInvariant()}  ·  {CharacterCount:N0} 字符  ·  已保存 {SavedResultCount} 项 AI 结果  ·  {ImportedAt:yyyy-MM-dd HH:mm}";
    public string TagsDisplay => Tags is { Count: > 0 } ? string.Join("  ·  ", Tags.Select(tag => "# " + tag)) : "未分类";
}
public sealed class LibraryTrashEntry
{
    public string TrashFolder { get; set; } = "";
    public LibraryItem Item { get; set; } = new();
    public DateTime DeletedAt { get; set; }
    public string DisplayMeta => $"删除于 {DeletedAt:yyyy-MM-dd HH:mm}  ·  {Item.Extension.TrimStart('.').ToUpperInvariant()}  ·  {Item.CharacterCount:N0} 字符";
}

public sealed class DocumentLibraryService
{
    private readonly string _root;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string IndexPath => Path.Combine(_root, "index.json");
    private string FilesPath => Path.Combine(_root, "files");
    private string TextsPath => Path.Combine(_root, "texts");
    private string AnalysesPath => Path.Combine(_root, "analyses");
    private string TrashPath => Path.Combine(_root, "trash");
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    public DocumentLibraryService(string? root = null) => _root = root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReadBridge", "library");

    public async Task<LibraryItem> AddOrUpdateAsync(string sourcePath, string extractedText, CancellationToken token)
    {
        var bytes = await File.ReadAllBytesAsync(sourcePath, token);
        var id = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..20];
        await _gate.WaitAsync(token);
        try
        {
            EnsureDirectories();
            var items = await LoadUnsafeAsync(token);
            var existing = items.FirstOrDefault(item => item.Id == id);
            var info = new FileInfo(sourcePath);
            var extension = info.Extension.ToLowerInvariant();
            var storedFile = Path.Combine(FilesPath, id + extension);
            var storedText = Path.Combine(TextsPath, id + ".txt");
            var storedAnalysis = Path.Combine(AnalysesPath, id + ".json");
            if (!File.Exists(storedFile)) await File.WriteAllBytesAsync(storedFile, bytes, token);
            await File.WriteAllTextAsync(storedText, extractedText, token);
            var now = DateTime.Now;
            var item = existing ?? new LibraryItem { Id = id, ImportedAt = now, Name = info.Name, OriginalName = info.Name };
            if (string.IsNullOrWhiteSpace(item.Name)) item.Name = info.Name;
            if (string.IsNullOrWhiteSpace(item.OriginalName)) item.OriginalName = info.Name;
            item.Tags ??= [];
            item.Extension = extension; item.StoredFile = storedFile; item.StoredText = storedText; item.StoredAnalysis = storedAnalysis;
            item.CharacterCount = extractedText.Length; item.FileSize = info.Length; item.LastOpenedAt = now;
            item.Language = LanguageDetector.Detect(extractedText);
            if (existing is null) items.Add(item);
            await SaveUnsafeAsync(items, token);
            return item;
        }
        finally { _gate.Release(); }
    }

    public async Task<LibraryAnalysis> ReadAnalysisAsync(LibraryItem item, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            EnsureDirectories();
            var path = AnalysisPath(item);
            if (!File.Exists(path)) return new();
            return await ReadJsonWithBackupAsync(path, new LibraryAnalysis(), token);
        }
        finally { _gate.Release(); }
    }

    public Task SaveEasyReadAsync(LibraryItem item, string language, EasyReadDocument document, CancellationToken token = default) =>
        UpdateAnalysisAsync(item, analysis =>
        {
            analysis.EasyReadResults[language] = document;
            analysis.LastResultKind = "easy-read";
            analysis.LastResultKey = language;
        }, token);

    public Task SaveExplanationAsync(LibraryItem item, string text, string language, ExplainDocument document, CancellationToken token = default) =>
        UpdateAnalysisAsync(item, analysis =>
        {
            analysis.Explanations.RemoveAll(value => value.Text == text && value.OutputLanguage == language);
            analysis.Explanations.Insert(0, new SavedExplanation { Text = text, OutputLanguage = language, Result = document.PlainText, Document = document, SavedAt = DateTime.Now });
            if (analysis.Explanations.Count > 50) analysis.Explanations.RemoveRange(50, analysis.Explanations.Count - 50);
            analysis.LastResultKind = "explain";
            analysis.LastResultKey = language + "\n" + text;
        }, token);

    private async Task UpdateAnalysisAsync(LibraryItem item, Action<LibraryAnalysis> update, CancellationToken token)
    {
        await _gate.WaitAsync(token);
        try
        {
            EnsureDirectories();
            var items = await LoadUnsafeAsync(token);
            var current = items.FirstOrDefault(value => value.Id == item.Id) ?? throw new InvalidOperationException("文件库记录不存在。");
            var path = AnalysisPath(current);
            LibraryAnalysis analysis;
            analysis = await ReadJsonWithBackupAsync(path, new LibraryAnalysis(), token);
            update(analysis);
            await WriteJsonSafelyAsync(path, analysis, token);
            current.StoredAnalysis = path;
            current.SavedResultCount = analysis.EasyReadResults.Count + analysis.Explanations.Count;
            await SaveUnsafeAsync(items, token);
            item.StoredAnalysis = current.StoredAnalysis;
            item.SavedResultCount = current.SavedResultCount;
        }
        finally { _gate.Release(); }
    }

    public async Task<List<LibraryItem>> ListAsync(CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try { EnsureDirectories(); return (await LoadUnsafeAsync(token)).OrderByDescending(item => item.LastOpenedAt).ToList(); }
        finally { _gate.Release(); }
    }

    public async Task UpdateMetadataAsync(LibraryItem item, string name, IEnumerable<string> tags, CancellationToken token = default)
    {
        var cleanedName = name.Trim();
        if (string.IsNullOrWhiteSpace(cleanedName)) throw new InvalidOperationException("文件名称不能为空。");
        if (cleanedName.Length > 180) throw new InvalidOperationException("文件名称不能超过 180 个字符。");
        var cleanedTags = tags.Select(value => value.Trim().TrimStart('#'))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.CurrentCultureIgnoreCase).Take(12).ToList();
        if (cleanedTags.Any(value => value.Length > 30)) throw new InvalidOperationException("每个标签不能超过 30 个字符。");
        await _gate.WaitAsync(token);
        try
        {
            var items = await LoadUnsafeAsync(token);
            var current = items.FirstOrDefault(value => value.Id == item.Id) ?? throw new InvalidOperationException("文件库记录不存在。");
            current.Name = cleanedName;
            current.Tags = cleanedTags;
            await SaveUnsafeAsync(items, token);
            item.Name = cleanedName;
            item.Tags = cleanedTags;
        }
        finally { _gate.Release(); }
    }

    public async Task<string> ReadTextAsync(LibraryItem item, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            var items = await LoadUnsafeAsync(token);
            var current = items.FirstOrDefault(value => value.Id == item.Id) ?? throw new InvalidOperationException("文件库记录不存在。");
            if (!File.Exists(current.StoredText)) throw new InvalidOperationException("文件库中的文本副本已丢失。");
            var text = await File.ReadAllTextAsync(current.StoredText, token);
            current.LastOpenedAt = DateTime.Now;
            await SaveUnsafeAsync(items, token);
            return text;
        }
        finally { _gate.Release(); }
    }

    public async Task<string> ReextractAsync(LibraryItem item, bool clearSavedResults, CancellationToken token = default)
    {
        string sourcePath;
        await _gate.WaitAsync(token);
        try
        {
            var items = await LoadUnsafeAsync(token);
            sourcePath = (items.FirstOrDefault(value => value.Id == item.Id) ?? throw new InvalidOperationException("文件库记录不存在。")).StoredFile;
        }
        finally { _gate.Release(); }
        if (!File.Exists(sourcePath)) throw new InvalidOperationException("文件库中的原文件副本已丢失。");
        var text = await DocumentImportService.ReadAsync(sourcePath, token);
        await _gate.WaitAsync(token);
        try
        {
            var items = await LoadUnsafeAsync(token);
            var current = items.First(value => value.Id == item.Id);
            await File.WriteAllTextAsync(current.StoredText, text, token);
            current.CharacterCount = text.Length;
            current.Language = LanguageDetector.Detect(text);
            if (clearSavedResults)
            {
                var analysisPath = AnalysisPath(current);
                if (File.Exists(analysisPath)) File.Delete(analysisPath);
                if (File.Exists(analysisPath + ".bak")) File.Delete(analysisPath + ".bak");
                current.SavedResultCount = 0;
            }
            await SaveUnsafeAsync(items, token);
            item.CharacterCount = current.CharacterCount; item.Language = current.Language; item.SavedResultCount = current.SavedResultCount;
            return text;
        }
        finally { _gate.Release(); }
    }

    public async Task DeleteAsync(LibraryItem item, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            var items = await LoadUnsafeAsync(token);
            var current = items.FirstOrDefault(value => value.Id == item.Id);
            if (current is null) return;
            var trashFolder = Path.Combine(TrashPath, $"{DateTime.UtcNow:yyyyMMddHHmmssfff}-{current.Id}");
            Directory.CreateDirectory(trashFolder);
            foreach (var path in new[] { current.StoredFile, current.StoredText, AnalysisPath(current), AnalysisPath(current) + ".bak" })
                if (File.Exists(path)) File.Copy(path, Path.Combine(trashFolder, Path.GetFileName(path)), true);
            await File.WriteAllTextAsync(Path.Combine(trashFolder, "item.json"), JsonSerializer.Serialize(new LibraryTrashEntry { TrashFolder = trashFolder, Item = current, DeletedAt = DateTime.Now }, JsonOptions), token);
            items.Remove(current);
            await SaveUnsafeAsync(items, token);
            if (File.Exists(current.StoredFile)) File.Delete(current.StoredFile);
            if (File.Exists(current.StoredText)) File.Delete(current.StoredText);
            var analysisPath = AnalysisPath(current);
            if (File.Exists(analysisPath)) File.Delete(analysisPath);
            if (File.Exists(analysisPath + ".bak")) File.Delete(analysisPath + ".bak");
        }
        finally { _gate.Release(); }
    }

    public async Task<List<LibraryTrashEntry>> ListTrashAsync(CancellationToken token = default)
    {
        EnsureDirectories();
        var result = new List<LibraryTrashEntry>();
        foreach (var metadata in Directory.EnumerateFiles(TrashPath, "item.json", SearchOption.AllDirectories))
        {
            try
            {
                var entry = JsonSerializer.Deserialize<LibraryTrashEntry>(await File.ReadAllTextAsync(metadata, token));
                if (entry is not null) { entry.TrashFolder = Path.GetDirectoryName(metadata)!; result.Add(entry); }
            }
            catch (JsonException) { }
        }
        return result.OrderByDescending(value => value.DeletedAt).ToList();
    }

    public async Task RestoreAsync(LibraryTrashEntry entry, CancellationToken token = default)
    {
        await _gate.WaitAsync(token);
        try
        {
            EnsureDirectories();
            var items = await LoadUnsafeAsync(token);
            if (items.Any(value => value.Id == entry.Item.Id)) throw new InvalidOperationException("文件库中已经存在相同文件。");
            foreach (var destination in new[] { entry.Item.StoredFile, entry.Item.StoredText, AnalysisPath(entry.Item), AnalysisPath(entry.Item) + ".bak" })
            {
                var source = Path.Combine(entry.TrashFolder, Path.GetFileName(destination));
                if (File.Exists(source)) { Directory.CreateDirectory(Path.GetDirectoryName(destination)!); File.Copy(source, destination, true); }
            }
            entry.Item.LastOpenedAt = DateTime.Now;
            items.Add(entry.Item);
            await SaveUnsafeAsync(items, token);
            Directory.Delete(entry.TrashFolder, true);
        }
        finally { _gate.Release(); }
    }

    public Task DeletePermanentlyAsync(LibraryTrashEntry entry)
    {
        if (Directory.Exists(entry.TrashFolder)) Directory.Delete(entry.TrashFolder, true);
        return Task.CompletedTask;
    }

    private string AnalysisPath(LibraryItem item) => !string.IsNullOrWhiteSpace(item.StoredAnalysis) ? item.StoredAnalysis : Path.Combine(AnalysesPath, item.Id + ".json");
    private void EnsureDirectories() { Directory.CreateDirectory(_root); Directory.CreateDirectory(FilesPath); Directory.CreateDirectory(TextsPath); Directory.CreateDirectory(AnalysesPath); Directory.CreateDirectory(TrashPath); }
    private async Task<List<LibraryItem>> LoadUnsafeAsync(CancellationToken token)
    {
        if (!File.Exists(IndexPath)) return [];
        try
        {
            var items = await ReadJsonWithBackupAsync(IndexPath, new List<LibraryItem>(), token);
            foreach (var item in items)
            {
                item.Tags ??= [];
                if (string.IsNullOrWhiteSpace(item.OriginalName)) item.OriginalName = item.Name;
            }
            return items;
        }
        catch (JsonException ex) { throw new InvalidOperationException("文件库索引已损坏，且备份也无法恢复。原文件仍保留在本机文件库目录中。", ex); }
    }
    private async Task SaveUnsafeAsync(List<LibraryItem> items, CancellationToken token)
    {
        await WriteJsonSafelyAsync(IndexPath, items, token);
    }
    private static async Task<T> ReadJsonWithBackupAsync<T>(string path, T fallback, CancellationToken token)
    {
        if (!File.Exists(path)) return fallback;
        try { return JsonSerializer.Deserialize<T>(await File.ReadAllTextAsync(path, token)) ?? fallback; }
        catch (JsonException)
        {
            var backup = path + ".bak";
            if (!File.Exists(backup)) throw;
            return JsonSerializer.Deserialize<T>(await File.ReadAllTextAsync(backup, token)) ?? fallback;
        }
    }
    private static async Task WriteJsonSafelyAsync<T>(string path, T value, CancellationToken token)
    {
        var temporary = path + ".tmp";
        if (File.Exists(path)) File.Copy(path, path + ".bak", true);
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, JsonOptions), token);
        File.Move(temporary, path, true);
    }
}
