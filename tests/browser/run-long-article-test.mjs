const port = process.argv[2] || "9257";
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("long-article-fixture.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!target) throw new Error("未找到长文章测试页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } });
const call = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
await call("DOM.enable"); await call("Runtime.enable");
await call("Runtime.evaluate", { expression: "window.__rbRuntimeListener({type:'READBRIDGE_START_READING'}, {}, () => {})" });
await new Promise((resolve) => setTimeout(resolve, 500));
const response = await call("Runtime.evaluate", {
  expression: `(() => {
    const host = document.querySelector('[data-readbridge-root]');
    return { payload: window.__payload, errors: window.__rbErrors, hostFound: Boolean(host) };
  })()`, returnByValue: true,
});
const tree = (await call("DOM.getDocument", { depth: -1, pierce: true })).result.root;
const collect = (node, result = []) => {
  const attrs = node.attributes || [];
  for (let index = 0; index < attrs.length; index += 2) {
    if (attrs[index] === "class" && attrs[index + 1].split(/\s+/).includes("rb-notice")) result.push(node);
  }
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) collect(child, result);
  return result;
};
const notices = collect(tree);
let notice = "";
if (notices[0]) {
  const resolved = await call("DOM.resolveNode", { nodeId: notices[0].nodeId });
  notice = (await call("Runtime.callFunctionOn", { objectId: resolved.result.object.objectId, functionDeclaration: "function(){return this.textContent;}", returnByValue: true })).result.result.value;
}
const value = response.result.result.value;
const report = {
  payloadWithinLimit: value.payload?.text?.length <= 20000,
  payloadMarkedTruncated: value.payload?.truncated === true,
  clearPartialNotice: notice.includes("均衡选取开头、中间和结尾"),
  hasTraceableBlocks: value.payload?.content_blocks?.length > 1,
  noErrors: value.errors.length === 0,
};
report.pass = Object.entries(report).every(([key, item]) => key === "pass" || item === true);
console.log(JSON.stringify(report, null, 2));
socket.close();
if (!report.pass) process.exitCode = 1;
