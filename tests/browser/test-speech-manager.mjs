import assert from "node:assert/strict";
import "../../apps/browser-extension/speech.js";

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = "";
    this.rate = 1;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

class FakeSynth {
  constructor(voices = []) {
    this.voices = voices;
    this.spoken = [];
    this.current = null;
    this.paused = false;
    this.cancelCount = 0;
    this.listeners = new Map();
  }
  getVoices() { return this.voices; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  speak(utterance) { this.current = utterance; this.spoken.push(utterance); utterance.onstart?.(); }
  cancel() { this.cancelCount += 1; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  finish() { const item = this.current; this.current = null; item?.onend?.(); }
  fail(error = "synthesis-failed") { const item = this.current; this.current = null; item?.onerror?.({ error }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const voices = [
  { name: "中文", lang: "zh-CN" },
  { name: "English US", lang: "en-US" },
  { name: "English UK", lang: "en-GB" },
];
const synth = new FakeSynth(voices);
const states = [];
const items = [];
const errors = [];
const manager = new globalThis.ReadBridgeSpeechManager({
  synth,
  Utterance: FakeUtterance,
  onStateChange: (state) => states.push(state),
  onItemChange: (item) => items.push(item?.id || null),
  onError: (error) => errors.push(error),
});

assert.equal(globalThis.ReadBridgeSpeechManager.normalizeSpeechText("💥 发生了什么？\n 火箭升空"), "发生了什么？。火箭升空");
assert.equal(globalThis.ReadBridgeSpeechManager.detectLanguage("JWT 是一种身份凭证，客户端使用它连接。"), "zh-CN");
assert.equal(globalThis.ReadBridgeSpeechManager.detectLanguage("This is an English document about MQTT."), "en-US");
assert.ok(globalThis.ReadBridgeSpeechManager.splitText("第一句。".repeat(100)).length > 1);
assert.deepEqual(globalThis.ReadBridgeSpeechManager.normalizeSpeechError({ code: "invalid_voice", message: "音色无效", request_id: "req-1" }), {
  code: "invalid_voice", message: "音色无效", providerStatus: undefined, requestId: "req-1",
});
assert.equal(globalThis.ReadBridgeSpeechManager.normalizeSpeechError({ details: {} }).message.includes("[object Object]"), false);

const queue = [
  { id: "summary", title: "一句话理解", text: "这是中文摘要。" },
  { id: "section-0", title: "What happened", text: "The service started successfully." },
];
assert.equal(manager.playAll(queue), true);
await tick();
assert.equal(manager.state.status, "playing");
assert.equal(manager.state.mode, "all");
assert.equal(synth.current.lang, "zh-CN");
assert.equal(synth.current.voice.lang, "zh-CN");
assert.equal(synth.current.text.includes("source_text"), false);

manager.pause();
assert.equal(manager.state.status, "paused");
assert.equal(synth.paused, true);
manager.resume();
assert.equal(manager.state.status, "playing");
assert.equal(synth.paused, false);

synth.finish();
await tick();
assert.equal(manager.state.index, 1);
assert.equal(synth.current.lang, "en-US");
assert.equal(synth.current.voice.lang, "en-US");

manager.previous();
await tick();
assert.equal(manager.state.index, 0);
manager.next();
await tick();
assert.equal(manager.state.index, 1);
manager.next();
assert.equal(manager.state.status, "idle");

manager.setRate(1.5);
manager.playSingle({ id: "word", title: "难词：SCRAM", text: "简单解释：一种双向认证方式。" });
await tick();
assert.equal(manager.state.mode, "single");
assert.equal(synth.current.rate, 1.5);
assert.equal(synth.current.lang, "zh-CN");

const stale = synth.current;
manager.playSingle({ id: "other", title: "地点", text: "海南文昌。" });
await tick();
stale.onend?.();
assert.equal(manager.queue[0].id, "other");
assert.equal(manager.state.status, "playing");

synth.fail();
assert.equal(errors.length, 1);
assert.equal(manager.state.status, "error");
assert.equal(errors[0].code, "synthesis-failed");
manager.stop();
assert.equal(manager.state.status, "idle");
assert.equal(items.at(-1), null);

const noVoiceSynth = new FakeSynth([]);
const fallback = new globalThis.ReadBridgeSpeechManager({ synth: noVoiceSynth, Utterance: FakeUtterance });
fallback.playSingle({ id: "fallback", title: "标题", text: "使用默认声音。" });
await new Promise((resolve) => setTimeout(resolve, 1600));
assert.equal(noVoiceSynth.current.voice, null);
fallback.destroy();

const delayedSynth = new FakeSynth(voices);
delayedSynth.speak = function (utterance) { this.current = utterance; this.spoken.push(utterance); };
const delayed = new globalThis.ReadBridgeSpeechManager({ synth: delayedSynth, Utterance: FakeUtterance });
delayed.playSingle({ id: "delayed", title: "试听", text: "等待真正开始。" });
await tick();
assert.equal(delayed.state.status, "preparing");
delayedSynth.current.onstart();
assert.equal(delayed.state.status, "playing");
delayed.destroy();
manager.destroy();

console.log(JSON.stringify({
  pass: true,
  spokenUtterances: synth.spoken.length,
  stateTransitions: states.length,
  itemTransitions: items,
  cancelCount: synth.cancelCount,
}, null, 2));
