const port = process.argv[2] || "9251";
const deadline = Date.now() + 10000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("extractor-fixtures.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!target) throw new Error("未找到正文提取基准页面");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let seq = 0; const pending = new Map();
socket.addEventListener("message", (event) => { const msg = JSON.parse(event.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); });
const call = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
await call("Runtime.enable");
const result = await call("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  return [1000, 5000, 20000, 60000].map((size) => {
    const doc = document.implementation.createHTMLDocument('性能基准');
    const paragraph = '这是用于验证阅桥正文提取性能和文章覆盖范围的完整测试句子。';
    const count = Math.ceil(size / paragraph.length);
    doc.body.innerHTML = '<main><h1>性能基准</h1>' + Array.from({length: count}, (_, i) => '<p>第' + i + '段。' + paragraph + '</p>').join('') + '</main>';
    const started = performance.now();
    const data = new ReadBridgeUniversalContentExtractor(doc, {maxLength: 20000, maxBlocks: 100}).extract();
    return {inputChars: doc.body.textContent.length, outputChars: data.text.length, blocks: data.content_blocks.length, elapsedMs: +(performance.now()-started).toFixed(1), truncated: data.truncated};
  });
})()` });
console.log(JSON.stringify(result.result.result.value, null, 2));
socket.close();
