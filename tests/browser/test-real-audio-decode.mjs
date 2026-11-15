const debugPort = process.argv[2] || "9229";
const apiPort = process.argv[3] || "8013";
const response = await fetch(`http://127.0.0.1:${apiPort}/api/tts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "你好，这是阅桥语音测试。", language: "zh-CN", voice: "", rate: 0.9, style: "warm" }),
});
if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${await response.text()}`);
const bytes = Buffer.from(await response.arrayBuffer());
const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((item) => item.json());
const page = targets.find((item) => item.type === "page");
if (!page) throw new Error("未找到浏览器页面");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
const call = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
const base64 = bytes.toString("base64");
const result = await call("Runtime.evaluate", {
  expression: `(async()=>{const raw=atob('${base64}');const data=Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;const context=new AudioContext();try{const decoded=await context.decodeAudioData(data.slice(0));return {duration:decoded.duration,channels:decoded.numberOfChannels,sampleRate:decoded.sampleRate}}finally{await context.close()}})()`,
  awaitPromise: true,
  returnByValue: true,
});
const decoded = result.result?.result?.value;
if (!decoded || decoded.duration <= 0 || decoded.channels < 1) throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ pass: true, httpStatus: response.status, contentType: response.headers.get("content-type"), bytes: bytes.length, ...decoded }));
socket.close();
