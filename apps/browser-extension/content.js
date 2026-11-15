(() => {
  "use strict";

  if (window.__easyReadLoaded) return;
  window.__easyReadLoaded = true;

  // 快速模式预算：避免把超长 DOM 全量发送给模型；提取器会均衡保留首、中、尾内容。
  const MAX_ARTICLE_LENGTH = 20000;
  const MIN_SELECTED_REGION_LENGTH = 80;
  const DEFAULT_WINDOW_STATE = {
    mode: "docked",
    dockedWidth: 440,
    floatingWidth: 480,
    floatingHeight: 0,
    floatingLeft: null,
    floatingTop: 60,
  };
  const rootHost = document.createElement("easyread-extension-root");
  rootHost.style.setProperty("all", "initial", "important");
  rootHost.style.setProperty("position", "fixed", "important");
  rootHost.style.setProperty("z-index", "2147483647", "important");
  document.documentElement.appendChild(rootHost);
  const shadow = rootHost.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input, select { font: inherit; }
      .rb-trigger { position: fixed; display: none; padding: 9px 14px; border: 0; border-radius: 999px; color: #fff; background: #347866; box-shadow: 0 6px 22px rgba(29,61,51,.25); font: 700 13px/1.2 system-ui,"Microsoft YaHei",sans-serif; cursor: pointer; }
      .rb-trigger:hover { background: #286756; }
      .rb-panel { --rb-font-size: 16px; position: fixed; display: flex; flex-direction: column; min-width: 0; transform: translateX(105%); transition: transform .2s ease; background: #f8fbf9; color: #26352f; font: 14px/1.7 system-ui,"Microsoft YaHei",sans-serif; overflow: hidden; }
      .rb-panel.open { transform: translateX(0); }
      .rb-panel.docked { top: 0; right: 0; left: auto; height: 100vh; border-radius: 0; border: 0; box-shadow: -12px 0 38px rgba(28,52,44,.16); }
      .rb-panel.floating { right: auto; border: 1px solid #d5e1dc; border-radius: 14px; box-shadow: 0 10px 35px rgba(28,52,44,.24); }
      .rb-panel.resizing, .rb-panel.dragging { transition: none; user-select: none; }
      .rb-header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; min-height: 68px; padding: 14px 18px; border-bottom: 1px solid #e1e9e5; background: #fbfdfc; }
      .rb-panel.floating .rb-header { cursor: grab; touch-action: none; }
      .rb-panel.floating.dragging .rb-header { cursor: grabbing; }
      .rb-brand { display: flex; align-items: center; gap: 10px; }
      .rb-logo { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: #fff; background: #347866; font-weight: 800; }
      .rb-brand-copy { display: flex; flex-direction: column; line-height: 1.15; }
      .rb-brand-copy strong { font-size: 18px; }
      .rb-brand-copy small { margin-top: 4px; color: #718078; font-size: 10px; font-weight: 700; letter-spacing: .09em; }
      .rb-header-actions { display: flex; align-items: center; gap: 3px; }
      .rb-header-button { display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 50%; color: #52655d; background: transparent; cursor: pointer; }
      .rb-window-mode { font-size: 19px; }
      .rb-close { font-size: 25px; }
      .rb-header-button:hover, .rb-tool:hover { background: #e9f0ed; }
      .rb-tools { flex: 0 0 auto; display: none; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 18px; border-bottom: 1px solid #e1e9e5; background: #fff; }
      .rb-tools.visible { display: flex; }
      .rb-tool { min-width: 35px; height: 34px; padding: 0 10px; border: 1px solid #cddbd5; border-radius: 9px; color: #36574b; background: #fff; font-weight: 700; cursor: pointer; }
      .rb-tool[aria-pressed="true"] { color: #fff; border-color: #347866; background: #347866; }
      .rb-tool-label { margin-left: 4px; color: #64776f; font-size: 12px; }
      .rb-speech-controls { flex: 0 0 auto; display: none; align-items: center; flex-wrap: wrap; gap: 7px; padding: 9px 18px; border-bottom: 1px solid #e1e9e5; background: #f4f8f6; }
      .rb-speech-controls.visible { display: flex; }
      .rb-speech-button { min-width: 34px; height: 32px; padding: 0 9px; border: 1px solid #c8d8d1; border-radius: 8px; color: #315849; background: #fff; font-weight: 700; cursor: pointer; }
      .rb-speech-button:hover, .rb-speak-item:hover { background: #e6f0eb; }
      .rb-speech-button:disabled { opacity: .45; cursor: default; }
      .rb-speech-rate { height: 32px; padding: 0 7px; border: 1px solid #c8d8d1; border-radius: 8px; color: #315849; background: #fff; font: inherit; }
      .rb-speech-status { min-width: 110px; flex: 1 1 110px; color: #526b61; font-size: 12px; }
      .rb-speech-select { max-width: 150px; height: 32px; padding: 0 7px; border: 1px solid #c8d8d1; border-radius: 8px; color: #315849; background: #fff; }
      .rb-speech-error { display: none; flex: 1 0 100%; padding: 10px 12px; border-radius: 9px; color: #803f35; background: #faebe7; }
      .rb-speech-error.visible { display: block; }
      .rb-speech-error button { margin: 8px 7px 0 0; padding: 6px 9px; border: 0; border-radius: 7px; color: #fff; background: #347866; cursor: pointer; }
      .rb-body { flex: 1 1 auto; min-height: 0; width: 100%; padding: 22px 20px 40px; overflow-x: hidden; overflow-y: auto; font-size: var(--rb-font-size); overflow-wrap: anywhere; }
      .rb-section { margin-bottom: 24px; }
      .rb-kicker { margin: 0 0 8px; color: #65786f; font-size: 12px; font-weight: 800; letter-spacing: .06em; }
      .rb-page-title { margin: 0 0 20px; color: #1d3028; font-size: 1.28em; line-height: 1.45; }
      .rb-one { margin: 0; padding: 17px; border-left: 4px solid #347866; border-radius: 0 12px 12px 0; background: #e8f3ee; color: #20493b; font-size: 1.08em; font-weight: 650; line-height: 1.8; }
      .rb-card { margin-bottom: 15px; padding: 17px; border: 1px solid #dce7e2; border-radius: 14px; background: #fff; }
      .rb-card h3 { margin: 0; color: #244f40; font-size: 1em; line-height: 1.45; }
      .rb-content-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin: 0 0 11px; }
      .rb-content-heading .rb-kicker { margin: 0; }
      .rb-item-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
      .rb-speak-item { flex: 0 0 auto; display: grid; place-items: center; width: 31px; height: 31px; padding: 0; border: 1px solid #cedcd6; border-radius: 50%; color: #347866; background: #fff; cursor: pointer; }
      .rb-locate-source { flex: 0 0 auto; display: grid; place-items: center; width: 31px; height: 31px; padding: 0; border: 1px solid #d9d4bb; border-radius: 50%; color: #725f21; background: #fffdf4; cursor: pointer; }
      .rb-locate-source:hover { background: #fff3bd; }
      .rb-locate-source:disabled { opacity: .62; cursor: wait; }
      .rb-speech-item.is-speaking { border-color: #347866; background: #e8f4ee; box-shadow: inset 4px 0 0 #347866; }
      .rb-speech-item.is-speaking .rb-speak-item { color: #fff; border-color: #347866; background: #347866; }
      .rb-card p { margin: 0; line-height: 1.9; white-space: pre-line; }
      .rb-source { margin-top: 13px; border-top: 1px solid #e7eeeb; padding-top: 10px; }
      .rb-source summary { color: #347866; font-size: .86em; font-weight: 700; cursor: pointer; }
      .rb-source blockquote { margin: 10px 0 0; padding: 11px 13px; border-left: 3px solid #bdcec6; background: #f3f6f5; color: #596c63; font-size: .88em; line-height: 1.75; }
      .rb-list { margin: 0; padding: 0; list-style: none; }
      .rb-list li { position: relative; margin-bottom: 9px; padding: 11px 12px 11px 32px; border-radius: 10px; background: #fff; border: 1px solid #e0e9e5; line-height: 1.75; }
      .rb-list li::before { content: "•"; position: absolute; left: 14px; color: #347866; font-weight: 900; }
      .rb-word { margin-bottom: 10px; padding: 13px; border-radius: 11px; background: #fff8e9; }
      .rb-word strong { color: #594b2a; }
      .rb-action { padding: 15px; border-radius: 12px; background: #edf3f9; color: #304a61; }
      .rb-original { margin: 0; padding: 14px; border-left: 3px solid #b8cac2; background: #f1f5f3; color: #56665f; }
      .rb-simple { margin: 0; font-size: 1.04em; line-height: 1.9; }
      .rb-example { margin: 0; padding: 14px; border-radius: 12px; background: #fff5df; color: #624e25; }
      .rb-pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 15px; }
      .rb-pager button, .rb-retry { padding: 9px 13px; border: 0; border-radius: 9px; color: #fff; background: #347866; cursor: pointer; }
      .rb-pager button:disabled { color: #89968f; background: #e2e8e5; cursor: default; }
      .rb-progress { color: #64776f; font-size: .86em; font-weight: 700; }
      .rb-loading { padding: 55px 12px; text-align: center; color: #536a60; }
      .rb-spinner { width: 30px; height: 30px; margin: 0 auto 16px; border: 3px solid #dce9e3; border-top-color: #347866; border-radius: 50%; animation: rb-spin .8s linear infinite; }
      .rb-loading strong { display: block; margin-bottom: 6px; color: #2c5143; font-size: 1.05em; }
      .rb-loading span { font-size: .88em; }
      .rb-error { padding: 17px; border-radius: 13px; color: #803f35; background: #faebe7; line-height: 1.75; }
      .rb-error strong { display: block; margin-bottom: 5px; }
      .rb-retry { margin-top: 13px; }
      .rb-error-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
      .rb-error-actions .rb-retry { margin: 0; }
      .rb-notice { margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; color: #6a5522; background: #fff4d6; font-size: .88em; }
      .rb-overview { margin: 0 0 18px; padding: 12px; border: 1px solid #dce7e2; border-radius: 12px; background: #f7faf8; }
      .rb-overview-title { margin: 0 0 9px; color: #355c4e; font-size: .88em; font-weight: 750; }
      .rb-outline { display: flex; flex-wrap: wrap; gap: 7px; }
      .rb-outline button { padding: 6px 9px; border: 1px solid #cfddd7; border-radius: 9px; color: #315c4d; background: #fff; cursor: pointer; font: inherit; font-size: .78em; }
      .rb-toast { position: absolute; z-index: 12; right: 18px; bottom: 18px; max-width: calc(100% - 36px); padding: 10px 14px; border: 1px solid #c9d9d2; border-radius: 10px; color: #294c40; background: rgba(250,253,251,.97); box-shadow: 0 8px 24px rgba(28,52,44,.2); font-weight: 700; opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .18s ease,transform .18s ease; }
      .rb-toast.visible { opacity: 1; transform: translateY(0); }
      .rb-resize { display: none; position: absolute; z-index: 5; touch-action: none; }
      .rb-resize-w, .rb-resize-e { top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
      .rb-resize-w { left: 0; } .rb-resize-e { right: 0; }
      .rb-resize-n, .rb-resize-s { right: 10px; left: 10px; height: 8px; cursor: ns-resize; }
      .rb-resize-n { top: 0; } .rb-resize-s { bottom: 0; }
      .rb-resize-nw, .rb-resize-ne, .rb-resize-sw, .rb-resize-se { width: 16px; height: 16px; }
      .rb-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
      .rb-resize-ne { top: 0; right: 0; cursor: nesw-resize; }
      .rb-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
      .rb-resize-se { right: 0; bottom: 0; cursor: nwse-resize; }
      .rb-resize-se::after { content: "◢"; position: absolute; right: 2px; bottom: -1px; color: rgba(52,120,102,.52); font-size: 12px; line-height: 1; pointer-events: none; }
      .rb-panel.docked .rb-resize-w, .rb-panel.floating .rb-resize { display: block; }
      .rb-resize:hover { background: rgba(52,120,102,.12); }
      .rb-page-title, .rb-card, .rb-word, .rb-source blockquote { max-width: 100%; overflow-wrap: anywhere; }
      @keyframes rb-spin { to { transform: rotate(360deg); } }
      @media (max-width: 600px) { .rb-header, .rb-tools { padding-right: 12px; padding-left: 12px; } .rb-body { padding-right: 14px; padding-left: 14px; } .rb-tool { padding: 0 8px; } }
      @media (prefers-reduced-motion: reduce) { .rb-panel { transition: none; } .rb-spinner { animation: none; } }
    </style>
    <button class="rb-trigger" type="button">简单解释</button>
    <aside class="rb-panel docked" aria-label="阅桥认知无障碍阅读助手" aria-hidden="true">
      <div class="rb-resize rb-resize-w" data-resize="w" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-e" data-resize="e" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-n" data-resize="n" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-s" data-resize="s" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-nw" data-resize="nw" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-ne" data-resize="ne" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-sw" data-resize="sw" aria-hidden="true"></div>
      <div class="rb-resize rb-resize-se" data-resize="se" aria-hidden="true"></div>
      <header class="rb-header">
        <div class="rb-brand"><span class="rb-logo">阅</span><span class="rb-brand-copy"><strong>阅桥</strong><small>ReadBridge</small></span></div>
        <div class="rb-header-actions">
          <button class="rb-header-button rb-window-mode" data-window-mode type="button" aria-label="切换为浮动窗口" title="切换为浮动窗口">▣</button>
          <button class="rb-header-button rb-close" type="button" aria-label="关闭阅桥侧边栏" title="关闭">×</button>
        </div>
      </header>
      <div class="rb-tools" aria-label="阅读显示设置">
        <span class="rb-tool-label">字体</span>
        <button class="rb-tool" data-font="small" type="button" aria-label="缩小字体">A-</button>
        <button class="rb-tool" data-font="normal" type="button" aria-label="恢复默认字体">A</button>
        <button class="rb-tool" data-font="large" type="button" aria-label="增大字体">A+</button>
        <button class="rb-tool" data-mode="reduce" type="button" aria-pressed="false">减少内容</button>
        <button class="rb-tool" data-mode="step" type="button" aria-pressed="false">逐段阅读</button>
        <button class="rb-tool" data-speech-all type="button" aria-label="朗读全部易读内容">🔊 朗读全部</button>
        <button class="rb-tool" data-reset-window type="button">恢复默认窗口</button>
      </div>
      <div class="rb-speech-controls" aria-label="语音朗读控制">
        <button class="rb-speech-button" data-speech-prev type="button" aria-label="朗读上一部分" title="上一部分">⏮</button>
        <button class="rb-speech-button" data-speech-next type="button" aria-label="朗读下一部分" title="下一部分">⏭</button>
        <button class="rb-speech-button" data-speech-stop type="button" aria-label="停止朗读" title="停止朗读">■</button>
        <button class="rb-speech-button" data-speech-test type="button" aria-label="试听当前声音" title="试听当前声音">试听声音</button>
        <label class="rb-tool-label" for="rb-speech-provider">语音</label>
        <select class="rb-speech-select" id="rb-speech-provider" data-speech-provider aria-label="选择语音来源">
          <option value="browser">系统语音</option><option value="neural">神经语音</option>
        </select>
        <label class="rb-tool-label" for="rb-speech-voice">音色</label>
        <select class="rb-speech-select" id="rb-speech-voice" data-speech-voice aria-label="选择朗读音色"></select>
        <label class="rb-tool-label" for="rb-speech-rate">语速</label>
        <select class="rb-speech-rate" id="rb-speech-rate" data-speech-rate aria-label="选择朗读语速">
          <option value="0.75">0.75x</option><option value="0.9" selected>0.9x</option><option value="1">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option>
        </select>
        <span class="rb-speech-status" data-speech-status role="status" aria-live="polite">语音朗读已就绪</span>
        <div class="rb-speech-error" data-speech-error role="alert"></div>
      </div>
      <div class="rb-body"></div>
      <div class="rb-toast" data-toast role="status" aria-live="polite"></div>
    </aside>`;

  const trigger = shadow.querySelector(".rb-trigger");
  const panel = shadow.querySelector(".rb-panel");
  const tools = shadow.querySelector(".rb-tools");
  const speechControls = shadow.querySelector(".rb-speech-controls");
  const speechStatus = shadow.querySelector("[data-speech-status]");
  const body = shadow.querySelector(".rb-body");
  const toast = shadow.querySelector("[data-toast]");
  let selectedText = "";
  let easyReadData = null;
  let requestInFlight = false;
  let activeAIRequestId = "";
  let reduceMode = false;
  let stepMode = false;
  let stepIndex = 0;
  let extractionNotice = "";
  let speechQueue = [];
  let speechControlsExpanded = false;
  let windowState = { ...DEFAULT_WINDOW_STATE };
  let viewportSaveTimer = 0;
  let toastTimer = 0;

  const SourceLocator = globalThis.ReadBridgeSourceLocator;
  const sourceLocator = SourceLocator ? new SourceLocator(document, {
    getOverlayRect: () => panel.classList.contains("open") ? panel.getBoundingClientRect() : null,
  }) : null;

  const SpeechManager = globalThis.ReadBridgeSpeechManager;
  let lastSpeechRetry = null;
  const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
  const speechManager = SpeechManager ? new SpeechManager({
    onStateChange: updateSpeechControls,
    onItemChange: handleSpeechItemChange,
    requestNeural: async (payload, requestId) => {
      const response = await sendRuntimeMessage({ type: "READBRIDGE_TTS_SYNTHESIZE", payload, requestId });
      if (!response?.success) {
        throw {
          code: response?.error?.code || "tts_failed",
          message: response?.error?.message || "神经语音生成失败。",
          providerStatus: response?.error?.provider_status,
          requestId: response?.error?.request_id || "",
        };
      }
      return response.data;
    },
    cancelNeural: (requestId) => chrome.runtime.sendMessage({ type: "READBRIDGE_TTS_CANCEL", requestId }),
    onError: (error, item, context) => {
      const normalized = globalThis.ReadBridgeNormalizeSpeechError?.(error) || { code: "speech_error", message: "语音朗读失败。", requestId: "" };
      console.warn("ReadBridge Speech", { code: normalized.code, message: normalized.message, providerStatus: normalized.providerStatus, requestId: normalized.requestId, item: item?.id || "unknown" });
      if (context?.provider === "neural") {
        const savedQueue = [...speechManager.queue];
        const savedIndex = speechManager.state.index;
        const savedMode = speechManager.state.mode;
        showSpeechFallback(normalized.message, context.retry, () => {
          speechManager.setProvider("browser");
          shadow.querySelector("[data-speech-provider]").value = "browser";
          chrome.storage.local.set({ readbridgeSpeechProvider: "browser", readbridgeSpeechVoice: "" });
          refreshSpeechVoices();
          if (savedMode === "all") speechManager.playAll(savedQueue, savedIndex);
          else if (item) speechManager.playSingle(item);
        });
      }
      else announceSpeech(normalized.message);
    },
  }) : null;

  chrome.storage.local.get(["readbridgeSpeechRate", "readbridgeSpeechVoice", "readbridgeSpeechProvider"], (stored) => {
    const rate = [0.75, 0.9, 1, 1.25, 1.5].includes(Number(stored.readbridgeSpeechRate))
      ? Number(stored.readbridgeSpeechRate) : 0.9;
    const provider = stored.readbridgeSpeechProvider === "neural" ? "neural" : "browser";
    speechManager?.setRate(rate);
    speechManager?.setProvider(provider);
    speechManager?.setVoice(stored.readbridgeSpeechVoice || "");
    shadow.querySelector("[data-speech-rate]").value = String(rate);
    shadow.querySelector("[data-speech-provider]").value = provider;
    refreshSpeechVoices(stored.readbridgeSpeechVoice || "");
  });

  function voiceLabel(voice) {
    const natural = /natural|neural|xiaoxiao|yunxi|晓晓|云希/i.test(voice.name) ? "自然" : "";
    return `${voice.name}${natural ? `（${natural}）` : ""}`;
  }

  async function refreshSpeechVoices(preferred = "") {
    const select = shadow.querySelector("[data-speech-voice]");
    let voices = [];
    if (speechManager?.getProvider() === "neural") {
      const response = await sendRuntimeMessage({ type: "READBRIDGE_TTS_VOICES" }).catch(() => null);
      if (!response?.success || !response.neural) {
        select.innerHTML = `<option value="">服务端未启用神经语音</option>`;
        return;
      }
      voices = response.voices || [];
      preferred ||= response.default_voice;
    } else {
      voices = speechManager?.getBrowserVoices() || [];
      voices = voices.filter((voice) => /^zh/i.test(voice.language || ""));
    }
    select.innerHTML = voices.length
      ? `${speechManager?.getProvider() === "browser" ? '<option value="">自动选择高质量中文音色</option>' : ""}${voices.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voiceLabel(voice))}</option>`).join("")}`
      : `<option value="">自动选择中文音色</option>`;
    if (preferred && voices.some((voice) => voice.id === preferred)) select.value = preferred;
    speechManager?.setVoice(select.value);
  }

  function showSpeechFallback(message, retry, useBrowser) {
    const box = shadow.querySelector("[data-speech-error]");
    lastSpeechRetry = retry;
    box._useBrowser = useBrowser;
    box.innerHTML = `${escapeHtml(message)}<br><button type="button" data-use-browser>使用系统语音继续朗读</button><button type="button" data-speech-retry>重试</button>`;
    box.classList.add("visible");
    announceSpeech("神经语音失败。可使用系统语音继续朗读，或重试。");
  }

  function windowBounds(mode = windowState.mode) {
    const compact = innerWidth < 600;
    const viewportPadding = mode === "floating" ? 20 : 0;
    const maxWidth = Math.max(160, innerWidth - viewportPadding);
    const maxHeight = Math.max(160, innerHeight - viewportPadding);
    return {
      minWidth: Math.min(compact ? 260 : 320, maxWidth),
      maxWidth: mode === "docked" ? Math.min(maxWidth, Math.max(160, Math.floor(innerWidth * .85))) : maxWidth,
      minHeight: Math.min(300, maxHeight),
      maxHeight,
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(Number(value) || min, min), max);
  }

  function hasFiniteCoordinate(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value));
  }

  function ensureFloatingState() {
    const bounds = windowBounds("floating");
    windowState.floatingWidth = clamp(windowState.floatingWidth || 480, bounds.minWidth, bounds.maxWidth);
    windowState.floatingHeight = clamp(windowState.floatingHeight || innerHeight * .7, bounds.minHeight, bounds.maxHeight);
    const defaultLeft = Math.max(0, innerWidth - windowState.floatingWidth - 30);
    windowState.floatingLeft = clamp(
      hasFiniteCoordinate(windowState.floatingLeft) ? Number(windowState.floatingLeft) : defaultLeft,
      0,
      Math.max(0, innerWidth - windowState.floatingWidth),
    );
    windowState.floatingTop = clamp(
      hasFiniteCoordinate(windowState.floatingTop) ? Number(windowState.floatingTop) : 60,
      0,
      Math.max(0, innerHeight - windowState.floatingHeight),
    );
  }

  function applyWindowState() {
    const floating = windowState.mode === "floating";
    panel.classList.toggle("floating", floating);
    panel.classList.toggle("docked", !floating);
    if (floating) {
      ensureFloatingState();
      panel.style.width = `${windowState.floatingWidth}px`;
      panel.style.height = `${windowState.floatingHeight}px`;
      panel.style.left = `${windowState.floatingLeft}px`;
      panel.style.top = `${windowState.floatingTop}px`;
      panel.style.right = "auto";
    } else {
      const bounds = windowBounds("docked");
      windowState.dockedWidth = clamp(windowState.dockedWidth || 440, bounds.minWidth, bounds.maxWidth);
      panel.style.width = `${windowState.dockedWidth}px`;
      panel.style.height = "100vh";
      panel.style.left = "auto";
      panel.style.top = "0px";
      panel.style.right = "0px";
    }
    const modeButton = shadow.querySelector("[data-window-mode]");
    const label = floating ? "固定到右侧" : "切换为浮动窗口";
    modeButton.setAttribute("aria-label", label);
    modeButton.title = label;
  }

  function saveWindowState() {
    ensureFloatingState();
    chrome.storage.local.set({
      readbridgeWindowMode: windowState.mode,
      readbridgeFloatingWidth: Math.round(windowState.floatingWidth),
      readbridgeFloatingHeight: Math.round(windowState.floatingHeight),
      readbridgeFloatingLeft: Math.round(windowState.floatingLeft),
      readbridgeFloatingTop: Math.round(windowState.floatingTop),
      readbridgeDockedWidth: Math.round(windowState.dockedWidth),
    });
  }

  function toggleWindowMode() {
    windowState.mode = windowState.mode === "floating" ? "docked" : "floating";
    applyWindowState();
    saveWindowState();
  }

  function resetWindow() {
    if (windowState.mode === "floating") {
      windowState.floatingWidth = 480;
      windowState.floatingHeight = Math.round(innerHeight * .7);
      windowState.floatingLeft = Math.max(0, innerWidth - windowState.floatingWidth - 30);
      windowState.floatingTop = 60;
    } else {
      windowState.dockedWidth = 440;
    }
    applyWindowState();
    saveWindowState();
  }

  chrome.storage.local.get([
    "readbridgeWindowMode", "readbridgeFloatingWidth", "readbridgeFloatingHeight",
    "readbridgeFloatingLeft", "readbridgeFloatingTop", "readbridgeDockedWidth",
    "sidebarWidth", "sidebarHeight", "sidebarMode",
  ], (stored) => {
    const migratedMode = stored.readbridgeWindowMode
      || (stored.sidebarMode === "floating" ? "floating" : "docked");
    windowState = {
      mode: migratedMode === "floating" ? "floating" : "docked",
      dockedWidth: Number(stored.readbridgeDockedWidth || stored.sidebarWidth) || 440,
      floatingWidth: Number(stored.readbridgeFloatingWidth || stored.sidebarWidth) || 480,
      floatingHeight: Number(stored.readbridgeFloatingHeight || stored.sidebarHeight) || 0,
      floatingLeft: hasFiniteCoordinate(stored.readbridgeFloatingLeft) ? Number(stored.readbridgeFloatingLeft) : null,
      floatingTop: hasFiniteCoordinate(stored.readbridgeFloatingTop) ? Number(stored.readbridgeFloatingTop) : 60,
    };
    applyWindowState();
  });
  applyWindowState();

  function startResize(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const direction = handle.dataset.resize;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = panel.getBoundingClientRect().width;
    const startHeight = panel.getBoundingClientRect().height;
    const startRect = panel.getBoundingClientRect();
    let dragging = false;
    let finished = false;
    event.preventDefault();

    const move = (moveEvent) => {
      if (finished || moveEvent.pointerId !== pointerId) return;
      if ((moveEvent.buttons & 1) === 0) {
        finish(moveEvent);
        return;
      }
      if (!dragging) {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (distance < 3) return;
        dragging = true;
        panel.classList.add("resizing");
        rootHost.style.setProperty("cursor", getComputedStyle(handle).cursor, "important");
      }
      moveEvent.preventDefault();
      const bounds = windowBounds(windowState.mode);
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (windowState.mode === "docked") {
        windowState.dockedWidth = clamp(startWidth - dx, bounds.minWidth, bounds.maxWidth);
      } else {
        let left = startRect.left;
        let right = startRect.right;
        let top = startRect.top;
        let bottom = startRect.bottom;
        if (direction.includes("w")) left = clamp(startRect.left + dx, 0, startRect.right - bounds.minWidth);
        if (direction.includes("e")) right = clamp(startRect.right + dx, startRect.left + bounds.minWidth, innerWidth);
        if (direction.includes("n")) top = clamp(startRect.top + dy, 0, startRect.bottom - bounds.minHeight);
        if (direction.includes("s")) bottom = clamp(startRect.bottom + dy, startRect.top + bounds.minHeight, innerHeight);
        windowState.floatingWidth = Math.min(right - left, bounds.maxWidth);
        windowState.floatingHeight = Math.min(bottom - top, bounds.maxHeight);
        if (direction.includes("w")) left = right - windowState.floatingWidth;
        if (direction.includes("n")) top = bottom - windowState.floatingHeight;
        windowState.floatingLeft = left;
        windowState.floatingTop = top;
      }
      scheduleWindowFrame();
    };
    const finish = (finishEvent) => {
      if (finished || (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId)) return;
      finished = true;
      panel.classList.remove("resizing");
      rootHost.style.removeProperty("cursor");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish, true);
      if (dragging) saveWindowState();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish, true);
  }

  let pendingWindowFrame = 0;
  function scheduleWindowFrame() {
    if (pendingWindowFrame) return;
    pendingWindowFrame = requestAnimationFrame(() => {
      pendingWindowFrame = 0;
      applyWindowState();
    });
  }

  shadow.querySelectorAll("[data-resize]").forEach((handle) => handle.addEventListener("pointerdown", startResize));
  const header = shadow.querySelector(".rb-header");

  function startWindowDrag(event) {
    if (windowState.mode !== "floating" || event.button !== 0 || !event.isPrimary || event.target.closest("button")) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = windowState.floatingLeft;
    const startTop = windowState.floatingTop;
    let dragging = false;
    let finished = false;
    event.preventDefault();

    const move = (moveEvent) => {
      if (finished || moveEvent.pointerId !== pointerId) return;
      if ((moveEvent.buttons & 1) === 0) {
        finish(moveEvent);
        return;
      }
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 3) return;
        dragging = true;
        panel.classList.add("dragging");
        rootHost.style.setProperty("cursor", "grabbing", "important");
      }
      moveEvent.preventDefault();
      windowState.floatingLeft = clamp(startLeft + dx, 0, Math.max(0, innerWidth - windowState.floatingWidth));
      windowState.floatingTop = clamp(startTop + dy, 0, Math.max(0, innerHeight - windowState.floatingHeight));
      scheduleWindowFrame();
    };
    const finish = (finishEvent) => {
      if (finished || (finishEvent?.pointerId !== undefined && finishEvent.pointerId !== pointerId)) return;
      finished = true;
      panel.classList.remove("dragging");
      rootHost.style.removeProperty("cursor");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish, true);
      if (dragging) saveWindowState();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish, true);
  }

  header.addEventListener("pointerdown", startWindowDrag);
  header.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) toggleWindowMode();
  });
  addEventListener("resize", () => {
    applyWindowState();
    clearTimeout(viewportSaveTimer);
    viewportSaveTimer = setTimeout(saveWindowState, 180);
  }, { passive: true });

  function escapeHtml(value) {
    const node = document.createElement("div");
    node.textContent = value ?? "";
    return node.innerHTML;
  }

  function announceSpeech(message) {
    speechStatus.textContent = message;
  }

  function buildSpeechQueue() {
    if (!easyReadData) return [];
    const items = [];
    const summary = reduceMode ? reducedText(easyReadData.one_sentence) : easyReadData.one_sentence;
    if (summary) items.push({ id: "summary", type: "summary", title: "全文概览", text: summary });
    const sections = Array.isArray(easyReadData.sections) ? easyReadData.sections : [];
    displayedSections(sections).forEach(({ section, index }) => {
      const text = reduceMode ? reducedText(section.content) : section.content;
      if (text) items.push({ id: `section-${index}`, type: "section", title: section.heading, text });
    });
    const points = stepMode ? [] : (reduceMode ? (easyReadData.key_points || []).slice(0, 2) : (easyReadData.key_points || []));
    if (points.length) {
      items.push({
        id: "key-points",
        type: "key_points",
        title: "重点信息",
        text: points.map((item) => {
          const point = typeof item === "string" ? { label: "重点", value: item } : item;
          return `${point.label || "重点"}，${point.value || ""}。`;
        }).join(" "),
      });
    }
    if (!reduceMode && !stepMode) {
      (easyReadData.difficult_words || []).forEach((item, index) => {
        items.push({
          id: `difficult-${index}`,
          type: "difficult_words",
          title: `难词：${item.word}`,
          text: `简单解释：${item.simple}`,
        });
      });
    }
    return items;
  }

  function clearSpeechHighlight() {
    body.querySelectorAll(".is-speaking").forEach((node) => node.classList.remove("is-speaking"));
  }

  function highlightSpeechItem(item) {
    clearSpeechHighlight();
    if (!item) return;
    const node = body.querySelector(`[data-speech-id="${item.id}"]`);
    if (!node) return;
    node.classList.add("is-speaking");
    const nodeRect = node.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (nodeRect.top < bodyRect.top || nodeRect.bottom > bodyRect.bottom) {
      body.scrollTo({ top: body.scrollTop + nodeRect.top - bodyRect.top - 12, behavior: "smooth" });
    }
  }

  function handleSpeechItemChange(item) {
    if (!item) {
      clearSpeechHighlight();
      return;
    }
    const sectionMatch = /^section-(\d+)$/.exec(item.id);
    if (stepMode && sectionMatch) {
      stepIndex = Number(sectionMatch[1]);
      renderEasyRead();
    }
    requestAnimationFrame(() => highlightSpeechItem(item));
    announceSpeech(`准备朗读：${item.title}`);
  }

  function updateSpeechControls(state) {
    const allButton = shadow.querySelector("[data-speech-all]");
    const previousButton = shadow.querySelector("[data-speech-prev]");
    const nextButton = shadow.querySelector("[data-speech-next]");
    const stopButton = shadow.querySelector("[data-speech-stop]");
    if (state.status === "playing") {
      allButton.textContent = "⏸ 暂停";
      allButton.setAttribute("aria-label", "暂停朗读");
      announceSpeech(`正在朗读，当前使用${state.provider === "neural" ? "神经语音" : "系统语音"}`);
    } else if (state.status === "preparing") {
      allButton.textContent = "⏳ 准备中";
      allButton.setAttribute("aria-label", state.provider === "neural" ? "正在生成语音" : "正在准备系统语音");
      announceSpeech(state.provider === "neural" ? "正在生成语音" : "正在准备系统语音");
    } else if (state.status === "paused") {
      allButton.textContent = "▶ 继续";
      allButton.setAttribute("aria-label", "继续朗读");
      announceSpeech("朗读已暂停");
    } else {
      allButton.textContent = "🔊 朗读全部";
      allButton.setAttribute("aria-label", "朗读全部易读内容");
      if (easyReadData && state.status === "idle") announceSpeech("语音朗读已就绪");
    }
    const allMode = state.mode === "all";
    previousButton.disabled = !allMode || state.index <= 0;
    nextButton.disabled = !allMode || state.index < 0 || state.index >= speechQueue.length - 1;
    stopButton.disabled = state.status === "idle";
  }

  function startAllSpeech() {
    if (!speechManager?.supported) {
      speechControlsExpanded = true;
      speechControls.classList.add("visible");
      announceSpeech("当前浏览器不支持语音朗读。");
      return;
    }
    speechControlsExpanded = true;
    speechControls.classList.add("visible");
    speechQueue = buildSpeechQueue();
    if (!speechQueue.length) {
      announceSpeech("当前没有可以朗读的易读内容。");
      return;
    }
    speechManager.playAll(speechQueue);
  }

  function playSpeechItem(id) {
    if (!speechManager?.supported) {
      speechControlsExpanded = true;
      speechControls.classList.add("visible");
      announceSpeech("当前浏览器不支持语音朗读。");
      return;
    }
    speechControlsExpanded = true;
    speechControls.classList.add("visible");
    speechQueue = buildSpeechQueue();
    const item = speechQueue.find((candidate) => candidate.id === id);
    if (item) speechManager.playSingle(item);
  }

  function openPanel() {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
  }

  function closePanel() {
    speechManager?.stop();
    if (activeAIRequestId) chrome.runtime.sendMessage({ type: "READBRIDGE_AI_CANCEL", requestId: activeAIRequestId });
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  function hideTrigger() {
    trigger.style.display = "none";
  }

  function setToolsVisible(visible) {
    tools.classList.toggle("visible", visible);
  }

  function updateTriggerFromSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!text || !selection || selection.rangeCount === 0) return hideTrigger();
    selectedText = text.slice(0, 10000);
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    trigger.style.left = `${Math.min(Math.max(12, rect.left + rect.width / 2 - 42), Math.max(12, innerWidth - 105))}px`;
    trigger.style.top = `${Math.min(Math.max(12, rect.bottom + 10), Math.max(12, innerHeight - 48))}px`;
    trigger.style.display = "block";
  }

  document.addEventListener("mouseup", (event) => {
    if (!rootHost.contains(event.target)) setTimeout(updateTriggerFromSelection, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift" || event.shiftKey) setTimeout(updateTriggerFromSelection, 0);
  });
  document.addEventListener("mousedown", (event) => {
    if (!rootHost.contains(event.target)) hideTrigger();
  });
  document.addEventListener("scroll", hideTrigger, true);
  shadow.querySelector(".rb-close").addEventListener("click", closePanel);

  function friendlyRuntimeError(error, fallback) {
    const message = error?.message || "";
    if (message.includes("Extension context invalidated")) return "插件刚刚更新，请刷新当前网页后重试。";
    return message || fallback;
  }

  async function explain(text) {
    speechManager?.stop();
    speechControls.classList.remove("visible");
    openPanel();
    setToolsVisible(false);
    body.innerHTML = loadingHtml("正在生成简单解释……", "阅桥正在理解你选择的文字");
    try {
      const result = await chrome.runtime.sendMessage({ type: "EASYREAD_EXPLAIN", text });
      if (!result?.success || !result.data) throw new Error(result?.error?.message || "AI处理失败，请稍后重试。");
      renderExplain(result.data);
    } catch (error) {
      showError("暂时无法解释", friendlyRuntimeError(error, "无法连接阅桥AI服务，请检查服务器是否已经启动。"), () => explain(text));
    }
  }

  function renderExplain(data) {
    const keywords = Array.isArray(data.keywords) ? data.keywords : [];
    body.innerHTML = `
      <p class="rb-kicker">简单解释</p>
      <section class="rb-section"><h2 class="rb-kicker">原文</h2><p class="rb-original">${escapeHtml(data.original)}</p></section>
      <section class="rb-section"><h2 class="rb-kicker">简单解释</h2><p class="rb-simple">${escapeHtml(data.simple)}</p></section>
      <section class="rb-section"><h2 class="rb-kicker">关键词</h2>${keywords.map((item) => `<div class="rb-word"><strong>${escapeHtml(item.word)}</strong><br>${escapeHtml(item.explanation)}</div>`).join("") || '<div class="rb-word">暂无需要单独解释的关键词。</div>'}</section>
      <section class="rb-section"><h2 class="rb-kicker">举个例子</h2><p class="rb-example">${escapeHtml(data.example)}</p></section>`;
  }

  function loadingHtml(title, stage, cancelable = false) {
    return `<div class="rb-loading"><div class="rb-spinner"></div><strong>${escapeHtml(title)}</strong><span data-loading-stage aria-live="polite">${escapeHtml(stage)}</span>${cancelable ? '<button class="rb-retry" data-cancel-request type="button">取消</button>' : ''}</div>`;
  }

  function showError(title, message, retry) {
    body.innerHTML = `<div class="rb-error"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}${retry ? '<br><button class="rb-retry" type="button">重试</button>' : ""}</div>`;
    if (retry) body.querySelector(".rb-retry").addEventListener("click", retry);
  }

  function runtimeAIError(detail, fallback) {
    const error = new Error(detail?.message || fallback);
    error.code = detail?.code || "unknown_provider_error";
    error.requestId = detail?.request_id || "";
    error.retryable = Boolean(detail?.retryable);
    return error;
  }

  function balancedRetryArticle(article) {
    const source = Array.isArray(article.content_blocks) ? article.content_blocks : [];
    const wanted = new Set(source.filter((block) => block.type === "heading").map((block) => source.indexOf(block)));
    const slots = Math.min(55, source.length);
    for (let index = 0; index < slots; index += 1) wanted.add(Math.round(index * (source.length - 1) / Math.max(slots - 1, 1)));
    const blocks = []; let length = 0;
    for (const index of [...wanted].sort((left, right) => left - right)) {
      const block = source[index];
      if (!block || blocks.length >= 55 || (length + block.text.length > 11000 && blocks.length)) continue;
      blocks.push(block); length += block.text.length;
    }
    let text = blocks.length ? blocks.map((block) => block.text).join("\n\n") : article.text;
    if (text.length > 11000) {
      const part = 3600; const middle = Math.floor(text.length / 2);
      text = `${text.slice(0, part)}\n\n${text.slice(middle - part / 2, middle + part / 2)}\n\n${text.slice(-part)}`;
    }
    return { ...article, text, content_blocks: blocks, degraded: true, truncated: true,
      metrics: { ...(article.metrics || {}), retryTextLength: text.length, retryBlockCount: blocks.length } };
  }

  function showEasyReadError(error, retry) {
    const messages = {
      truncated_model_output: "AI返回内容不完整，已尝试精简文章后仍未完成。",
      response_validation_failed: "AI返回的数据字段不完整，已尝试精简后仍无法整理。",
      invalid_model_output: "AI返回格式不完整，已尝试精简后仍失败。",
      input_too_large: "当前文章过长，请选中部分内容阅读。",
      provider_timeout: "AI服务超时，请稍后重试。",
      quota_exceeded: "Qwen调用额度不足或请求过于频繁。",
      authentication_failed: "AI服务认证失败，请检查后端API Key权限。",
      network_error: "后端未连接或无法访问AI服务。",
    };
    const message = messages[error?.code] || error?.message || "暂时无法生成易读内容。";
    const requestId = error?.requestId || "";
    body.innerHTML = `<div class="rb-error"><strong>暂时无法生成易读内容</strong>${escapeHtml(message)}
      ${requestId ? `<div class="rb-notice">request_id：${escapeHtml(requestId)}</div>` : ""}
      <div class="rb-error-actions"><button class="rb-retry" data-error-action="retry" type="button">重试</button>
      <button class="rb-retry" data-error-action="region" type="button">阅读选中区域</button>
      <button class="rb-retry" data-error-action="explain" type="button">简单解释</button>
      ${requestId ? '<button class="rb-retry" data-error-action="copy" type="button">复制request_id</button>' : ""}</div></div>`;
    body.querySelector('[data-error-action="retry"]')?.addEventListener("click", retry, { once: true });
    body.querySelector('[data-error-action="region"]')?.addEventListener("click", readSelectedRegion, { once: true });
    body.querySelector('[data-error-action="explain"]')?.addEventListener("click", () => {
      const text = currentSelectedRegion(); if (text) explain(text.slice(0, 10000));
    }, { once: true });
    body.querySelector('[data-error-action="copy"]')?.addEventListener("click", () => navigator.clipboard?.writeText(requestId), { once: true });
  }

  function extractArticle() {
    const Extractor = globalThis.ReadBridgeUniversalContentExtractor;
    if (!Extractor) throw new Error("正文提取器未加载，请重新加载插件并刷新网页。");
    return new Extractor(document, { maxLength: MAX_ARTICLE_LENGTH, maxBlocks: 100 }).extract();
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function extractArticleWithRetry(stageNode) {
    // 动态文档编辑器会在 document_idle 后继续填充正文；最多等待约 2.4 秒稳定。
    if (document.querySelector(".ne-viewer-body, [data-doc-content], [class*='doc-content']")) {
      let previous = -1; let stableRounds = 0;
      for (let round = 0; round < 8 && stableRounds < 2; round += 1) {
        const length = document.querySelector(".ne-viewer-body, [data-doc-content], [class*='doc-content']")?.textContent?.length || 0;
        stableRounds = length > 100 && length === previous ? stableRounds + 1 : 0;
        previous = length;
        if (stableRounds < 2) await wait(300);
      }
    }
    const delays = [0, 650, 1200];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) {
        if (stageNode) stageNode.textContent = `页面可能仍在加载，正在重试识别（${attempt + 1}/${delays.length}）……`;
        await wait(delays[attempt]);
      }
      const article = extractArticle();
      if (article?.text) return article;
    }
    return null;
  }

  function currentSelectedRegion() {
    const current = window.getSelection()?.toString().trim() || selectedText.trim();
    return current.slice(0, MAX_ARTICLE_LENGTH);
  }

  function showExtractionFailure() {
    const selection = currentSelectedRegion();
    body.innerHTML = `
      <div class="rb-error">
        <strong>暂时无法自动识别主要内容</strong>
        阅桥已经尝试语义区域、技术文档容器和文本密度分析。你可以重新识别，或选中网页正文后阅读该区域。
        <div class="rb-error-actions">
          <button class="rb-retry" data-extract-action="retry" type="button">重试识别</button>
          <button class="rb-retry" data-extract-action="region" type="button">阅读选中区域</button>
          <button class="rb-retry" data-extract-action="explain" type="button">简单解释</button>
        </div>
        ${selection && selection.length < MIN_SELECTED_REGION_LENGTH ? `<div class="rb-notice">当前选区只有 ${selection.length} 个字符。阅读选中区域至少需要 ${MIN_SELECTED_REGION_LENGTH} 个字符。</div>` : ""}
      </div>`;
    body.querySelector('[data-extract-action="retry"]').addEventListener("click", simplifyCurrentPage);
    body.querySelector('[data-extract-action="region"]').addEventListener("click", () => {
      readSelectedRegion();
    });
    body.querySelector('[data-extract-action="explain"]').addEventListener("click", () => {
      const text = currentSelectedRegion();
      if (!text) {
        body.querySelector(".rb-notice")?.remove();
        body.querySelector(".rb-error").insertAdjacentHTML("beforeend", '<div class="rb-notice">请先在网页中选择需要解释的文字。</div>');
        return;
      }
      explain(text.slice(0, 10000));
    });
  }

  async function processEasyRead(article, stageNode = null) {
    extractionNotice = article.truncated
      ? "这篇文章较长，阅桥已均衡选取开头、中间和结尾的重要内容。你也可以选中其他区域单独阅读。"
      : "";
    const send = async (payload) => {
      activeAIRequestId = crypto.randomUUID();
      console.info("ReadBridge EasyRead request", { requestId: activeAIRequestId, url: payload.url,
        strategy: payload.strategy || "", textLength: payload.text?.length || 0,
        blockCount: payload.content_blocks?.length || 0, degraded: Boolean(payload.degraded) });
      return chrome.runtime.sendMessage({ type: "READBRIDGE_EASY_READ", requestId: activeAIRequestId, payload });
    };
    let result = await send(article);
    const recoverable = new Set(["truncated_model_output", "response_validation_failed", "provider_timeout", "input_too_large", "invalid_model_output"]);
    if (!result?.success && result?.error?.retryable && recoverable.has(result.error.code) && !article.degraded) {
      if (stageNode) stageNode.textContent = "内容较长，正在用精简模式重试……";
      result = await send(balancedRetryArticle(article));
    }
    activeAIRequestId = "";
    if (!result?.success || !result.data) throw runtimeAIError(result?.error, "暂时无法生成易读内容。");
    if (stageNode) stageNode.textContent = "正在整理结果……";
    speechManager?.stop();
    speechQueue = [];
    speechControlsExpanded = false;
    speechControls.classList.remove("visible");
    easyReadData = result.data;
    reduceMode = false;
    stepMode = false;
    stepIndex = 0;
    syncModeButtons();
    setToolsVisible(true);
    renderEasyRead();
  }

  async function readSelectedRegion() {
    const text = currentSelectedRegion();
    if (text.length < MIN_SELECTED_REGION_LENGTH) {
      showExtractionFailure();
      return;
    }
    if (requestInFlight) return;
    speechManager?.stop();
    requestInFlight = true;
    body.innerHTML = loadingHtml("阅桥正在阅读选中区域……", "正在生成易读版本……");
    try {
      await processEasyRead({
        title: `${document.title.trim().slice(0, 450)}（选中区域）`,
        text,
        url: `${location.origin}${location.pathname}`.slice(0, 2000),
        truncated: false,
      });
    } catch (error) {
      showError("暂时无法阅读选中区域", friendlyRuntimeError(error, "无法连接阅桥AI服务，请检查服务器是否已经启动。"), readSelectedRegion);
    } finally {
      requestInFlight = false;
    }
  }

  async function simplifyCurrentPage() {
    openPanel();
    setToolsVisible(false);
    if (requestInFlight) return;
    speechManager?.stop();
    speechQueue = [];
    speechControls.classList.remove("visible");
    requestInFlight = true;
    const isDynamicDocument = /yuque\.com$/i.test(location.hostname);
    body.innerHTML = loadingHtml("阅桥正在理解这个网页……", isDynamicDocument ? "正在识别语雀正文……" : "正在提取正文……", true);
    const stageNode = body.querySelector("[data-loading-stage]");
    let canceled = false;
    let slowTimer = 0;
    body.querySelector("[data-cancel-request]")?.addEventListener("click", () => {
      canceled = true;
      if (activeAIRequestId) chrome.runtime.sendMessage({ type: "READBRIDGE_AI_CANCEL", requestId: activeAIRequestId });
      body.innerHTML = '<div class="rb-notice">已取消本次生成。</div>';
    });
    try {
      const article = await extractArticleWithRetry(stageNode);
      if (canceled) return;
      if (!article) {
        showExtractionFailure();
        return;
      }
      if (stageNode) stageNode.textContent = `已提取 ${article.content_blocks?.length || 0} 个内容块，正在生成易读版本……`;
      await wait(0);
      slowTimer = setTimeout(() => { if (stageNode && !canceled) stageNode.textContent = "文章较长，仍在认真整理，请稍候……"; }, 10000);
      await processEasyRead(article, stageNode);
    } catch (error) {
      if (!canceled) showEasyReadError(error, simplifyCurrentPage);
    } finally {
      clearTimeout(slowTimer);
      activeAIRequestId = "";
      requestInFlight = false;
    }
  }

  function reducedText(text) {
    const sentences = String(text || "").split(/(?<=[。！？!?])/).filter(Boolean);
    const short = sentences.slice(0, 2).join("");
    return short.length <= 100 ? short : `${short.slice(0, 100)}……`;
  }

  function displayedSections(allSections) {
    if (stepMode || !reduceMode || allSections.length <= 4) {
      return allSections.map((section, index) => ({ section, index }));
    }
    // 精简模式保留开头、中间和结尾的代表主题，避免只显示文章前部。
    const indexes = [...new Set(
      Array.from({ length: 4 }, (_, index) => Math.round(index * (allSections.length - 1) / 3)),
    )];
    return indexes.map((index) => ({ section: allSections[index], index }));
  }

  function speechButton(id, label = "朗读这一部分") {
    return `<button class="rb-speak-item" data-speak-item="${id}" type="button" aria-label="${escapeHtml(label)}" title="朗读这一部分">🔊</button>`;
  }

  function locateButton(id, item) {
    const hasEvidence = String(item?.source_text || "").trim()
      || (Array.isArray(item?.source_block_ids) && item.source_block_ids.length)
      || (id.startsWith("difficult-") && String(item?.word || "").trim());
    if (!hasEvidence) return "";
    return `<button class="rb-locate-source" data-locate-source="${escapeHtml(id)}" type="button" aria-label="定位到原文" title="定位到原文">📍</button>`;
  }

  function itemActions(speechId, sourceId, item, speechLabel) {
    return `<span class="rb-item-actions">${speechButton(speechId, speechLabel)}${locateButton(sourceId, item)}</span>`;
  }

  function moduleForLocation(id) {
    if (!easyReadData) return null;
    if (id === "summary") return {
      heading: "全文概览",
      content: easyReadData.one_sentence,
      sourceText: easyReadData.one_sentence_source_text || "",
      sourceBlockIds: easyReadData.one_sentence_source_block_ids || [],
    };
    let match = /^section-(\d+)$/.exec(id);
    if (match) {
      const item = easyReadData.sections?.[Number(match[1])];
      return item ? { heading: item.heading, content: item.content, sourceText: item.source_text, sourceBlockIds: item.source_block_ids || [] } : null;
    }
    match = /^key-point-(\d+)$/.exec(id);
    if (match) {
      const item = easyReadData.key_points?.[Number(match[1])];
      return item ? { label: item.label, value: item.value, sourceText: item.source_text, sourceBlockIds: item.source_block_ids || [] } : null;
    }
    match = /^difficult-(\d+)$/.exec(id);
    if (match) {
      const item = easyReadData.difficult_words?.[Number(match[1])];
      return item ? { word: item.word, content: item.simple, sourceText: item.source_text, sourceBlockIds: item.source_block_ids || [] } : null;
    }
    return null;
  }

  function showToast(message, duration = 1800) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), duration);
  }

  function locateOriginalSource(button) {
    const module = moduleForLocation(button.dataset.locateSource);
    if (!module || !sourceLocator) {
      showToast("没有找到可靠的原文位置。", 2400);
      return;
    }
    button.disabled = true;
    const originalText = button.textContent;
    try {
      const result = sourceLocator.locate(module);
      if (!result.success || !sourceLocator.scrollToMatch(result)) {
        showToast("没有找到可靠的原文位置。", 2400);
        return;
      }
      button.textContent = "✓";
      showToast("已定位到原文");
    } catch (error) {
      console.warn("ReadBridge SourceLocator", { error: error?.message || "location-error" });
      showToast("没有找到可靠的原文位置。", 2400);
    } finally {
      setTimeout(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }, 1200);
    }
  }

  function sectionHtml(section, index) {
    const contentText = reduceMode ? reducedText(section.content) : section.content;
    const source = section.source_text
      ? `<details class="rb-source"><summary>查看对应原文</summary><blockquote>原文依据：<br>${escapeHtml(section.source_text)}</blockquote></details>`
      : "";
    return `<article class="rb-card rb-speech-item" data-speech-id="section-${index}"><div class="rb-content-heading"><h3>${escapeHtml(section.icon || "📌")} ${escapeHtml(section.heading)}</h3>${itemActions(`section-${index}`, `section-${index}`, section)}</div><p>${escapeHtml(contentText)}</p>${source}</article>`;
  }

  function renderEasyRead() {
    if (!easyReadData) return;
    const allSections = Array.isArray(easyReadData.sections) ? easyReadData.sections : [];
    stepIndex = Math.min(stepIndex, Math.max(0, allSections.length - 1));
    const visibleEntries = stepMode
      ? [{ section: allSections[stepIndex], index: stepIndex }].filter((item) => item.section)
      : displayedSections(allSections);
    const points = (easyReadData.key_points || []).slice(0, reduceMode ? 2 : 5);
    const words = reduceMode ? [] : (easyReadData.difficult_words || []);
    const action = easyReadData.action || { needed: false, steps: [] };
    const pager = stepMode && allSections.length
      ? `<div class="rb-pager"><button data-page="prev" ${stepIndex === 0 ? "disabled" : ""}>← 上一段</button><span class="rb-progress">第 ${stepIndex + 1} / ${allSections.length} 段</span><button data-page="next" ${stepIndex >= allSections.length - 1 ? "disabled" : ""}>下一段 →</button></div>`
      : "";
    body.innerHTML = `
      <p class="rb-kicker">一键易读</p>
      <h2 class="rb-page-title">${escapeHtml(easyReadData.title)}</h2>
      ${extractionNotice ? `<p class="rb-notice">${escapeHtml(extractionNotice)}</p>` : ""}
      ${reduceMode && !stepMode && visibleEntries.length < allSections.length ? `<p class="rb-notice">当前为精简展示：从 ${allSections.length} 个主要部分中显示 ${visibleEntries.length} 个。关闭“减少内容”可查看完整内容。</p>` : ""}
      ${!stepMode && allSections.length ? `<nav class="rb-overview" aria-label="文章全貌"><p class="rb-overview-title">文章全貌 · 共整理出 ${allSections.length} 个主要部分</p><div class="rb-outline">${allSections.map((section, index) => `<button type="button" data-outline-index="${index}">${index + 1}. ${escapeHtml(section.heading)}</button>`).join("")}</div></nav>` : ""}
      <section class="rb-section rb-speech-item" data-speech-id="summary"><div class="rb-content-heading"><h2 class="rb-kicker">全文概览</h2>${itemActions("summary", "summary", { source_text: easyReadData.one_sentence_source_text, source_block_ids: easyReadData.one_sentence_source_block_ids })}</div><p class="rb-one">${escapeHtml(reduceMode ? reducedText(easyReadData.one_sentence) : easyReadData.one_sentence)}</p></section>
      <section class="rb-section">${visibleEntries.map(({ section, index }) => sectionHtml(section, index)).join("")}${pager}</section>
      ${!stepMode && points.length ? `<section class="rb-section rb-speech-item" data-speech-id="key-points"><div class="rb-content-heading"><h2 class="rb-kicker">📌 重点信息</h2>${speechButton("key-points", "朗读重点信息")}</div><div class="rb-key-points">${points.map((item) => {
        const point = typeof item === "string" ? { label: "重点", value: item, source_text: "" } : item;
        const source = point.source_text
          ? `<details class="rb-source"><summary>查看对应原文</summary><blockquote>原文依据：<br>${escapeHtml(point.source_text)}</blockquote></details>`
          : "";
        const pointIndex = easyReadData.key_points.indexOf(item);
        return `<div class="rb-word"><div class="rb-content-heading"><strong>${escapeHtml(point.label || "重点")}</strong>${locateButton(`key-point-${pointIndex}`, point)}</div>${escapeHtml(point.value || "")}${source}</div>`;
      }).join("")}</div></section>` : ""}
      ${!stepMode && words.length ? `<section class="rb-section"><h2 class="rb-kicker">📖 难词解释</h2>${words.map((item, index) => `<div class="rb-word rb-speech-item" data-speech-id="difficult-${index}"><div class="rb-content-heading"><strong>${escapeHtml(item.word)}</strong>${itemActions(`difficult-${index}`, `difficult-${index}`, item, `朗读难词${item.word}`)}</div>简单解释：${escapeHtml(item.simple)}${item.source_text ? `<details class="rb-source"><summary>查看对应原文</summary><blockquote>原文依据：<br>${escapeHtml(item.source_text)}</blockquote></details>` : ""}</div>`).join("")}</section>` : ""}
      ${!stepMode && action.needed ? `<section class="rb-section"><h2 class="rb-kicker">✅ ${escapeHtml(action.title || "你需要做什么？")}</h2><div class="rb-action">${(action.steps || []).map((item, index) => `${index + 1}. ${escapeHtml(item)}`).join("<br>")}</div></section>` : ""}`;
    body.querySelector('[data-page="prev"]')?.addEventListener("click", () => { stepIndex -= 1; renderEasyRead(); body.scrollTop = 0; });
    body.querySelector('[data-page="next"]')?.addEventListener("click", () => { stepIndex += 1; renderEasyRead(); body.scrollTop = 0; });
    body.querySelectorAll("[data-outline-index]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.outlineIndex);
      if (reduceMode && !visibleEntries.some((item) => item.index === index)) {
        reduceMode = false;
        syncModeButtons();
        renderEasyRead();
      }
      requestAnimationFrame(() => body.querySelector(`[data-speech-id="section-${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }));
    const activeItem = speechManager?.state.status !== "idle" ? speechManager.queue[speechManager.state.index] : null;
    if (activeItem) requestAnimationFrame(() => highlightSpeechItem(activeItem));
  }

  function syncModeButtons() {
    shadow.querySelector('[data-mode="reduce"]').setAttribute("aria-pressed", String(reduceMode));
    shadow.querySelector('[data-mode="step"]').setAttribute("aria-pressed", String(stepMode));
  }

  shadow.querySelectorAll("[data-font]").forEach((button) => {
    button.addEventListener("click", () => {
      const sizes = { small: "14px", normal: "16px", large: "19px" };
      panel.style.setProperty("--rb-font-size", sizes[button.dataset.font]);
    });
  });
  shadow.querySelector('[data-mode="reduce"]').addEventListener("click", () => {
    speechManager?.stop();
    reduceMode = !reduceMode;
    syncModeButtons();
    renderEasyRead();
  });
  shadow.querySelector('[data-mode="step"]').addEventListener("click", () => {
    speechManager?.stop();
    stepMode = !stepMode;
    stepIndex = 0;
    syncModeButtons();
    renderEasyRead();
  });
  shadow.querySelector("[data-window-mode]").addEventListener("click", toggleWindowMode);
  shadow.querySelector("[data-reset-window]").addEventListener("click", resetWindow);
  shadow.querySelector("[data-speech-all]").addEventListener("click", () => {
    if (speechManager?.state.status === "playing") speechManager.pause();
    else if (speechManager?.state.status === "paused") speechManager.resume();
    else if (speechManager?.state.status === "preparing") return;
    else startAllSpeech();
  });
  shadow.querySelector("[data-speech-prev]").addEventListener("click", () => speechManager?.previous());
  shadow.querySelector("[data-speech-next]").addEventListener("click", () => speechManager?.next());
  shadow.querySelector("[data-speech-stop]").addEventListener("click", () => speechManager?.stop());
  shadow.querySelector("[data-speech-test]").addEventListener("click", () => {
    speechControlsExpanded = true;
    speechControls.classList.add("visible");
    speechManager?.playSingle({ id: "voice-test", title: "声音试听", text: "你好，我是阅桥，很高兴陪你一起阅读。" });
  });
  shadow.querySelector("[data-speech-rate]").addEventListener("change", (event) => {
    const rate = Number(event.target.value);
    speechManager?.setRate(rate);
    chrome.storage.local.set({ readbridgeSpeechRate: rate });
    announceSpeech(`语速已设置为 ${rate} 倍`);
  });
  shadow.querySelector("[data-speech-provider]").addEventListener("change", async (event) => {
    const provider = event.target.value;
    speechManager?.setProvider(provider);
    chrome.storage.local.set({ readbridgeSpeechProvider: provider, readbridgeSpeechVoice: "" });
    await refreshSpeechVoices();
    announceSpeech(provider === "neural" ? "已选择神经语音" : "已选择系统语音");
  });
  shadow.querySelector("[data-speech-voice]").addEventListener("change", (event) => {
    speechManager?.setVoice(event.target.value);
    chrome.storage.local.set({ readbridgeSpeechVoice: event.target.value });
    announceSpeech("朗读音色已更新");
  });
  shadow.querySelector("[data-speech-error]").addEventListener("click", (event) => {
    const box = event.currentTarget;
    if (event.target.closest("[data-use-browser]")) {
      box.classList.remove("visible");
      box._useBrowser?.();
    } else if (event.target.closest("[data-speech-retry]")) {
      box.classList.remove("visible");
      lastSpeechRetry?.();
    }
  });
  body.addEventListener("click", (event) => {
    const locate = event.target.closest("[data-locate-source]");
    if (locate) {
      locateOriginalSource(locate);
      return;
    }
    const button = event.target.closest("[data-speak-item]");
    if (button) playSpeechItem(button.dataset.speakItem);
  });
  addEventListener("beforeunload", () => {
    speechManager?.destroy();
    sourceLocator?.clearHighlight();
  }, { once: true });
  updateSpeechControls(speechManager?.state || { status: "idle", mode: null, index: -1 });

  trigger.addEventListener("mousedown", (event) => event.preventDefault());
  trigger.addEventListener("click", () => {
    hideTrigger();
    if (selectedText) explain(selectedText);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "READBRIDGE_START_READING") {
      openPanel();
      if (!requestInFlight) simplifyCurrentPage();
      sendResponse({ accepted: true });
    }
    return false;
  });
})();
