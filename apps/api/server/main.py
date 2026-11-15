"""阅桥 ReadBridge FastAPI 应用入口。"""

import logging
import asyncio
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .ai import AIProviderError, create_ai_provider
from .config import get_settings
from .models import (
    ErrorResponse,
    ExplainRequest,
    ExplainResponse,
    EasyReadRequest,
    EasyReadResponse,
    TTSRequest,
    TTSVoicesResponse,
)
from .tts import TTSAudioCache, TTSProviderError, create_tts_provider
from .performance import AsyncTTLCache, PerfTimer, stable_hash

logger = logging.getLogger(__name__)
API_REVISION = "2026.11.15.fast-retry-v5"
settings = get_settings()
if settings.performance_logs:
    logging.getLogger("server.qwen_provider").setLevel(logging.INFO)
    logging.getLogger("readbridge.performance").setLevel(logging.INFO)
    logger.setLevel(logging.INFO)
ai_provider = create_ai_provider(
    settings.ai_provider,
    qwen_api_key=(
        settings.qwen_api_key.get_secret_value() if settings.qwen_api_key else None
    ),
    qwen_model=settings.qwen_model,
    qwen_fast_model=settings.qwen_fast_model,
    qwen_base_url=settings.qwen_base_url,
    qwen_timeout_seconds=settings.qwen_timeout_seconds,
    qwen_max_completion_tokens=settings.qwen_max_completion_tokens,
    easy_read_max_input_chars=settings.easy_read_max_input_chars,
    easy_read_max_blocks=settings.easy_read_max_blocks,
    performance_logs=settings.performance_logs,
)
tts_provider_error = None
try:
    tts_provider = create_tts_provider(settings)
except TTSProviderError as exc:
    # 配置错误不阻止文本功能启动；接口会返回可理解的错误。
    tts_provider = None
    tts_provider_error = exc
tts_cache = TTSAudioCache(settings.tts_cache_max_entries, settings.tts_cache_max_bytes)
easy_read_cache = AsyncTTLCache(
    settings.easy_read_cache_max_entries, settings.easy_read_cache_ttl_seconds
)
tts_inflight: dict[str, asyncio.Task] = {}
tts_inflight_lock = asyncio.Lock()

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="阅桥——基于开源多模态大模型的认知无障碍网页重构系统 API。",
)


@app.on_event("shutdown")
async def close_provider_clients() -> None:
    """释放持久 HTTP 连接，避免开发服务器重启时遗留连接。"""
    for provider in (ai_provider, tts_provider):
        close = getattr(provider, "aclose", None)
        if close:
            await close()

# 第一阶段允许本机调试页面和 Chrome 扩展访问；不启用 Cookie 凭据。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_origin_regex=r"chrome-extension://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Request-ID"],
    expose_headers=["X-ReadBridge-TTS-Provider", "X-ReadBridge-TTS-Cache", "X-ReadBridge-Cache", "X-Request-ID", "Server-Timing"],
    allow_credentials=False,
)


@app.get("/health")
async def health() -> dict[str, str]:
    result = {"status": "ok", "name": "ReadBridge", "provider": settings.ai_provider, "api_revision": API_REVISION}
    if settings.ai_provider.lower() == "qwen":
        result["model"] = settings.qwen_model
        result["fast_model"] = settings.qwen_fast_model
    result["tts_provider"] = tts_provider.name if tts_provider else settings.tts_provider
    if tts_provider and tts_provider.name == "cosyvoice":
        result["tts_model"] = settings.tts_model
    if tts_provider_error:
        result["tts_status"] = "not_configured"
    return result


@app.get("/api/tts/voices", response_model=TTSVoicesResponse)
async def tts_voices() -> TTSVoicesResponse:
    if not tts_provider:
        raise TTSProviderError(str(tts_provider_error), status_code=503, code="not_configured")
    return TTSVoicesResponse(
        provider=tts_provider.name,
        provider_name=tts_provider.display_name,
        default_voice=tts_provider.default_voice,
        voices=tts_provider.voices(),
        neural=tts_provider.neural,
    )


@app.post("/api/tts", responses={200: {"content": {"audio/mpeg": {}}}, 502: {"model": ErrorResponse}})
async def synthesize_speech(payload: TTSRequest) -> Response:
    if not tts_provider:
        raise TTSProviderError(str(tts_provider_error), status_code=503, code="not_configured")
    voice = payload.voice or tts_provider.default_voice
    available_voice_ids = {item["id"] for item in tts_provider.voices()}
    if available_voice_ids and voice not in available_voice_ids:
        raise TTSProviderError("所选音色不可用，请刷新音色列表后重试。", status_code=400, code="invalid_voice")
    cache_key = tts_cache.key(tts_provider.name, settings.tts_model, voice, payload.rate, payload.style, payload.text)
    total_started = time.perf_counter()
    audio = await tts_cache.get(cache_key)
    cached = audio is not None
    shared = False
    if not audio:
        async with tts_inflight_lock:
            task = tts_inflight.get(cache_key)
            if task:
                shared = True
            else:
                task = asyncio.create_task(tts_provider.synthesize(payload.text, payload.language, voice, payload.rate, payload.style))
                tts_inflight[cache_key] = task
        try:
            audio = await asyncio.shield(task)
            if not shared:
                await tts_cache.put(cache_key, audio)
        finally:
            if task.done():
                async with tts_inflight_lock:
                    if tts_inflight.get(cache_key) is task:
                        tts_inflight.pop(cache_key, None)
    total_ms = round((time.perf_counter() - total_started) * 1000, 1)
    cache_state = "hit" if cached else "shared" if shared else "miss"
    if settings.performance_logs:
        logging.getLogger("uvicorn.error").info("PERF TTS provider=%s cache=%s chars=%d total_ms=%.1f bytes=%d",
                    tts_provider.name, cache_state, len(payload.text), total_ms, len(audio.content))
    return Response(
        content=audio.content,
        media_type=audio.media_type,
        headers={
            "Cache-Control": "no-store",
            "X-ReadBridge-TTS-Provider": tts_provider.name,
            "X-ReadBridge-TTS-Cache": cache_state,
            "Server-Timing": f"tts;dur={total_ms}",
        },
    )


@app.post(
    "/api/explain",
    response_model=ExplainResponse,
    responses={500: {"model": ErrorResponse}},
)
async def explain(payload: ExplainRequest) -> ExplainResponse:
    try:
        data = await ai_provider.explain(payload.text, payload.output_language, payload.generation_mode)
        return ExplainResponse(data=data)
    except AIProviderError as exc:
        request_id = exc.request_id or uuid.uuid4().hex
        logger.exception("AI Provider 调用失败 request_id=%s code=%s", request_id, exc.code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"success": False, "error": exc.public_detail(request_id)},
            headers={"X-Request-ID": request_id},
        )


@app.post(
    "/api/easy-read",
    response_model=EasyReadResponse,
    responses={500: {"model": ErrorResponse}},
)
async def easy_read(payload: EasyReadRequest, request: Request) -> Response:
    """将网页正文转换成分段、突出重点的易读版本。"""
    request_id = request.headers.get("X-Request-ID", "")[:80] or uuid.uuid4().hex
    timer = PerfTimer(request_id, "easy-read", settings.performance_logs)
    cache_key = stable_hash(
        "easy-read-v5", settings.ai_provider, settings.qwen_model, settings.qwen_fast_model,
        payload.generation_mode, payload.title, payload.text, payload.degraded, payload.output_language,
        [item.model_dump() for item in payload.content_blocks],
    )
    async def generate():
        async def attempt(*, degraded: bool, generation_mode: str):
            return await ai_provider.easy_read(
                text=payload.text, title=payload.title, url=payload.url,
                content_blocks=payload.content_blocks, degraded=degraded, request_id=request_id,
                output_language=payload.output_language, generation_mode=generation_mode,
            )

        try:
            return await attempt(degraded=payload.degraded, generation_mode=payload.generation_mode)
        except AIProviderError as first_error:
            retryable_output_errors = {
                "truncated_model_output", "invalid_model_output", "response_validation_failed"
            }
            if payload.degraded or first_error.code not in retryable_output_errors:
                raise
            logger.warning(
                "EasyRead output incomplete; compact retry request_id=%s mode=%s code=%s",
                request_id, payload.generation_mode, first_error.code,
            )
            try:
                return await attempt(degraded=True, generation_mode=payload.generation_mode)
            except AIProviderError as retry_error:
                if payload.generation_mode != "fast" or retry_error.code not in retryable_output_errors:
                    raise
                # 快速模型连续两次没有给出完整 JSON 时，才回退高质量模型。
                # 这条路径优先保证可用性，不影响正常快速请求的延迟。
                logger.warning(
                    "EasyRead fast retry incomplete; quality fallback request_id=%s code=%s",
                    request_id, retry_error.code,
                )
                return await attempt(degraded=True, generation_mode="quality")
    try:
        data, cache_state = await easy_read_cache.get_or_create(cache_key, generate)
        block_types: dict[str, int] = {}
        for block in payload.content_blocks:
            block_types[block.type] = block_types.get(block.type, 0) + 1
        timer.log(cache=cache_state, url=payload.url, strategy=payload.strategy,
                  extract_ms=payload.metrics.get("extractMs"), original_chars=payload.metrics.get("textLength"),
                  submitted_chars=len(payload.text), blocks=len(payload.content_blocks), block_types=block_types,
                  truncated=payload.truncated, degraded=payload.degraded,
                  request_json_bytes=len(payload.model_dump_json().encode("utf-8")))
        response = EasyReadResponse(data=data)
        return JSONResponse(
            content=response.model_dump(mode="json"),
            headers={"X-Request-ID": request_id, "X-ReadBridge-Cache": cache_state,
                     "Server-Timing": f"total;dur={timer.total_ms}"},
        )
    except AIProviderError as exc:
        timer.log(error_code=exc.code, retryable=exc.retryable, provider_status=exc.provider_status,
                  final_http_status=exc.status_code)
        logger.exception("AI Provider 页面简化失败 request_id=%s code=%s retryable=%s",
                         request_id, exc.code, exc.retryable)
        return JSONResponse(
            status_code=exc.status_code,
            content={"success": False, "error": exc.public_detail(request_id)},
            headers={"X-Request-ID": request_id},
        )


@app.post(
    "/api/simplify-page",
    response_model=EasyReadResponse,
    include_in_schema=False,
)
async def simplify_page_compatibility(payload: EasyReadRequest, request: Request) -> Response:
    """兼容第二阶段早期版本；正式接口为 /api/easy-read。"""
    return await easy_read(payload, request)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    request_id = request.headers.get("X-Request-ID", "")[:80] or uuid.uuid4().hex
    if request.url.path == "/api/tts":
        return JSONResponse(
            status_code=422,
            content={"success": False, "error": {"code": "validation_error", "message": "语音参数无效：文本最多 600 字，语速须为 0.5～2.0，音色只能包含字母、数字、下划线和连字符。"}},
        )
    limit = "60000" if request.url.path in {"/api/easy-read", "/api/simplify-page"} else "10000"
    errors = exc.errors()
    block_error = any("content_blocks" in item.get("loc", ()) for item in errors)
    too_large = any(item.get("type") in {"string_too_long", "too_long"} for item in errors)
    code = "invalid_content_block" if block_error else "input_too_large" if too_large else "response_validation_failed"
    message = "正文内容块格式无效，请刷新网页后重试。" if block_error else f"请输入 1 至 {limit} 个字符的文本"
    logger.warning("Request validation failed request_id=%s path=%s code=%s errors=%s", request_id,
                   request.url.path, code,
                   [{"path": ".".join(map(str, item.get("loc", ()))), "type": item.get("type")} for item in errors[:12]])
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": {"code": code, "message": message,
                 "request_id": request_id, "retryable": code == "input_too_large"}},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(TTSProviderError)
async def tts_exception_handler(request: Request, exc: TTSProviderError) -> JSONResponse:
    logger.warning("TTS request failed code=%s provider_status=%s request_id=%s path=%s",
                   exc.code, exc.provider_status, exc.request_id, request.url.path)
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.public_detail()},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("未处理异常: %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": {"message": "服务暂时不可用，请稍后重试"}},
    )
