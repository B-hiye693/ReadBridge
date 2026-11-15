const port = process.argv[2] || "9231";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("source-locator-fixture.html"));
    if (target) break;
  } catch {}
  await wait(200);
}
if (!target) throw new Error("未找到原文定位测试页面");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const handler = pending.get(message.id);
  if (handler) { pending.delete(message.id); handler(message); }
});
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result.exceptionDetails) {
    const details = response.result.exceptionDetails;
    throw new Error(details.exception?.description || `${details.text} at ${details.lineNumber}:${details.columnNumber}`);
  }
  return response.result.result.value;
};
await call("Runtime.enable");
await call("DOM.enable");
const attrs = (node) => Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
const collectNodes = (root, predicate, result = []) => {
  if (predicate(root)) result.push(root);
  for (const child of [...(root.children || []), ...(root.shadowRoots || [])]) collectNodes(child, predicate, result);
  return result;
};
const tree = async () => (await call("DOM.getDocument", { depth: -1, pierce: true })).result.root;
const nodesByAttr = async (name, value = null) => collectNodes(await tree(), (node) => Object.hasOwn(attrs(node), name) && (value === null || attrs(node)[name] === value));
const activate = async (node) => {
  const resolved = await call("DOM.resolveNode", { nodeId: node.nodeId });
  await call("Runtime.callFunctionOn", { objectId: resolved.result.object.objectId, functionDeclaration: "function(){this.click();}" });
  await wait(35);
};

const direct = await evaluate(`(() => {
  const L = ReadBridgeSourceLocator;
  const locator = new L(document, { highlightDuration: 120 });
  new ReadBridgeUniversalContentExtractor(document).buildContentBlocks();
  const result = (text) => { const found = locator.locate(text); return { success: found.success, strategy: found.strategy, ids: found.elements?.map(e => e.id) || [] }; };
  const moduleResult = (module) => { const found = locator.locate(module); return { success: found.success, strategy: found.strategy, confidence: found.confidence, ids: found.elements?.map(e => e.id) || [] }; };
  const blockId = (text) => __readBridgeBlockRegistry.blocks.find(block => block.text.includes(text))?.id;
  return {
    normalized: L.normalizeForLocation('火箭在飞行过程中' + String.fromCharCode(10) + ' 出现' + String.fromCharCode(160) + '异常') === '火箭在飞行过程中出现异常',
    inline: result('客户端可以使用 JWT 进行身份认证。'),
    list: result('连接服务器前，需要准备客户端标识和认证信息。'),
    heading: result('JWT认证'),
    table: result('认证方式'),
    multi2: result('第一段说明火箭发射后约八十五秒出现异常。第二段说明事故的具体原因尚未确认。'),
    multi3: result('第一段说明火箭发射后约八十五秒出现异常。第二段说明事故的具体原因尚未确认。第三段说明仍需等待官方调查结果。'),
    news: result('中国官方媒体随后宣布，火箭在飞行过程中出现异常，发射任务失败。'),
    empty: result(''),
    missing: result('这一段完全不存在于当前网页，而且字符足够多，不能进行错误定位。'),
    anchor: moduleResult({ heading:'路数', content:'共有2路数字输入。', sourceBlockIds:[blockId('路数 | 2路')], sourceText:'' }),
    tableFields: moduleResult({ heading:'路数', content:'共有2路数字输入。', sourceBlockIds:[], sourceText:'' }),
    defaultFields: moduleResult({ heading:'默认形态', content:'出厂默认是干接点。', sourceBlockIds:[], sourceText:'' }),
    pinFields: moduleResult({ heading:'MicroPython引脚映射', content:'DI1对应GPIO41，DI2对应GPIO42。', sourceBlockIds:[], sourceText:'' }),
    difficultWord: moduleResult({ word:'干接点', content:'一种触点形态', sourceBlockIds:[], sourceText:'' }),
    navDuplicateWord: moduleResult({ word:'JWT', content:'一种令牌格式', sourceBlockIds:[], sourceText:'客户端可以使用 JWT 进行身份认证。' }),
    lowConfidence: moduleResult({ heading:'配置', content:'默认参数可以修改', sourceBlockIds:[], sourceText:'' }),
  };
})()`);

await evaluate("window.__rbRuntimeListener({type:'READBRIDGE_START_READING'}, {}, () => {})");
await wait(250);
const locateCount = (await nodesByAttr("data-locate-source")).length;
await activate((await nodesByAttr("data-speak-item", "section-0"))[0]);
const speechBefore = await evaluate("({spoken:__fakeSpeech.spoken.length,cancel:__fakeSpeech.cancelCount})");
await activate((await nodesByAttr("data-locate-source", "section-0"))[0]);
const highlighted = await evaluate("document.querySelector('#inline-target').classList.contains('readbridge-source-highlight')");
const speechAfter = await evaluate("({spoken:__fakeSpeech.spoken.length,cancel:__fakeSpeech.cancelCount})");
const messagesAfterLocate = await evaluate("__rbMessageCount");
await activate((await nodesByAttr("data-locate-source", "difficult-0"))[0]);
const wordHighlight = await evaluate("({supported:Boolean(CSS.highlights && typeof Highlight === 'function'),has:Boolean(CSS.highlights?.has('readbridge-source-word'))})");
await activate((await nodesByAttr("data-window-mode"))[0]);
await activate((await nodesByAttr("data-locate-source", "section-1"))[0]);
const floatingHighlight = await evaluate("document.querySelector('#news-target').classList.contains('readbridge-source-highlight')");
await evaluate(`(() => { document.querySelector('#inline-target').remove(); const replacement=document.createElement('p'); replacement.id='spa-target'; replacement.textContent='客户端可以使用 JWT 进行身份认证。'; document.querySelector('article').appendChild(replacement); })()`);
await wait(1250);
const spaDirect = await evaluate(`(() => { const found=new ReadBridgeSourceLocator(document).locate('客户端可以使用 JWT 进行身份认证。'); return {success:found.success,ids:found.elements?.map(item=>item.id)||[]}; })()`);
await activate((await nodesByAttr("data-locate-source", "section-0"))[0]);
const spaHighlight = await evaluate("document.querySelector('#spa-target').classList.contains('readbridge-source-highlight')");
const integration = { locateCount, highlighted, wordHighlight, floatingHighlight, spaDirect, spaHighlight, speechBefore, speechAfter, messagesAfterLocate, payloadBlocks: await evaluate("__lastEasyReadPayload?.content_blocks || []"), errors: await evaluate("__rbErrors") };
await wait(3400);
const cleanup = await evaluate(`({
  highlights: document.querySelectorAll('.readbridge-source-highlight').length,
  styleCount: document.querySelectorAll('#readbridge-source-highlight-style').length,
  messages: __rbMessageCount,
  errors: __rbErrors,
})`);

const report = {
  normalizeWhitespace: direct.normalized,
  inlineStrong: direct.inline.success && direct.inline.ids.includes("inline-target"),
  list: direct.list.success && direct.list.ids.includes("list-target"),
  headingPrefersBody: direct.heading.success && direct.heading.ids.includes("technical-title") && !direct.heading.ids.includes("nav-duplicate"),
  table: direct.table.success && direct.table.ids.includes("table-target"),
  twoBlocks: direct.multi2.success && direct.multi2.ids.join(",") === "multi-a,multi-b",
  threeBlocks: direct.multi3.success && direct.multi3.ids.join(",") === "multi-a,multi-b,multi-c",
  news: direct.news.success && direct.news.ids.includes("news-target"),
  emptyRejected: !direct.empty.success,
  missingRejected: !direct.missing.success,
  anchorLevel: direct.anchor.success && direct.anchor.strategy === "block-anchor" && direct.anchor.ids.includes("channels-row"),
  tableLabelValue: direct.tableFields.success && direct.tableFields.ids.includes("channels-row"),
  tableDefaultValue: direct.defaultFields.success && direct.defaultFields.ids.includes("default-row"),
  tablePinMapping: direct.pinFields.success && direct.pinFields.ids.includes("pins-row"),
  difficultWordFallback: direct.difficultWord.success && direct.difficultWord.ids.includes("default-row"),
  difficultAvoidsNav: direct.navDuplicateWord.success && direct.navDuplicateWord.ids.includes("inline-target") && !direct.navDuplicateWord.ids.includes("nav-duplicate"),
  lowConfidenceRejected: !direct.lowConfidence.success,
  requestContainsBlocks: integration.payloadBlocks.some(block => block.type === "table_row" && block.text === "路数 | 2路"),
  buttonsOnlyWithSources: integration.locateCount === 4,
  uiHighlight: integration.highlighted,
  exactWordHighlight: !integration.wordHighlight.supported || integration.wordHighlight.has,
  floatingHighlight: integration.floatingHighlight,
  spaRequery: integration.spaHighlight,
  speechContinues: integration.speechAfter.cancel === integration.speechBefore.cancel && integration.speechAfter.spoken === integration.speechBefore.spoken,
  noExtraAI: integration.messagesAfterLocate === 1 && cleanup.messages === 1,
  highlightRemoved: cleanup.highlights === 0,
  isolatedStyle: cleanup.styleCount === 1,
  noErrors: [...integration.errors, ...cleanup.errors].length === 0,
  details: { direct, integration, cleanup },
};
report.pass = Object.entries(report).every(([key, value]) => ["pass", "details"].includes(key) || value === true);
console.log(JSON.stringify(report, null, 2));
socket.close();
