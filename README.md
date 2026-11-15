# 阅桥 ReadBridge

基于开源大模型的认知无障碍网页重构系统，帮助用户理解复杂网页，提供主题卡片、重点、难词解释、原文定位和语音阅读。

## 日常启动（推荐）

普通使用不需要在源码目录中寻找多个入口。直接打开根目录的 `启动阅桥` 文件夹，双击：

```text
一键启动阅桥.cmd
```

它会分别打开本机 FastAPI 后端和 Windows 桌面客户端。也可使用同一目录中的编号入口，只启动需要的部分。

## 首次使用教程（从这里开始）

以下步骤在Windows PowerShell操作。首次安装依次完成；已有环境和 `.env` 请保留。普通使用需要Python（推荐3.12）与Chrome或Edge；Node.js只用于开发检查。

### 1. 进入项目并检查Python

```powershell
cd E:\AYQ\easyread
python --version
```

其他电脑请替换为实际项目路径。PowerShell不要使用 `cd /d`；不要复制命令前的 `PS ...>` 提示符。

### 2. 创建环境、安装依赖

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.txt
```

已有可用 `.venv` 可跳过创建命令。虚拟环境不能从其他电脑直接复制。后续直接调用其中的Python，无需激活环境。

### 3. 创建并打开配置文件

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

**唯一实际配置位置：`E:\AYQ\easyread\.env`，与本README同级。** 不要保存为 `.env.txt`，不要在 `apps/api/server/` 内另建配置。`apps/api/server/.env.example` 只是旧入口说明。

首次建议保留 `AI_PROVIDER=mock`、`TTS_PROVIDER=browser`，先跑通交互，无需Key。Mock的解释是规则模拟。要使用真实AI，再完成下一步。

### 4. 配置真实Qwen（离线演示可跳过）

在自己的百炼账号中创建API Key，并获取所属地域、业务空间的 **OpenAI兼容 API Host**。在刚打开的本地 `.env` 中修改已有字段：

```dotenv
AI_PROVIDER=qwen
QWEN_API_KEY=
QWEN_MODEL=qwen-plus
QWEN_BASE_URL=
TTS_PROVIDER=browser
```

把自己的密钥填在 `QWEN_API_KEY=` 后，把账号支持的模型名填入 `QWEN_MODEL`，把完整OpenAI兼容地址填入 `QWEN_BASE_URL`。地址不要附加 `/chat/completions`，不要使用原生DashScope接口或聊天网页地址。保存文件。

密钥仅保存在本地 `.env`，不要发到聊天或写入插件。首次语音使用系统语音即可。真实CosyVoice为可选功能，需另外配置音频服务地址，详见 [配置手册](docs/CONFIGURATION.md)。

### 5. 启动后端并确认状态

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.main:app --app-dir apps/api --host 127.0.0.1 --port 8000
```

看到 `Uvicorn running on http://127.0.0.1:8000` 后保留终端。在**浏览器地址栏**打开 `http://127.0.0.1:8000/health`；不要在PowerShell直接输入 `/health`。

应返回 `status: ok`。离线模式显示 `provider: mock`，真实模式显示 `provider: qwen`。健康检查只说明服务启动，实际生成内容才会验证模型调用。

### 6. 加载Chrome或Edge插件

1. 地址栏打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载未打包的扩展程序”。
4. 选择 **`E:\AYQ\easyread\apps\browser-extension`**，其中应直接包含 `manifest.json`。不要选择 `easyread` 根目录。
5. 确认出现“阅桥 - AI认知无障碍阅读助手”，可固定到工具栏。
6. 刷新已打开的文章页，让插件生效。

### 7. 第一次功能测试

1. 打开普通HTTP/HTTPS文章页，不要在浏览器设置、扩展管理页面或PDF阅读器中测试。
2. 鼠标选中一段正文，点击“简单解释”。
3. 确认右侧出现原文、简单解释、关键词和示例。
4. 点击工具栏阅桥图标，再点击“一键易读”。
5. 结果生成后试用原文定位、逐段阅读与朗读。

真实模型可能需要等待几十秒，长文可能自动精简重试一次。失败时查看界面的具体错误并保留 `request_id`。

### 以后启动、重启与常见问题

每天使用只需进入项目并运行第5步命令，插件不用重复安装。若 PowerShell 禁止运行 `.ps1`，请使用 `tools\start.cmd`；它只为本次启动使用 Bypass，不会修改系统执行策略。修改 `.env` 后，在后端终端按 `Ctrl+C`，再重新运行启动命令。修改插件文件后，在扩展管理页点击“重新加载”，然后刷新文章。

| 现象 | 如何处理 |
| --- | --- |
| 找不到虚拟环境Python | 检查当前目录，完成第2步 |
| No module named uvicorn | 用第2步的虚拟环境Python安装依赖，并用它启动 |
| WinError 10048 / 8000被占用 | 检查 `/health`，关闭之前自己启动的后端再重启，避免重复运行 |
| 127.0.0.1拒绝连接 | 后端未运行或已退出，检查终端错误 |
| provider仍为mock | 修改根目录 `.env` 并重启后端 |
| 清单文件缺失 | 应加载 `extension` 文件夹 |
| 没有选词按钮 | 确认扩展启用，刷新普通文章页面 |
| 认证失败或额度不足 | 检查本地Key、模型权限和业务空间额度 |

## 项目导航

```text
apps/
  api/                    FastAPI 后端与 Python 依赖
  browser-extension/      Chrome / Edge 扩展
  windows-desktop/        Windows WPF 客户端
tests/                    跨端测试、夹具与历史结果
tools/                    启动、检查和打包脚本
docs/                     配置与使用文档
artifacts/                构建产物和历史发布物
启动阅桥/                 集中的日常启动入口
.env / .env.example       本机配置与无密钥模板
LICENSE / NOTICE          授权与第三方说明
```

完整操作与参数说明见 [配置与使用手册](docs/CONFIGURATION.md)。

## 快速开始

推荐 Python 3.12，Windows PowerShell：

```powershell
cd E:\AYQ\easyread
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\tools\start.cmd
```

已有环境与 `.env` 请直接保留。模板默认 Mock AI 与系统语音；真实认知重构需要在本地 `.env` 配置 Qwen。

打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，加载 **apps/browser-extension 文件夹**。打开文章，点击“一键易读”；或选中文字后点击“简单解释”。

## 核心代码

| 文件 | 职责 |
| --- | --- |
| apps/browser-extension/manifest.json | 插件入口、权限、加载顺序 |
| apps/browser-extension/content.js | 阅读界面与交互 |
| apps/browser-extension/extractor.js | 正文提取与内容块锚点 |
| apps/browser-extension/source-locator.js | 原文定位 |
| apps/browser-extension/speech.js | 系统和神经语音播放器 |
| apps/browser-extension/background.js | 后端请求与取消 |
| apps/windows-desktop/ReadBridge.Desktop | Windows 托盘、UI Automation、框选 OCR 与桌面语音 |
| apps/api/server/main.py | API路由、CORS与生命周期 |
| apps/api/server/config.py / models.py | 环境配置和数据契约 |
| apps/api/server/ai.py / qwen_provider.py | Mock与真实Qwen |
| apps/api/server/coverage.py / easy_read_quality.py | 主题覆盖和证据校验 |
| apps/api/server/tts.py / performance.py | 音频生成、缓存与计时 |

数据流：网页 → 提取器 → 扩展后台 → FastAPI → Provider → JSON或音频 → 阅读界面。现有API路径与运行模块保持稳定。

## 测试与参赛提交

```powershell
.\tools\check.ps1
.\tools\package.ps1
```

验证脚本需要 Node.js。提交包生成在 `artifacts/ReadBridge-submission.zip`，采用白名单排除 `.env`、虚拟环境、浏览器用户数据和缓存。

建议演示：选词解释 → 一键易读 → 原文定位 → 逐段阅读 → 浮动窗口 → 语音暂停与停止。展示 `/health` 说明实际Provider。Mock是规则演示，Mock TTS是测试音；真实AI需要凭据与网络。图片多模态尚未接入，长文受预算限制，AI结论应核对原文。目前没有目标人群临床效果验证。


