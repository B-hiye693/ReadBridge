# 阅桥 ReadBridge 配置与使用手册

首次安装请按 [根目录README](../README.md) 的7步教程操作。本页用于查阅高级配置；实际配置统一保存在项目根目录 `.env`，修改后须重启后端。

> 基于开源大模型的认知无障碍网页重构系统，并支持可替换的自然语音朗读。

## 语音朗读

阅桥现在通过统一 `SpeechManager` 保留全部朗读、单段朗读、暂停、继续、停止、上一部分、下一部分、语速、高亮和自动滚动功能，并提供两条语音路径：

- `BrowserSpeechProvider`：浏览器系统语音，默认启用、离线可用、无需密钥。会优先选择 Microsoft/Google 的中文 Natural/Neural 音色，默认语速为 0.9。
- `NeuralTTSProvider`：扩展经 `background.js` 调用本机 FastAPI，再由后端 TTS Provider 生成音频。密钥不会进入扩展。

后端 `TTS_PROVIDER` 支持：

- `browser`：默认值，后端不生成音频，扩展使用 SpeechSynthesis。
- `mock`：开发测试用途，返回可播放 WAV 测试音；它不是真人语音。
- `cosyvoice`：使用阿里云百炼 CosyVoice 官方 HTTP API，返回真实神经语音。

长内容会在前端按自然句子切为约 150～300 字的片段，只请求当前片段并预取下一片段。后端以内存 LRU 缓存音频，缓存键包含 Provider、模型、音色、语速、风格与文本哈希，停止或关闭侧边栏会取消未完成请求并释放临时音频 URL。

### 配置真实 CosyVoice

1. 在阿里云百炼控制台创建 API Key，并确认所用业务空间支持 CosyVoice。
2. 将 `.env.example` 复制为 `.env`。
3. 在本地 `.env` 配置：

```dotenv
TTS_PROVIDER=cosyvoice
TTS_MODEL=cosyvoice-v3-flash
TTS_API_KEY=在本机填写真实Key
TTS_BASE_URL=https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
TTS_VOICE=longyingling_v3
TTS_TIMEOUT_SECONDS=60
TTS_AUDIO_FORMAT=mp3
```

`TTS_API_KEY` 留空时会复用 `QWEN_API_KEY`。`TTS_BASE_URL` 必须是完整的 CosyVoice HTTP SpeechSynthesizer 地址，不能填写 OpenAI 兼容地址 `/compatible-mode/v1`，也不能只填写域名。默认模型与音色组合为 `cosyvoice-v3-flash` + `longyingling_v3`（温和共情女声）；也提供亲切女声、沉稳男声和温暖男声。当前四个默认音色在官方列表中均不支持 Instruct，因此阅桥不会向它们发送 `instruction`；只有换成官方明确标注支持 Instruct 的音色时才会发送该字段。

CosyVoice 使用 DashScope 原生非流式 HTTP API，不使用 Qwen 文本模型的 OpenAI 兼容接口。成功响应是 JSON，其中 `output.audio.url` 是有效期有限的音频地址；阅桥会将官方 OSS HTTP 地址升级为 HTTPS，下载后检查 MP3/WAV/OGG 文件签名，再返回给扩展。第三方失败时，后端会记录脱敏后的模型、音色、状态码、错误码、request_id、文本长度和文本哈希，不记录 API Key、Authorization 或完整朗读文本。

如果 `/health` 正常但 `/api/tts` 返回错误，先确认 `TTS_BASE_URL` 末尾是 `/api/v1/services/audio/tts/SpeechSynthesizer`。`QWEN_BASE_URL` 继续使用 `/compatible-mode/v1`，两者不能复制成相同地址。修改 `.env` 后必须完全停止并重新启动 Uvicorn；仅重新加载扩展不会让后端重新读取环境变量。

启动后验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/api/tts/voices
$body = @{text='欢迎使用阅桥。'; language='zh-CN'; voice='longyingling_v3'; rate=0.9; style='warm'} | ConvertTo-Json
Invoke-WebRequest http://127.0.0.1:8000/api/tts -Method Post -ContentType 'application/json' -Body $body -OutFile test.mp3
```

接口：`GET /api/tts/voices` 返回 Provider、默认音色和可用音色；`POST /api/tts` 返回 `audio/mpeg`（或 Provider 实际支持的音频 MIME）。单次文本最多 600 字，语速范围 0.5～2.0，语言、风格和音色标识均经过校验。

项目名称：**阅桥（ReadBridge）——基于开源多模态大模型的认知无障碍网页重构系统**

项目理念：**让信息不止“看得见”，更能“读得懂”。**

阅桥面向阅读障碍、认知阅读困难、复杂文本理解困难以及需要简化信息呈现的人群。它不是把网页读给用户听，而是利用开源 AI 对网页进行理解、信息提取、语言简化和结构重组，把互联网内容转换成用户更容易理解的形式。

## 当前功能

1. 指哪解释哪：解释用户选择的复杂句子，并给出关键词和例子。
2. 一键易读：自动识别正文，按文章主题生成结构化、低认知负担且尽量完整的内容。
3. AI 结构化认知重构，而不是输出一整段普通摘要。
4. 重点信息提取。
5. 难词解释。
6. `A- / A / A+` 字体调整，只影响阅桥侧边栏。
7. “减少内容”模式。
8. “逐段阅读”模式及上一段、下一段控制。
9. 展开查看每个结论对应的原文依据。
10. “文章全貌”目录，可快速跳转到各个易读模块。

## 项目结构

```text
easyread/
├── apps/browser-extension/                 # Chrome Manifest V3 插件
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── content.js             # 选区、正文提取与侧边栏
│   └── background.js
├── apps/api/server/                    # FastAPI AI 后端
│   ├── __init__.py
│   ├── main.py
│   ├── ai.py
│   ├── models.py
│   ├── config.py
│   └── .env.example
├── apps/api/requirements.txt
├── .gitignore
└── README.md
```

数据流：

```text
Chrome Extension
        ↓
FastAPI
        ↓
AI Provider
        ├── MockAIProvider（默认、离线演示）
        └── QwenAIProvider（真实千问 API）
```

## 创建 Python 环境

推荐使用 Python 3.12；当前依赖也兼容 Python 3.9。打开 PowerShell，依次执行：

```powershell
cd E:\AYQ\easyread （项目实际路径）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/api/requirements.txt
```

如果 PowerShell 阻止激活脚本，可直接使用 `.\.venv\Scripts\python.exe` 执行后续命令。

## 启动 FastAPI

在 `easyread` 目录、虚拟环境激活后运行：

```powershell
cd E:\AYQ\easyread（项目实际路径）
.\.venv\Scripts\python.exe -m uvicorn server.main:app --app-dir apps/api --host 127.0.0.1 --port 8000
```

浏览器访问 `http://127.0.0.1:8000/health`，看到 `status: ok` 即表示服务正常。API 文档位于 `http://127.0.0.1:8000/docs`。

## 加载 Chrome 插件

1. 打开 Chrome，在地址栏输入 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `E:\AYQ\easyread\apps\browser-extension` 文件夹。
5. 建议将“阅桥 - AI认知无障碍阅读助手”固定到工具栏。插件弹窗会显示后端连接状态。

修改插件代码后，请在扩展管理页面点击插件卡片上的“重新加载”，并刷新测试网页。Chrome 内置页面、扩展商店和部分受保护页面不允许内容脚本运行，这是浏览器限制。

## 测试“指哪解释哪”

1. 保持 FastAPI 服务运行。
2. 打开一个普通的 `http` 或 `https` 文章页面并刷新。
3. 用鼠标选中一段文字，点击选区附近的“简单解释”。
4. 侧边栏会显示原文、解释、关键词和示例。

## 测试“一键易读”

1. 保持 FastAPI 服务运行并打开普通文章网页。
2. 点击工具栏中的阅桥图标，再点击“一键易读”。
3. 侧边栏依次显示正文提取、文章理解和易读版本生成状态。
4. 查看“全文概览”、动态信息卡片、重点信息和难词解释；桌面端可切换“逐段阅读”。
5. 使用 `A- / A / A+` 调整字号。
6. 打开“减少内容”，确认信息量减少。
7. 打开“逐段阅读”，使用“上一段/下一段”切换。
8. 点击“查看对应原文”核对结论依据。
9. 点击 `×` 或按 `Esc` 关闭侧边栏。

也可以单独测试 API：

```powershell
$body = @{ text = "鉴于近期极端天气频发，为切实保障相关人员生命财产安全，部分道路将暂时关闭。" } | ConvertTo-Json
Invoke-RestMethod -Uri http://127.0.0.1:8000/api/explain -Method Post -ContentType "application/json" -Body $body
```

## API

- `POST /api/explain`：解释用户选中的文字。
- `POST /api/easy-read`：将网页正文认知重构为全文概览、动态信息卡片、重点、难词和行动信息。
- `POST /api/simplify-page`：早期版本兼容路径，新代码应使用 `/api/easy-read`。
- `GET /health`：检查后端与当前 Provider 状态。

`/api/easy-read` 请求字段为 `title`、`text`、`url`；响应主体包含 `title`、`one_sentence`、`sections`、`key_points`、`difficult_words` 和 `action`。每个 section 包含 `icon`、`heading`、`content`、`source_text`；每个 key point 包含 `label`、`value`、`source_text`，便于快速查看并核对原文。

## MockAIProvider

默认配置为 `AI_PROVIDER=mock`，无需 API Key。Mock Provider 会从原文句子中寻找事件、结果、原因、时间、地点和行动线索，返回完整结构化数据。`source_text` 直接取自提交的网页正文；找不到原因时会明确说明原文未提供原因，不会自行编造。

## 使用真实 Qwen 模型

项目同时提供 `MockAIProvider` 和 `QwenAIProvider`。默认仍使用 Mock，切换 Qwen 不需要修改浏览器插件或 API 路径。

1. 在[阿里云百炼控制台](https://bailian.console.aliyun.com/)开通模型服务并创建 API Key。不要把 Key 发到聊天或写入浏览器插件。
2. 在项目根目录复制配置模板：

```powershell
Copy-Item .env.example .env
```

3. 编辑本地 `.env`：

```dotenv
AI_PROVIDER=qwen
QWEN_API_KEY=
QWEN_MODEL=qwen-plus
QWEN_BASE_URL=
```

只在本地 `.env` 中填写自己的 Key。将百炼控制台为你的地域和业务空间显示的 OpenAI 兼容 API Host 填入 `QWEN_BASE_URL`。

4. 重启 FastAPI。访问 `/health`，确认返回 `provider: qwen` 和当前模型名称。

切回离线演示：

```dotenv
AI_PROVIDER=mock
```

`.env` 已加入 `.gitignore`，真实 Key 不会被提交。`QwenAIProvider` 使用 OpenAI 兼容 Chat Completions、JSON Mode 和 Pydantic 验证；它还会清除模型伪造的 `source_text`。

旧配置名 `READBRIDGE_AI_PROVIDER` 仍兼容，但新配置建议统一使用 `AI_PROVIDER`。

## 扩展其他真实模型

新增 Provider 时继承 `AIProvider`，实现异步 `explain(...)` 与 `easy_read(...)`，然后在 `create_ai_provider()` 中注册。模型地址和 API Key 只能通过后端环境变量配置。

`ExplainData` 和 `EasyReadData` 是当前业务数据契约。后续认知负荷分析、行动卡片和多模态理解可以继续复用相同的 Provider/Service 分层方式。

## 当前范围

正文提取由 `apps/browser-extension/extractor.js` 中的 `UniversalContentExtractor` 完成。它会在用户点击“一键易读”时读取当前 DOM，依次尝试技术文档容器、`article/main/[role=main]`、常见文章容器和 DOM 文本密度策略，并综合标题、段落、列表、代码块、表格与链接比例判断质量。技术文档中的标题层级、列表层级、代码块和表格对应关系会转换成结构化纯文本。

动态页面首次提取失败时会有限重试两次。仍失败时可以使用“重试识别”“阅读选中区域”或“简单解释”。超过 60000 字的网页会在完整内容块边界停止，并在侧边栏明确提示本次没有处理全文。所有清理都在克隆 DOM 上进行，不读取密码框、表单值、Cookie 或 LocalStorage，也不修改原网页 DOM。

一键易读会先根据标题上下文、列表、表格、引用和正文位置建立主题覆盖计划，再让 Qwen 按短文 3～5、中等文章 5～8、长文章 8～12、复杂多主题文章最多 15 个 section 的范围进行重构。正常模式展示全部主要内容；“减少内容”模式只显示四个代表主题并将每张卡片压缩为一至两句，同时明确提示当前为精简展示。后端仍会严格校验 `source_text` 和 `source_block_ids`，覆盖率不会用于放宽事实证据标准。

阅桥支持“固定侧边栏”和“浮动窗口”两种模式。右上角的 `▣` 按钮可以直接切换；浮动模式可拖动标题栏移动，支持八方向调整大小，并在右下角显示轻量手柄。双击非按钮区域的标题栏也可以切换模式。模式切换仅修改当前面板样式，不会重新请求 AI 或重新创建内容。

窗口状态保存在 `chrome.storage.local`：`readbridgeWindowMode`、`readbridgeFloatingWidth`、`readbridgeFloatingHeight`、`readbridgeFloatingLeft` 和 `readbridgeFloatingTop`。固定侧栏宽度另存为 `readbridgeDockedWidth`。点击“恢复默认窗口”时，浮动窗口恢复为 480px、70vh、距右30px和距顶60px；固定模式恢复为440px宽。

## 语音易读模式

阅桥可使用浏览器原生 Web Speech API，也可通过 FastAPI 调用神经语音。神经语音只发送当前朗读片段，不调用 Qwen；系统语音完全在浏览器中完成。两种模式都支持朗读全部、单独朗读卡片、暂停、继续、停止、上一部分和下一部分。朗读内容来自结构化的 `one_sentence`、`sections`、`key_points` 和 `difficult_words`，默认不朗读 `source_text`。

当前朗读卡片会高亮，并在侧边栏内容区域内自动滚动。语速支持 `0.75x`、`0.9x`、`1.0x`、`1.25x` 和 `1.5x`。语速、音色和 Provider 分别保存在 `chrome.storage.local` 的 `readbridgeSpeechRate`、`readbridgeSpeechVoice` 和 `readbridgeSpeechProvider`。系统语音会综合语言、Natural/Neural 标记和厂商评分自动选音色，也允许用户查看并选择 Chrome 实际可用的中文声音。

## 一键定位原文

易读模块存在经过后端校验的 `source_text` 时，会显示“📍”按钮。点击后，阅桥完全在浏览器本地重新扫描当前网页 DOM，将原文平滑滚动到可视区域并高亮约 3.2 秒。这个过程不会请求 Qwen 或 FastAPI，也不会停止正在进行的语音朗读。

定位优先使用技术文档正文容器、`article`、`main` 或 `[role="main"]`，并排除导航、目录、侧栏、页眉、页脚、广告和推荐区域。匹配顺序为标准化精确匹配、最多三个连续正文块组合以及高阈值模糊匹配。找不到唯一可靠位置时会提示用户，不会猜测位置。

正文提取时还会为标题、段落、列表项、定义项和表格行建立 `rb-N` 内容块，并在当前 content script 中保存 `blockIdToElement` 映射。Qwen 返回的 `source_block_ids` 会由后端按本次请求的真实块编号进行过滤。定位顺序为：DOM 块锚点、`source_text`、表格/列表结构字段、强关键词以及受控模糊匹配。旧结果没有块编号时仍会自动使用后续匹配层级。

难词现在可以携带 `source_text` 和 `source_block_ids`，同时显示朗读与定位按钮。支持 CSS Custom Highlight API 时会突出具体词语；不支持时只高亮包含该词的最小正文元素，不会包裹或改写 React/Vue DOM。

“查看对应原文”用于在阅桥内部核对证据；“📍定位原文”用于回到网页查看上下文，两项功能同时保留。

图片理解、认知负荷接口、行动卡片独立接口、登录、数据库、RAG 和语音识别尚未接入。真实 Qwen 已通过可切换的 `QwenAIProvider` 接入。

## 性能配置与基准

一键易读默认采用快速模式：正文提取最多保留 20000 字、100 个结构块，并均衡覆盖文章开头、中间、结尾和标题。Qwen 输出 token 会根据输入规模动态调整，默认最大 2500。相同 Provider、模型、配置和正文的结果在后端缓存 15 分钟；相同并发请求只执行一次模型调用。神经语音复用 HTTP 连接，只预取当前片段和下一片段，首片段约 80 字，以缩短首次出声时间。

可在 `.env` 调整 `PERFORMANCE_LOGS`、`EASY_READ_MAX_INPUT_CHARS`、`EASY_READ_MAX_BLOCKS`、`EASY_READ_CACHE_TTL_SECONDS` 和 `EASY_READ_CACHE_MAX_ENTRIES`。性能日志只记录 request_id、耗时、字符数、块数、token 使用量和缓存状态，不记录正文或密钥。API 响应通过 `X-ReadBridge-Cache`、`X-ReadBridge-TTS-Cache`、`X-Request-ID` 和 `Server-Timing` 暴露诊断信息。

服务启动后运行 `python tests/benchmark_api.py` 可比较冷请求与缓存命中；正文提取的 1k/5k/20k/60k 基准脚本位于 `tests/browser/benchmark-extractor.mjs`。侧边栏在等待期间显示实际阶段，超过 10 秒会提示文章较长，并允许取消尚未完成的请求。

### 语雀技术文档诊断

正文提取器支持语雀动态文档使用的 `NE-P`、`NE-H1～NE-H6`、`NE-ULI/NE-OLI` 和表格结构，并排除左侧目录、页面导航和图片 OCR 隐藏文本。动态正文会等待内容长度稳定后再提取。开发控制台只输出标题、策略、长度、块类型、重复数和耗时，不输出完整正文。

Qwen 调用会记录脱敏的 `request_id`、请求字节数、估算与实际 token、输出长度、`finish_reason`、JSON/Pydantic 状态和耗时。模型返回 `finish_reason=length` 时归类为 `truncated_model_output`。扩展仅对截断、字段校验失败、超时和输入过大自动精简重试一次：正文上限约 11000 字、最多 55 块，并减少 sections、重点和难词数量。401、403、429 不自动重试。后端错误会原样保留安全的 `code/message/request_id/provider_status/retryable`，便于界面提示和日志对应。

## 开源许可与第三方资源

团队自主编写且有权授权的阅桥项目代码按 `Apache License 2.0` 发布，完整条款见根目录 `LICENSE`。项目署名、直接依赖、专有模型/API 和第三方内容边界见 `NOTICE`。

本项目许可证不覆盖 qwen-plus、CosyVoice、浏览器平台能力、系统音色、网页内容、测试输入或模型输出中的第三方权利。使用者需自行获取 API 凭据，并遵守相应平台的服务、数据、计费、音色和内容规则。发布包含虚拟环境或其他第三方二进制文件时，应另行生成并复核完整的传递依赖许可清单。
