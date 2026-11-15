const API_BASE_URL = "http://127.0.0.1:8000";

async function checkServer() {
  const status = document.querySelector("#status");
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (!response.ok) throw new Error("服务响应异常");
    status.textContent = "AI 服务已连接，可以开始使用";
    status.className = "status ok";
  } catch {
    status.textContent = "AI 服务未连接，请先启动 FastAPI";
    status.className = "status error";
  }
}

checkServer();

document.querySelector("#easy-reading").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = document.querySelector("#status");
  button.disabled = true;
  button.textContent = "正在打开…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      throw new Error("请先打开一个普通网页");
    }
    await chrome.tabs.sendMessage(tab.id, { type: "READBRIDGE_START_READING" });
    window.close();
  } catch (error) {
    status.textContent = error?.message?.includes("Receiving end does not exist")
      ? "请刷新当前网页后再试"
      : error?.message || "无法启动一键易读";
    status.className = "status error";
    button.disabled = false;
    button.textContent = "一键易读";
  }
});
