import assert from "node:assert/strict";
import "../../apps/browser-extension/speech.js";

class FakeAudio {
  constructor() { this.src = ""; this.paused = true; this.playCount = 0; this.onended = null; this.onerror = null; this.onplaying = null; }
  async play() { this.paused = false; this.playCount += 1; this.onloadstart?.(); this.oncanplay?.(); queueMicrotask(() => this.onplaying?.()); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  finish() { this.onended?.(); }
}

const validWav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(244)]).toString("base64");
const requests = [];
const canceled = [];
const audios = [];
const manager = new globalThis.ReadBridgeSpeechManager({
  provider: "neural",
  requestNeural: async (payload, id) => { requests.push({ payload, id }); return { audioBase64: validWav, contentType: "audio/wav" }; },
  cancelNeural: (id) => canceled.push(id),
  audioFactory: () => { const audio = new FakeAudio(); audios.push(audio); return audio; },
});
manager.setRate(0.9);
manager.setVoice("natural-female");
manager.playAll([
  { id: "one", title: "标题", text: "第一段内容。" },
  { id: "two", title: "下一段", text: "第二段内容。" },
]);
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(audios.length, 1);
assert.equal(requests[0].payload.rate, 0.9);
assert.equal(requests[0].payload.voice, "natural-female");
assert.equal(manager.state.index, 0);
manager.pause(); assert.equal(audios[0].paused, true);
manager.resume(); assert.equal(audios[0].paused, false);
audios[0].finish();
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(manager.state.index, 1);
manager.previous();
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(manager.state.index, 0);

let resolveSlow;
const slow = new globalThis.ReadBridgeSpeechManager({
  provider: "neural",
  requestNeural: (_payload, id) => new Promise((resolve) => { requests.push({ id }); resolveSlow = resolve; }),
  cancelNeural: (id) => canceled.push(id),
  audioFactory: () => { throw new Error("停止后不应创建或播放音频"); },
});
slow.playSingle({ id: "slow", title: "慢请求", text: "等待生成。" });
await new Promise((resolve) => setTimeout(resolve, 5));
slow.stop();
assert.ok(canceled.some((id) => id.includes("0-0")));
resolveSlow({ audioBase64: validWav, contentType: "audio/wav" });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(slow.state.status, "idle");

const failures = [];
const rejected = new globalThis.ReadBridgeSpeechManager({
  provider: "neural",
  requestNeural: async () => ({ audioBase64: validWav, contentType: "audio/wav" }),
  audioFactory: () => ({ src: "", preload: "", pause() {}, removeAttribute() {}, play: () => Promise.reject(Object.assign(new Error("autoplay blocked"), { name: "NotAllowedError" })) }),
  onError: (error) => failures.push(error),
});
rejected.playSingle({ id: "reject", title: "测试", text: "播放失败。" });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(rejected.state.status, "error");
assert.equal(failures[0].code, "NotAllowedError");

const invalidFailures = [];
const invalid = new globalThis.ReadBridgeSpeechManager({
  provider: "neural",
  requestNeural: async () => ({ audioBase64: "e30=", contentType: "application/json" }),
  onError: (error) => invalidFailures.push(error),
});
invalid.playSingle({ id: "invalid", title: "测试", text: "无效音频。" });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(invalidFailures[0].code, "invalid_audio_response");

assert.ok(globalThis.ReadBridgeSpeechManager.splitText(`说明网址 https://example.com/a/very/long/path?x=1。${"长句，".repeat(120)}`, 180).length > 1);
manager.destroy(); slow.destroy(); rejected.destroy(); invalid.destroy();
console.log(JSON.stringify({ pass: true, requests: requests.length, canceled: canceled.length }));
