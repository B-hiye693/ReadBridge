(() => {
  "use strict";
  const ALLOWED_RATES = [0.75, 0.9, 1, 1.25, 1.5];
  const START_TIMEOUT_MS = 10000;
  function normalizeSpeechError(error, fallback = "语音朗读失败，请稍后重试。") {
    if (error instanceof Error) return { code: error.code || error.name || "speech_error", message: error.message || fallback, providerStatus: error.providerStatus, requestId: error.requestId || "" };
    if (typeof error === "string") return { code: "speech_error", message: error || fallback, requestId: "" };
    if (error && typeof error === "object") return {
      code: String(error.code || error.name || error.details?.code || "speech_error"),
      message: String(error.message || error.details?.message || fallback),
      providerStatus: error.providerStatus ?? error.provider_status,
      requestId: String(error.requestId || error.request_id || ""),
    };
    return { code: "speech_error", message: fallback, requestId: "" };
  }
  const normalize = (value) => String(value || "").replace(/[\p{Extended_Pictographic}\uFE0F]/gu, " ").replace(/[\u200B-\u200D\u2060]/g, "").replace(/[ \t]+/g, " ").replace(/\s*\n+\s*/g, "。").replace(/。{2,}/g, "。").trim();
  const detectLanguage = (value) => {
    const text = normalize(value), zh = (text.match(/[\u3400-\u9FFF]/g) || []).length, en = (text.match(/[A-Za-z]/g) || []).length;
    return zh && zh >= en * 0.18 ? "zh-CN" : "en-US";
  };
  function splitText(value, limit = 180, firstLimit = 80) {
    const text = normalize(value); if (!text) return [];
    const units = text.match(/(?:https?:\/\/\S+|[A-Za-z0-9][A-Za-z0-9._/+:#-]*|[^。！？!?；;，,]+[。！？!?；;，,]?)/g) || [text];
    const chunks = []; let current = "";
    const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
    for (const unit of units) {
      const activeLimit = chunks.length === 0 ? firstLimit : limit;
      if (current && current.length + unit.length > activeLimit) flush();
      if (unit.length <= activeLimit) { current += unit; continue; }
      flush();
      if (/^(?:https?:\/\/|[A-Za-z0-9._/+:#-]+$)/.test(unit)) chunks.push(unit);
      else {
        let rest = unit;
        while (rest.length > (chunks.length === 0 ? firstLimit : limit)) {
          const chunkLimit = chunks.length === 0 ? firstLimit : limit;
          const windowText = rest.slice(0, chunkLimit + 1);
          const boundary = Math.max(windowText.lastIndexOf("，"), windowText.lastIndexOf("、"), windowText.lastIndexOf(" "));
          const cut = boundary >= Math.floor(chunkLimit * 0.55) ? boundary + 1 : chunkLimit;
          chunks.push(rest.slice(0, cut).trim()); rest = rest.slice(cut);
        }
        current = rest;
      }
    }
    flush(); return chunks;
  }

  class BrowserSpeechProvider {
    constructor(options = {}) {
      this.name = "browser"; this.synth = options.synth ?? globalThis.speechSynthesis ?? null;
      this.Utterance = options.Utterance ?? globalThis.SpeechSynthesisUtterance ?? null;
      this.voices = []; this.voiceId = ""; this.onVoicesChanged = options.onVoicesChanged || (() => {});
      this._refresh = this.refreshVoices.bind(this); this.refreshVoices(); this.synth?.addEventListener?.("voiceschanged", this._refresh);
    }
    get supported() { return Boolean(this.synth && this.Utterance); }
    refreshVoices() { this.voices = this.synth?.getVoices?.() || []; const result = this.listVoices(); this.onVoicesChanged(result); return result; }
    async whenVoicesReady(timeout = 1500) {
      if (this.voices.length) return this.voices;
      const started = Date.now();
      while (!this.voices.length && Date.now() - started < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        this.refreshVoices();
      }
      return this.voices;
    }
    listVoices() { return this.voices.map((v) => ({ id: v.voiceURI || v.name, name: v.name, language: v.lang, gender: "unknown" })); }
    setVoice(id) { this.voiceId = String(id || ""); }
    scoreVoice(v, lang) {
      const name = `${v.name} ${v.voiceURI}`.toLowerCase(), voiceLang = String(v.lang || "").toLowerCase();
      let score = voiceLang === lang.toLowerCase() ? 100 : voiceLang.startsWith(lang.slice(0, 2).toLowerCase()) ? 60 : -100;
      if (/natural|neural|xiaoxiao|yunxi|yunyang|晓晓|云希|云扬/.test(name)) score += 45;
      if (/microsoft/.test(name)) score += 30; if (/google/.test(name)) score += 22; if (v.localService) score += 4;
      if (/compact|espeak|festival|sin-ji|ting-ting/.test(name)) score -= 25; return score;
    }
    selectVoice(lang) {
      const selected = this.voices.find((v) => (v.voiceURI || v.name) === this.voiceId);
      if (selected && String(selected.lang).toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())) return selected;
      return [...this.voices].sort((a, b) => this.scoreVoice(b, lang) - this.scoreVoice(a, lang))[0] || null;
    }
    speak(text, rate, handlers) {
      const u = new this.Utterance(text), lang = detectLanguage(text); u.lang = lang; u.rate = rate; u.pitch = 1; u.voice = this.selectVoice(lang);
      u.onstart = handlers.onstart; u.onend = handlers.onend; u.onerror = handlers.onerror; this.synth.speak(u); return u;
    }
    pause() { this.synth?.pause(); } resume() { this.synth?.resume(); } stop() { this.synth?.cancel(); }
    destroy() { this.stop(); this.synth?.removeEventListener?.("voiceschanged", this._refresh); }
  }

  class NeuralTTSProvider {
    constructor(options = {}) {
      this.name = "neural"; this.request = options.requestNeural || (() => Promise.reject(new Error("神经语音未连接")));
      this.cancel = options.cancelNeural || (() => {}); this.audioFactory = options.audioFactory || (() => new Audio());
      this.urls = new Set(); this.pending = new Set();
    }
    get supported() { return true; }
    async prepare(text, settings, requestId) {
      this.pending.add(requestId);
      try {
        const result = await this.request({ text, language: detectLanguage(text), ...settings }, requestId);
        if (!result?.audioBase64 || result.audioBase64.length < 32) throw { code: "invalid_audio_response", message: "语音服务没有返回有效音频。" };
        if (!String(result.contentType || "").toLowerCase().startsWith("audio/")) throw { code: "invalid_audio_response", message: "语音服务返回了错误的内容类型。" };
        let binary;
        try { binary = atob(result.audioBase64); } catch { throw { code: "invalid_audio_response", message: "语音音频 Base64 无法解码。" }; }
        if (binary.length < 128) throw { code: "invalid_audio_response", message: "语音音频为空或不完整。" };
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType })); this.urls.add(url); return url;
      } finally { this.pending.delete(requestId); }
    }
    createAudio(url) { const audio = this.audioFactory(); audio.preload = "auto"; audio.src = url; return audio; }
    release(url) { if (url && this.urls.delete(url)) URL.revokeObjectURL(url); }
    stop() { for (const id of this.pending) this.cancel(id); this.pending.clear(); }
    destroy() { this.stop(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); }
  }

  class ReadBridgeSpeechManager {
    constructor(options = {}) {
      this.onStateChange = options.onStateChange || (() => {}); this.onItemChange = options.onItemChange || (() => {}); this.onError = options.onError || (() => {});
      this.rate = ALLOWED_RATES.includes(Number(options.rate)) ? Number(options.rate) : 0.9; this.voice = options.voice || "";
      this.providerName = options.provider === "neural" ? "neural" : "browser"; this.browser = new BrowserSpeechProvider(options); this.neural = new NeuralTTSProvider(options);
      this.queue = []; this.state = { status: "idle", mode: null, index: -1, provider: this.providerName }; this.chunkIndex = 0; this.sessionId = 0;
      this.currentUtterance = null; this.currentAudio = null; this.currentUrl = ""; this.prefetch = null; this.supported = this.providerName === "neural" || this.browser.supported;
      this.startTimer = 0;
    }
    static normalizeSpeechText = normalize; static detectLanguage = detectLanguage; static splitText = splitText; static normalizeSpeechError = normalizeSpeechError;
    setRate(rate) { const value = Number(rate); if (ALLOWED_RATES.includes(value)) this.rate = value; }
    setVoice(voice) { this.voice = String(voice || ""); this.browser.setVoice(this.voice); }
    setProvider(provider) { this.stop(); this.providerName = provider === "neural" ? "neural" : "browser"; this.supported = this.providerName === "neural" || this.browser.supported; this._setState("idle", null, -1); }
    getProvider() { return this.providerName; } getBrowserVoices() { return this.browser.refreshVoices(); }
    playAll(items, startIndex = 0) { if (!this.supported || !items?.length) return false; this._begin(items, "all", startIndex); return true; }
    playSingle(item) { if (!this.supported || !item) return false; this._begin([item], "single", 0); return true; }
    pause() { if (this.state.status !== "playing") return; this.providerName === "neural" ? this.currentAudio?.pause() : this.browser.pause(); this._setState("paused", this.state.mode, this.state.index); }
    resume() { if (this.state.status !== "paused") return; if (this.providerName === "neural") { this._setState("preparing", this.state.mode, this.state.index); this.currentAudio?.play().catch((e) => this._fail(e)); } else { this.browser.resume(); this._setState("playing", this.state.mode, this.state.index); } }
    stop() {
      this.sessionId += 1; clearTimeout(this.startTimer); this.startTimer = 0; this.browser.stop(); this.neural.stop(); if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio.removeAttribute?.("src"); }
      this.neural.release(this.currentUrl); if (this.prefetch?.url) this.neural.release(this.prefetch.url);
      this.currentAudio = null; this.currentUrl = ""; this.prefetch = null; this.currentUtterance = null; this.queue = []; this.chunkIndex = 0;
      this._setState("idle", null, -1); this.onItemChange(null, this.state);
    }
    previous() { if (this.state.mode === "all" && this.queue.length) this._jump(Math.max(0, this.state.index - 1)); }
    next() { if (this.state.mode !== "all" || !this.queue.length) return; this.state.index >= this.queue.length - 1 ? this.stop() : this._jump(this.state.index + 1); }
    destroy() { this.stop(); this.browser.destroy(); this.neural.destroy(); }
    _begin(items, mode, index) {
      this.stop(); const session = ++this.sessionId;
      this.queue = items.map((item, i) => ({ ...item, id: item.id || `speech-${i}`, title: normalize(item.title), text: normalize(item.text), chunks: splitText(`${normalize(item.title)}。${normalize(item.text)}`) })).filter((item) => item.chunks.length);
      if (!this.queue.length) return; const safe = Math.min(Math.max(index, 0), this.queue.length - 1);
      this.chunkIndex = 0; this._setState("preparing", mode, safe); this.onItemChange(this.queue[safe], this.state); queueMicrotask(() => session === this.sessionId && this._playCurrent(session));
    }
    _jump(index) {
      const saved = this.queue, mode = this.state.mode; this.sessionId += 1; this.browser.stop(); this.neural.stop(); if (this.currentAudio) this.currentAudio.pause();
      this.neural.release(this.currentUrl); if (this.prefetch?.url) this.neural.release(this.prefetch.url); this.currentAudio = null; this.currentUrl = ""; this.prefetch = null; this.queue = saved;
      const session = this.sessionId; this.chunkIndex = 0; this._setState("preparing", mode, index); this.onItemChange(this.queue[index], this.state); queueMicrotask(() => session === this.sessionId && this._playCurrent(session));
    }
    _playCurrent(session) {
      if (session !== this.sessionId || this.state.status === "idle") return; const item = this.queue[this.state.index], text = item?.chunks[this.chunkIndex]; if (!text) return this._advance(session);
      if (this.providerName === "browser") this._playBrowser(text, item, session);
      else this._playNeural(text, item, session);
    }
    async _playBrowser(text, item, session) {
      await this.browser.whenVoicesReady();
      if (session !== this.sessionId) return;
        this._setState("preparing", this.state.mode, this.state.index);
        this.startTimer = setTimeout(() => this._fail({ code: "speech_start_timeout", message: `系统语音没有开始播放。请检查标签页是否静音，并尝试试听其他音色（paused=${Boolean(this.browser.synth?.paused)}, pending=${Boolean(this.browser.synth?.pending)}, speaking=${Boolean(this.browser.synth?.speaking)}）。` }, item, session), START_TIMEOUT_MS);
        this.currentUtterance = this.browser.speak(text, this.rate, {
          onstart: () => { if (session !== this.sessionId) return; clearTimeout(this.startTimer); this._setState("playing", this.state.mode, this.state.index); },
          onend: () => { if (session !== this.sessionId) return; clearTimeout(this.startTimer); this._advance(session); },
          onerror: (event) => { if (session !== this.sessionId || ["canceled", "interrupted"].includes(event?.error)) return; clearTimeout(this.startTimer); this._fail({ code: event?.error || "speech_error", message: `系统语音播放失败（${event?.error || "未知错误"}）。` }, item, session); },
        });
    }
    async _playNeural(text, item, session) {
      try {
        const requestId = `${session}-${this.state.index}-${this.chunkIndex}`;
        let url; if (this.prefetch?.key === requestId) { url = await this.prefetch.promise; this.prefetch.url = url; } else url = await this.neural.prepare(text, { voice: this.voice, rate: this.rate, style: "warm" }, requestId);
        if (session !== this.sessionId) { this.neural.release(url); return; }
        this.currentUrl = url; const audio = this.neural.createAudio(url); this.currentAudio = audio;
        const mediaErrors = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
        audio.onloadstart = () => session === this.sessionId && this._setState("preparing", this.state.mode, this.state.index);
        audio.oncanplay = () => {};
        audio.onplaying = () => { if (session !== this.sessionId) return; clearTimeout(this.startTimer); this._setState("playing", this.state.mode, this.state.index); this._prefetchNext(session); };
        audio.onpause = () => {};
        audio.onended = () => { if (session === this.sessionId) { clearTimeout(this.startTimer); this.neural.release(url); this.currentUrl = ""; this._advance(session); } };
        audio.onerror = () => { const code = mediaErrors[audio.error?.code] || "MEDIA_ERR_UNKNOWN"; this._fail({ code: code.toLowerCase(), message: `生成的音频无法播放（${code}）。` }, item, session); };
        this._setState("preparing", this.state.mode, this.state.index);
        this.startTimer = setTimeout(() => this._fail({ code: "audio_start_timeout", message: "神经语音已经生成，但浏览器没有开始播放。请检查标签页是否静音。" }, item, session), START_TIMEOUT_MS);
        await audio.play();
      } catch (error) { if (session === this.sessionId && error?.code !== "canceled") this._fail(error, item, session); }
    }
    _prefetchNext(session) {
      let index = this.state.index, chunk = this.chunkIndex + 1; if (chunk >= this.queue[index].chunks.length) { index += 1; chunk = 0; }
      if (index >= this.queue.length || (this.state.mode !== "all" && index !== this.state.index)) return;
      const key = `${session}-${index}-${chunk}`, text = this.queue[index].chunks[chunk];
      const entry = { key, promise: this.neural.prepare(text, { voice: this.voice, rate: this.rate, style: "warm" }, key), url: "" };
      this.prefetch = entry;
      entry.promise.then((url) => { entry.url = url; if (session !== this.sessionId) this.neural.release(url); }).catch(() => {});
    }
    _fail(error, item = this.queue[this.state.index], session = this.sessionId) {
      if (session !== this.sessionId) return;
      clearTimeout(this.startTimer);
      const normalized = normalizeSpeechError(error);
      this.currentAudio?.pause(); this.currentAudio?.removeAttribute?.("src");
      this.neural.stop(); this.neural.release(this.currentUrl); if (this.prefetch?.url) this.neural.release(this.prefetch.url);
      this.currentAudio = null; this.currentUrl = ""; this.prefetch = null;
      this._setState("error", this.state.mode, this.state.index);
      this.onError(normalized, item, { provider: this.providerName, retry: () => this._jump(this.state.index) });
    }
    _advance(session) {
      if (session !== this.sessionId) return; const item = this.queue[this.state.index];
      if (this.chunkIndex < item.chunks.length - 1) { this.chunkIndex += 1; this._setState("preparing", this.state.mode, this.state.index); this._playCurrent(session); return; }
      if (this.state.mode === "all" && this.state.index < this.queue.length - 1) { this.chunkIndex = 0; const next = this.state.index + 1; this._setState("preparing", "all", next); this.onItemChange(this.queue[next], this.state); this._playCurrent(session); return; }
      this.stop();
    }
    _setState(status, mode, index) { this.state = { status, mode, index, provider: this.providerName }; this.onStateChange({ ...this.state }); }
  }
  globalThis.ReadBridgeBrowserSpeechProvider = BrowserSpeechProvider;
  globalThis.ReadBridgeNeuralTTSProvider = NeuralTTSProvider;
  globalThis.ReadBridgeNormalizeSpeechError = normalizeSpeechError;
  globalThis.ReadBridgeSpeechManager = ReadBridgeSpeechManager;
})();
