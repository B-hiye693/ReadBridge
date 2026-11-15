using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Media;

namespace ReadBridge.Desktop;

internal sealed class SpeechService : IDisposable
{
    private readonly MediaPlayer _player = new();
    private readonly List<string> _queue = [];
    private int _queueIndex, _generation;
    private bool _producerComplete, _waitingForAudio;
    private string _fallbackText = "";
    private double _fallbackRate = 1.0;
    private dynamic? _sapi;

    public SpeechService() => _player.MediaEnded += (_, _) => PlayNext(_generation);

    public async Task<string> SpeakAsync(string text, ApiClient api, string language, string voice, double rate, CancellationToken token)
    {
        Stop();
        var generation = _generation;
        // 较短的首段能显著降低第一次听到声音的等待；后续合成与播放并行。
        var chunks = SplitForSpeech(text, 360);
        try
        {
            var firstPath = await FetchAudioFileAsync(chunks[0], api, language, voice, rate, token);
            token.ThrowIfCancellationRequested();
            if (generation != _generation) throw new OperationCanceledException(token);
            _queue.Add(firstPath);
            _queueIndex = 0;
            _producerComplete = chunks.Count == 1;
            PlayCurrent(generation);
            if (chunks.Count > 1)
                _ = PrefetchRemainingAsync(chunks, 1, api, language, voice, rate, token, generation);
            return chunks.Count == 1 ? "正在使用后端神经语音朗读" : $"神经语音已开始，正在后台准备后续 {chunks.Count - 1} 段";
        }
        catch (OperationCanceledException) { CleanupQueue(); throw; }
        catch (Exception ex)
        {
            CleanupQueue();
            _sapi = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpVoice")!)!;
            _sapi.Rate = (int)Math.Clamp(Math.Round((rate - 1.0) * 5), -5, 5);
            _sapi.Speak(text, 1);
            return "神经语音重试后仍不可用，已回退到 Windows 系统语音。原因：" + ex.Message;
        }
    }

    private static async Task<string> FetchAudioFileAsync(string chunk, ApiClient api, string language, string voice, double rate, CancellationToken token)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                var result = await api.SpeechAsync(chunk, language, voice, rate, token);
                if (result.Audio.Length == 0) throw new InvalidOperationException("神经语音没有返回音频数据。");
                var path = Path.Combine(Path.GetTempPath(), $"readbridge-{Guid.NewGuid():N}{(result.MediaType.Contains("wav") ? ".wav" : ".mp3")}");
                await File.WriteAllBytesAsync(path, result.Audio, token);
                return path;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { lastError = ex; if (attempt == 0) await Task.Delay(350, token); }
        }
        throw lastError ?? new InvalidOperationException("神经语音生成失败。");
    }

    private async Task PrefetchRemainingAsync(List<string> chunks, int startIndex, ApiClient api, string language, string voice, double rate, CancellationToken token, int generation)
    {
        for (var index = startIndex; index < chunks.Count; index++)
        {
            try
            {
                var path = await FetchAudioFileAsync(chunks[index], api, language, voice, rate, token);
                if (generation != _generation || token.IsCancellationRequested) { try { File.Delete(path); } catch { } return; }
                _queue.Add(path);
                if (_waitingForAudio) { _waitingForAudio = false; PlayCurrent(generation); }
            }
            catch (OperationCanceledException) { return; }
            catch
            {
                if (generation == _generation)
                {
                    _fallbackText = string.Join(" ", chunks.Skip(index));
                    _fallbackRate = rate;
                    _producerComplete = true;
                    if (_waitingForAudio) StartSystemFallback(generation);
                }
                return;
            }
        }
        if (generation == _generation)
        {
            _producerComplete = true;
            if (_waitingForAudio) CleanupQueue();
        }
    }

    private void PlayCurrent(int generation)
    {
        if (generation != _generation || _queueIndex >= _queue.Count) { CleanupQueue(); return; }
        _player.Open(new Uri(_queue[_queueIndex]));
        _player.Play();
    }
    private void PlayNext(int generation)
    {
        if (generation != _generation) return;
        DeleteFile(_queueIndex);
        _queueIndex++;
        if (_queueIndex < _queue.Count) { PlayCurrent(generation); return; }
        if (_fallbackText.Length > 0) { StartSystemFallback(generation); return; }
        if (_producerComplete) { CleanupQueue(); return; }
        _waitingForAudio = true;
    }
    private void StartSystemFallback(int generation)
    {
        if (generation != _generation || _fallbackText.Length == 0) return;
        var remaining = _fallbackText; _fallbackText = ""; _waitingForAudio = false;
        _sapi = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpVoice")!)!;
        _sapi.Rate = (int)Math.Clamp(Math.Round((_fallbackRate - 1.0) * 5), -5, 5);
        _sapi.Speak(remaining, 1);
        CleanupQueue();
    }
    private static List<string> SplitForSpeech(string text, int limit)
    {
        text = text.Trim();
        var result = new List<string>();
        while (text.Length > limit)
        {
            var cut = text.LastIndexOfAny(['。', '！', '？', '.', '!', '?', ';', '；', '\n'], limit - 1, limit);
            if (cut < limit / 3) cut = text.LastIndexOfAny(['，', ',', ' '], limit - 1, limit);
            if (cut < limit / 3) cut = limit - 1;
            cut++;
            result.Add(text[..cut].Trim());
            text = text[cut..].TrimStart();
        }
        if (text.Length > 0) result.Add(text);
        return result;
    }
    public void Stop()
    {
        _generation++;
        _producerComplete = true; _waitingForAudio = false; _fallbackText = "";
        _player.Stop(); _player.Close();
        try { _sapi?.Speak("", 3); } catch { }
        if (_sapi is not null) { try { Marshal.FinalReleaseComObject(_sapi); } catch { } _sapi = null; }
        CleanupQueue();
    }
    private void CleanupQueue()
    {
        for (var i = 0; i < _queue.Count; i++) DeleteFile(i);
        _queue.Clear(); _queueIndex = 0;
    }
    private void DeleteFile(int index)
    {
        if (index < 0 || index >= _queue.Count) return;
        try { File.Delete(_queue[index]); } catch { }
    }
    public void Dispose() { Stop(); _player.Close(); }
}
