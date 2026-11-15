const port = process.argv[2] || "9251";
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("speech-ui-fixture.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!target) throw new Error("未找到阅读模式测试页面");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message); }
});
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await call("DOM.enable"); await call("Runtime.enable");
const attrs = (node) => Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
const collect = (root, predicate, result = []) => {
  if (predicate(root)) result.push(root);
  for (const child of [...(root.children || []), ...(root.shadowRoots || [])]) collect(child, predicate, result);
  return result;
};
const tree = async () => (await call("DOM.getDocument", { depth: -1, pierce: true })).result.root;
const byAttr = async (name, value = null) => collect(await tree(), (node) => Object.hasOwn(attrs(node), name) && (value === null || attrs(node)[name] === value))[0];
const byClass = async (name) => collect(await tree(), (node) => (attrs(node).class || "").split(/\s+/).includes(name));
const activate = async (node) => {
  const resolved = await call("DOM.resolveNode", { nodeId: node.nodeId });
  await call("Runtime.callFunctionOn", { objectId: resolved.result.object.objectId, functionDeclaration: "function(){this.click();}" });
  await wait(40);
};
const textOf = async (node) => {
  const resolved = await call("DOM.resolveNode", { nodeId: node.nodeId });
  const response = await call("Runtime.callFunctionOn", { objectId: resolved.result.object.objectId, functionDeclaration: "function(){return this.textContent;}", returnByValue: true });
  return response.result.result.value;
};

await call("Runtime.evaluate", { expression: "window.__rbRuntimeListener({type:'READBRIDGE_START_READING'}, {}, () => {})" });
await wait(250);
const normalCards = (await byClass("rb-card")).length;
const overview = await byClass("rb-overview-title");
const overviewText = overview[0] ? await textOf(overview[0]) : "";
await activate(await byAttr("data-mode", "reduce"));
const reducedCards = (await byClass("rb-card")).length;
const notices = await byClass("rb-notice");
const noticeTexts = await Promise.all(notices.map(textOf));
await activate(await byAttr("data-mode", "reduce"));
const restoredCards = (await byClass("rb-card")).length;
await activate(await byAttr("data-mode", "step"));
const stepCards = (await byClass("rb-card")).length;
for (let index = 1; index < 6; index += 1) await activate(await byAttr("data-page", "next"));
const progressNodes = await byClass("rb-progress");
const progress = progressNodes[0] ? await textOf(progressNodes[0]) : "";
const runtime = await call("Runtime.evaluate", { expression: "({errors:window.__rbErrors,messages:window.__rbMessageCount})", returnByValue: true });
const value = runtime.result.result.value;
const report = {
  normalShowsAll: normalCards === 6,
  overviewShowsCount: overviewText.includes("6 个主要部分"),
  reduceActuallyReduces: reducedCards === 4,
  reduceHasClearNotice: noticeTexts.some((text) => text.includes("精简展示")),
  reduceCanRestore: restoredCards === 6,
  stepShowsOne: stepCards === 1,
  stepCanReachLast: progress.includes("6 / 6"),
  noExtraAIRequests: value.messages === 1,
  errors: value.errors,
};
report.pass = Object.entries(report).every(([key, item]) => key === "errors" ? item.length === 0 : key === "pass" || item === true);
console.log(JSON.stringify(report, null, 2));
socket.close();
if (!report.pass) process.exitCode = 1;
