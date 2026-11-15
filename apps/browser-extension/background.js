const API_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 60_000;
const EASY_READ_TIMEOUT_MS = 150_000;
const TTS_TIMEOUT_MS = 70_000;
const ttsRequests = new Map();
const aiRequests = new Map();
const canceledAIRequests = new Set();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function normalizeBackgroundError(error, fallback = "语音服务请求失败。") {
  if (error instanceof Error) return { code: error.name || "network_error", message: error.message || fallback };
  if (typeof error === "string") return { code: "network_error", message: error || fallback };
  if (error && typeof error === "object") return {
    code: error.code || "tts_failed", message: error.message || fallback,
    provider_status: error.provider_status, request_id: error.request_id || "",
    retryable: Boolean(error.retryable),
  };
  return { code: "tts_failed", message: fallback };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ easyreadInstalled: true });
});

// 由扩展后台请求本机 API，避免内容脚本受到网页自身 CORS 和混合内容策略影响。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "READBRIDGE_AI_CANCEL") {
    canceledAIRequests.add(message.requestId);
    aiRequests.get(message.requestId)?.abort();
    aiRequests.delete(message.requestId);
    sendResponse({ success: true });
    return false;
  }
  if (message?.type === "READBRIDGE_TTS_CANCEL") {
    ttsRequests.get(message.requestId)?.abort();
    ttsRequests.delete(message.requestId);
    sendResponse({ success: true });
    return false;
  }

  if (message?.type === "READBRIDGE_TTS_VOICES") {
    fetch(`${API_BASE_URL}/api/tts/voices`)
      .then(async (response) => {
        const result = await response.json();
        sendResponse(response.ok ? result : { success: false, error: result.error });
      })
      .catch(() => sendResponse({ success: false, error: { message: "无法连接阅桥语音服务。" } }));
    return true;
  }

  if (message?.type === "READBRIDGE_TTS_SYNTHESIZE") {
    const requestId = String(message.requestId || crypto.randomUUID());
    const controller = new AbortController();
    ttsRequests.get(requestId)?.abort();
    ttsRequests.set(requestId, controller);
    const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload || {}),
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok) {
          const result = contentType.includes("json") ? await response.json() : null;
          sendResponse({ success: false, error: normalizeBackgroundError(result?.error, "神经语音生成失败。") });
          return;
        }
        if (!contentType.toLowerCase().startsWith("audio/")) {
          sendResponse({ success: false, error: { code: "invalid_audio_response", message: "语音服务没有返回音频内容。" } });
          return;
        }
        const downloadStarted = performance.now();
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 128) {
          sendResponse({ success: false, error: { code: "invalid_audio_response", message: "语音服务返回的音频为空或不完整。" } });
          return;
        }
        const encodeStarted = performance.now();
        const audioBase64 = arrayBufferToBase64(buffer);
        sendResponse({
          success: true,
          data: {
            audioBase64,
            contentType: contentType.split(";", 1)[0] || "audio/mpeg",
            provider: response.headers.get("X-ReadBridge-TTS-Provider") || "neural",
            cache: response.headers.get("X-ReadBridge-TTS-Cache") || "unknown",
            timing: { downloadMs: Math.round(encodeStarted - downloadStarted), base64Ms: Math.round(performance.now() - encodeStarted) },
          },
        });
      } catch (error) {
        const normalized = normalizeBackgroundError(error, "无法连接阅桥语音服务。");
        sendResponse({
          success: false,
          error: {
            code: error?.name === "AbortError" ? "canceled" : "network_error",
            message: error?.name === "AbortError" ? "语音请求已取消。" : normalized.message,
          },
        });
      } finally {
        clearTimeout(timeoutId);
        if (ttsRequests.get(requestId) === controller) ttsRequests.delete(requestId);
      }
    })();
    return true;
  }

  const endpointByType = {
    EASYREAD_EXPLAIN: "/api/explain",
    READBRIDGE_EASY_READ: "/api/easy-read",
  };
  const endpoint = endpointByType[message?.type];
  if (!endpoint) return false;

  (async () => {
    const payload = message.payload || { text: message.text };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    const maxLength = message.type === "READBRIDGE_EASY_READ" ? 60_000 : 10_000;
    if (!text || text.length > maxLength) {
      sendResponse({
        success: false,
        error: { message: `请输入 1 至 ${maxLength} 个字符的文本。` },
      });
      return;
    }

    const controller = new AbortController();
    const requestId = String(message.requestId || crypto.randomUUID());
    aiRequests.get(requestId)?.abort();
    aiRequests.set(requestId, controller);
    const timeoutId = setTimeout(
      () => controller.abort(),
      message.type === "READBRIDGE_EASY_READ" ? EASY_READ_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        body: JSON.stringify({ ...payload, text }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!result) {
        sendResponse({ success: false, error: { code: "invalid_server_response", message: "AI服务返回了无法读取的数据，请稍后重试。", request_id: requestId, retryable: true } });
        return;
      }
      if (!response.ok) {
        const backendError = normalizeBackgroundError(result?.error, `服务响应异常（${response.status}）`);
        backendError.request_id ||= response.headers.get("X-Request-ID") || requestId;
        if (message.type === "READBRIDGE_EASY_READ") {
          console.warn("ReadBridge EasyRead failed", {
            httpStatus: response.status, code: backendError.code,
            message: backendError.message, requestId: backendError.request_id,
          });
        }
        sendResponse({
          success: false,
          error: { ...backendError, http_status: response.status },
        });
        return;
      }
      sendResponse(result);
    } catch (error) {
      const userCanceled = error?.name === "AbortError" && canceledAIRequests.has(requestId);
      sendResponse({
        success: false,
        error: {
          message: userCanceled ? "请求已取消。" : error?.name === "AbortError"
            ? (message.type === "READBRIDGE_EASY_READ"
              ? "文章内容较长，AI处理超时。请稍后重试，或选中较小区域阅读。"
              : "解释请求超时，请稍后重试。")
            : "无法连接阅桥服务，请确认 FastAPI 已在 127.0.0.1:8000 启动。",
          code: userCanceled ? "canceled" : error?.name === "AbortError" ? "provider_timeout" : "network_error",
          request_id: requestId,
          retryable: !userCanceled,
        },
      });
    } finally {
      clearTimeout(timeoutId);
      if (aiRequests.get(requestId) === controller) aiRequests.delete(requestId);
      canceledAIRequests.delete(requestId);
    }
  })();

  return true;
});
