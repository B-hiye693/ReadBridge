const port = process.argv[2] || "9225";
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("speech-ui-fixture.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!target) throw new Error("未找到语音UI测试页面");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data); const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message); }
});
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await call("DOM.enable"); await call("Runtime.enable");
const attrs = (node) => Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
const findNode = (root, predicate) => {
  if (predicate(root)) return root;
  for (const child of [...(root.children || []), ...(root.shadowRoots || [])]) { const found = findNode(child, predicate); if (found) return found; }
  return null;
};
const tree = async () => (await call("DOM.getDocument", { depth: -1, pierce: true })).result.root;
const byAttr = async (name, value = null) => findNode(await tree(), (node) => Object.hasOwn(attrs(node), name) && (value === null || attrs(node)[name] === value));
const byClass = async (name) => findNode(await tree(), (node) => (attrs(node).class || "").split(/\s+/).includes(name));
const box = async (node) => {
  const quad = (await call("DOM.getBoxModel", { nodeId: node.nodeId })).result.model.border;
  return { x: (quad[0] + quad[4]) / 2, y: (quad[1] + quad[5]) / 2 };
};
const click = async (node) => {
  const point = await box(node);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await wait(30);
};
const activate = async (node) => {
  const resolved = await call("DOM.resolveNode", { nodeId: node.nodeId });
  await call("Runtime.callFunctionOn", { objectId: resolved.result.object.objectId, functionDeclaration: "function(){ this.click(); }" });
  await wait(30);
};

await call("Runtime.evaluate", { expression: "window.__rbRuntimeListener({type:'READBRIDGE_START_READING'}, {}, () => {})" });
await wait(250);
await click(await byAttr("data-speech-all"));
await wait(30);
const highlightedSummary = (attrs(await byAttr("data-speech-id", "summary")).class || "").includes("is-speaking");
await click(await byAttr("data-speech-all"));
const paused = (await call("Runtime.evaluate", { expression: "window.__fakeSpeech.paused", returnByValue: true })).result.result.value;
await click(await byAttr("data-speech-all"));
const resumed = !(await call("Runtime.evaluate", { expression: "window.__fakeSpeech.paused", returnByValue: true })).result.result.value;
await click(await byAttr("data-speech-next"));
await wait(30);
const highlightedSection = (attrs(await byAttr("data-speech-id", "section-0")).class || "").includes("is-speaking");
await activate(await byAttr("data-speak-item", "difficult-0"));
const rateNode = await byAttr("data-speech-rate");
const rateObject = await call("DOM.resolveNode", { nodeId: rateNode.nodeId });
await call("Runtime.callFunctionOn", { objectId: rateObject.result.object.objectId, functionDeclaration: "function(){ this.value='1.5'; this.dispatchEvent(new Event('change',{bubbles:true})); }" });
const providerNode = await byAttr("data-speech-provider");
const providerObject = await call("DOM.resolveNode", { nodeId: providerNode.nodeId });
await call("Runtime.callFunctionOn", { objectId: providerObject.result.object.objectId, functionDeclaration: "function(){ this.value='browser'; this.dispatchEvent(new Event('change',{bubbles:true})); }" });
const voiceNode = await byAttr("data-speech-voice");
const voiceObject = await call("DOM.resolveNode", { nodeId: voiceNode.nodeId });
await call("Runtime.callFunctionOn", { objectId: voiceObject.result.object.objectId, functionDeclaration: "function(){ if(this.options.length>1) this.selectedIndex=1; this.dispatchEvent(new Event('change',{bubbles:true})); }" });
await activate(await byAttr("data-speak-item", "summary"));
const beforeModeCancel = (await call("Runtime.evaluate", { expression: "window.__fakeSpeech.cancelCount", returnByValue: true })).result.result.value;
await click(await byAttr("data-window-mode"));
const afterModeCancel = (await call("Runtime.evaluate", { expression: "window.__fakeSpeech.cancelCount", returnByValue: true })).result.result.value;
await click(await byAttr("data-speech-stop"));
await click(await byAttr("data-speech-test"));
await wait(30);
await activate(await byAttr("data-speak-item", "summary"));
const beforeCloseCancel = (await call("Runtime.evaluate", { expression: "window.__fakeSpeech.cancelCount", returnByValue: true })).result.result.value;
await click(await byClass("rb-close"));
const runtime = await call("Runtime.evaluate", {
  expression: "({speech:window.__fakeSpeech, messages:window.__rbMessageCount, storage:JSON.parse(localStorage.getItem('rb-speech-storage')||'{}'), errors:window.__rbErrors})",
  returnByValue: true,
});
const value = runtime.result.result.value;
const spokenText = value.speech.spoken.map((item) => item.text).join(" ");
const report = {
  highlightedSummary,
  paused,
  resumed,
  highlightedSection,
  localSpeechWorked: spokenText.includes("难词：MQTT"),
  voiceTestWorked: spokenText.includes("你好，我是阅桥，很高兴陪你一起阅读"),
  rateApplied: value.speech.spoken.some((item) => item.rate === 1.5),
  rateSaved: value.storage.readbridgeSpeechRate === 1.5,
  providerSaved: value.storage.readbridgeSpeechProvider === "browser",
  voiceSaved: typeof value.storage.readbridgeSpeechVoice === "string",
  modeSwitchKeptSpeech: beforeModeCancel === afterModeCancel,
  closeStoppedSpeech: value.speech.cancelCount > beforeCloseCancel,
  sourceTextExcluded: !spokenText.includes("绝不能朗读") && !spokenText.includes("隐藏依据"),
  noExtraAIRequest: value.messages === 1,
  spoken: value.speech.spoken,
  errors: value.errors,
};
report.pass = Object.entries(report).every(([key, item]) => key === "errors" ? item.length === 0 : ["pass", "spoken"].includes(key) || item === true);
console.log(JSON.stringify(report, null, 2));
socket.close();
