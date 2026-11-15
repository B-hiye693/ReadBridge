# 应用目录

每个子目录都是可独立运行或加载的应用端：

| 目录 | 框架 | 入口 |
| --- | --- | --- |
| `api/` | Python + FastAPI | `server/main.py` |
| `browser-extension/` | Chrome Manifest V3 | `manifest.json` |
| `windows-desktop/` | C# + WPF / .NET 10 | `ReadBridge.Desktop/ReadBridge.Desktop.csproj` |

三端共享根目录 `.env` 中的后端配置，浏览器扩展和桌面客户端默认访问 `http://127.0.0.1:8000`。
