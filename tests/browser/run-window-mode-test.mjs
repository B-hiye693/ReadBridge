const port = process.argv[2] || "9224";
const deadline = Date.now() + 15000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.includes("window-mode-fixture.html"));
    if (target) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!target) throw new Error("未找到窗口测试页面");

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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await call("DOM.enable");
await call("Runtime.enable");
await call("Page.enable");

function attrs(node) {
  const result = {};
  for (let index = 0; index < (node.attributes || []).length; index += 2) result[node.attributes[index]] = node.attributes[index + 1];
  return result;
}
function findNode(root, predicate) {
  if (predicate(root)) return root;
  for (const child of [...(root.children || []), ...(root.shadowRoots || [])]) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}
async function tree() {
  return (await call("DOM.getDocument", { depth: -1, pierce: true })).result.root;
}
async function byAttribute(name, value = null) {
  const root = await tree();
  return findNode(root, (node) => {
    const values = attrs(node);
    return Object.hasOwn(values, name) && (value === null || values[name] === value);
  });
}
async function byClass(className) {
  const root = await tree();
  return findNode(root, (node) => (attrs(node).class || "").split(/\s+/).includes(className));
}
async function box(node) {
  const model = (await call("DOM.getBoxModel", { nodeId: node.nodeId })).result.model;
  const quad = model.border;
  return { left: quad[0], top: quad[1], right: quad[4], bottom: quad[5], width: quad[4] - quad[0], height: quad[5] - quad[1] };
}
async function mouse(type, x, y, buttons = 0, button = "none", clickCount = 0) {
  await call("Input.dispatchMouseEvent", { type, x, y, buttons, button, clickCount });
}
async function click(node) {
  const rect = await box(node);
  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  await mouse("mousePressed", x, y, 1, "left", 1);
  await mouse("mouseReleased", x, y, 0, "left", 1);
  await wait(80);
}
async function drag(fromX, fromY, toX, toY) {
  await mouse("mousePressed", fromX, fromY, 1, "left", 1);
  await mouse("mouseMoved", (fromX + toX) / 2, (fromY + toY) / 2, 1, "none", 0);
  await mouse("mouseMoved", toX, toY, 1, "none", 0);
  await mouse("mouseReleased", toX, toY, 0, "left", 1);
  await wait(120);
}

let panel = await byClass("rb-panel");
await call("DOM.setAttributeValue", { nodeId: panel.nodeId, name: "class", value: "rb-panel docked open" });
const modeButton = await byAttribute("data-window-mode");
await click(modeButton);
panel = await byClass("rb-panel");
const floatingClass = (attrs(panel).class || "").includes("floating");
const beforeMove = await box(panel);
const header = await byClass("rb-header");
const headerBox = await box(header);
await drag(headerBox.left + 100, (headerBox.top + headerBox.bottom) / 2, headerBox.left + 35, (headerBox.top + headerBox.bottom) / 2 + 45);
panel = await byClass("rb-panel");
const afterMove = await box(panel);
const handle = await byAttribute("data-resize", "se");
const handleBox = await box(handle);
const handleObject = await call("DOM.resolveNode", { nodeId: handle.nodeId });
await call("Runtime.callFunctionOn", {
  objectId: handleObject.result.object.objectId,
  functionDeclaration: `function () {
    window.__rbResizeEvents = [];
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
      this.addEventListener(type, (event) => window.__rbResizeEvents.push({ type, button: event.button, buttons: event.buttons, isPrimary: event.isPrimary, pointerId: event.pointerId }));
    }
  }`,
});
const hit = await call("DOM.getNodeForLocation", { x: Math.round((handleBox.left + handleBox.right) / 2), y: Math.round((handleBox.top + handleBox.bottom) / 2), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false });
await drag((handleBox.left + handleBox.right) / 2, (handleBox.top + handleBox.bottom) / 2, handleBox.right + 45, handleBox.bottom + 35);
panel = await byClass("rb-panel");
const afterResize = await box(panel);
await click(await byAttribute("data-window-mode"));
panel = await byClass("rb-panel");
const dockedClass = (attrs(panel).class || "").includes("docked");
await click(await byAttribute("data-window-mode"));
panel = await byClass("rb-panel");
const restored = await box(panel);
await call("Page.reload", { ignoreCache: true });
await wait(500);
panel = await byClass("rb-panel");
const modeRestoredAfterReload = (attrs(panel).class || "").includes("floating");
await call("DOM.setAttributeValue", { nodeId: panel.nodeId, name: "class", value: "rb-panel floating open" });
const afterReload = await box(await byClass("rb-panel"));
const runtime = await call("Runtime.evaluate", { expression: "({ storage: JSON.parse(localStorage.getItem('rb-test-storage') || '{}'), messages: window.__rbMessageCount, resizeEvents: window.__rbResizeEvents, errors: window.__rbErrors })", returnByValue: true });
const value = runtime.result.result.value;
const report = {
  floatingClass,
  moved: Math.abs(afterMove.left - beforeMove.left) > 20 && Math.abs(afterMove.top - beforeMove.top) > 20,
  resized: afterResize.width > afterMove.width + 20 && afterResize.height > afterMove.height + 20,
  dockedClass,
  restoredFloatingPosition: Math.abs(restored.left - afterResize.left) < 2 && Math.abs(restored.top - afterResize.top) < 2,
  modeRestoredAfterReload,
  geometryRestoredAfterReload: Math.abs(afterReload.left - afterResize.left) < 2 && Math.abs(afterReload.top - afterResize.top) < 2
    && Math.abs(afterReload.width - afterResize.width) < 2 && Math.abs(afterReload.height - afterResize.height) < 2,
  modeSaved: value.storage.readbridgeWindowMode === "floating",
  positionSaved: Number.isFinite(value.storage.readbridgeFloatingLeft) && Number.isFinite(value.storage.readbridgeFloatingTop),
  sizeSaved: Number.isFinite(value.storage.readbridgeFloatingWidth) && Number.isFinite(value.storage.readbridgeFloatingHeight),
  aiRequestsDuringWindowOperations: value.messages,
  resizeEvents: value.resizeEvents,
  errors: value.errors,
  dimensions: { beforeMove, afterMove, handleBox, hitNodeId: hit.result.nodeId, handleNodeId: handle.nodeId, afterResize, restored, afterReload },
};
report.pass = floatingClass && report.moved && report.resized && dockedClass && report.restoredFloatingPosition
  && report.modeRestoredAfterReload && report.geometryRestoredAfterReload
  && report.modeSaved && report.positionSaved && report.sizeSaved && value.messages === 0;
console.log(JSON.stringify(report, null, 2));
socket.close();
