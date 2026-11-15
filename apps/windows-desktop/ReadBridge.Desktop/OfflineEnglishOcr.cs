using System.IO;

namespace ReadBridge.Desktop;

internal static class OfflineEnglishOcr
{
    internal static string Recognize(byte[] imageBytes)
    {
        var dataPath = Path.Combine(AppContext.BaseDirectory, "tessdata");
        var modelPath = Path.Combine(dataPath, "eng.traineddata");
        if (!File.Exists(modelPath)) throw new FileNotFoundException("缺少随程序发布的 eng.traineddata 模型。", modelPath);
        using var engine = new TesseractOCR.Engine(dataPath, TesseractOCR.Enums.Language.English, TesseractOCR.Enums.EngineMode.Default);
        using var image = TesseractOCR.Pix.Image.LoadFromMemory(imageBytes);
        using var page = engine.Process(image, TesseractOCR.Enums.PageSegMode.Auto);
        return page.Text?.Trim() ?? "";
    }
}
