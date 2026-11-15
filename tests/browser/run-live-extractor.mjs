import fs from "node:fs";

const port = process.argv[2] || "9223";
const deadline = Date.now() + 20000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("docs.emqx.com"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!target) throw new Error("未找到 EMQX 页面调试目标");

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
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

await call("Runtime.enable");
await new Promise((resolve) => setTimeout(resolve, 2500));
const source = fs.readFileSync(new URL("../../apps/browser-extension/extractor.js", import.meta.url), "utf8");
const expression = `${source}\nJSON.stringify({ result: new ReadBridgeUniversalContentExtractor(document).extract(), diagnostics: { title: document.title, bodyLength: document.body?.innerText?.length || 0, vpDoc: Boolean(document.querySelector('.vp-doc')), main: Boolean(document.querySelector('main')), headings: document.querySelectorAll('h1,h2,h3,h4').length } })`;
const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
socket.close();
if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
console.log(response.result?.result?.value || "null");
