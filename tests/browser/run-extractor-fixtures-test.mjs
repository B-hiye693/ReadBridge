const port = process.argv[2] || "9251";
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("extractor-fixtures.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!target) throw new Error("未找到正文提取测试页面");

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
  const id = ++sequence;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
await call("Runtime.enable");
const response = await call("Runtime.evaluate", {
  expression: `(() => {
    const fixturePassed = document.documentElement.dataset.testsPassed === 'true';
    const fixtureSummary = document.querySelector('#result')?.textContent || '';
    const doc = document.implementation.createHTMLDocument('长文章');
    const paragraphs = Array.from({length: 12}, (_, index) => '<p>第' + (index + 1) + '个完整内容块：' + '内容'.repeat(35) + '。</p>').join('');
    doc.body.innerHTML = '<article><h1>长文章测试</h1>' + paragraphs + '</article>';
    const result = new ReadBridgeUniversalContentExtractor(doc, {maxLength: 420}).extract();
    const lastBlock = result.text.split(/\\n\\n+/).filter(Boolean).at(-1) || '';
    return {
      fixturePassed,
      fixtureSummary,
      truncated: result.truncated,
      withinLimit: result.text.length <= 420,
      stoppedAtBlockBoundary: /。$/.test(lastBlock),
      blocksTraceable: result.content_blocks.length > 1 && result.content_blocks.every((block) => /^rb-\\d+$/.test(block.id)),
      textLength: result.text.length,
      blockCount: result.content_blocks.length,
    };
  })()`,
  returnByValue: true,
});
if (response.result.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
const report = response.result.result.value;
report.pass = report.fixturePassed && report.truncated && report.withinLimit
  && report.stoppedAtBlockBoundary && report.blocksTraceable;
console.log(JSON.stringify(report, null, 2));
socket.close();
if (!report.pass) process.exitCode = 1;
