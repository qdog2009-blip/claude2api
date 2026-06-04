"""
Claude Web-to-API 中转服务
OpenAI 兼容 /v1/chat/completions，通过 WebSocket 与 Chrome 扩展通信
"""

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv()

# ─── WeChat Bot（可通过环境变量 ENABLE_WECHAT_BOT=1 开启） ────────────────────
_wechat_task: Optional[asyncio.Task] = None

ENABLE_WECHAT_BOT = os.getenv("ENABLE_WECHAT_BOT", "0") == "1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _wechat_task
    if ENABLE_WECHAT_BOT:
        try:
            from wechat_bot import run_wechat_bot
            _wechat_task = asyncio.create_task(run_wechat_bot())
            print("[Server] WeChat Bot 已启动", flush=True)
        except ImportError as e:
            print(f"[Server] WeChat Bot 模块加载失败: {e}", flush=True)
    yield
    if _wechat_task and not _wechat_task.done():
        _wechat_task.cancel()
        try:
            await _wechat_task
        except asyncio.CancelledError:
            pass

API_KEY: str = os.getenv("API_KEY", "")  # 留空则跳过鉴权

app = FastAPI(title="Claude2API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 当前连接的扩展 WebSocket（单连接模型）
_extension_ws: Optional[WebSocket] = None
# request_id → asyncio.Queue（存放来自扩展的 chunk）
_pending: dict[str, asyncio.Queue] = {}
# request_id → asyncio.Queue（存放内部指令的一次性响应）
_pending_internal: dict[str, asyncio.Queue] = {}


# ─── 数据模型 ────────────────────────────────────────────────────────────────


class Message(BaseModel):
    role: str
    content: Any  # str 或 list（OpenAI 多模态格式）


class ChatRequest(BaseModel):
    model: str = "claude-3-5-sonnet-20241022"
    messages: list[Message]
    stream: bool = False
    max_tokens: Optional[int] = None


# ─── 工具函数 ─────────────────────────────────────────────────────────────────


def _check_auth(authorization: Optional[str]) -> None:
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def _sanitize(text: str) -> str:
    """
    修复 JSON/WebSocket 传输后残留的 surrogate 字符：
    - 合法代理对（\\uD83E\\uDD47）重新合并为正确码点
    - 孤立代理直接丢弃，避免 UTF-8 编码崩溃
    """
    result = []
    i = 0
    while i < len(text):
        cp = ord(text[i])
        if 0xD800 <= cp <= 0xDBFF:          # 高代理
            if i + 1 < len(text) and 0xDC00 <= ord(text[i + 1]) <= 0xDFFF:
                # 合法代理对 → 合并为真实码点
                high = cp - 0xD800
                low  = ord(text[i + 1]) - 0xDC00
                result.append(chr(0x10000 + (high << 10) + low))
                i += 2
            else:
                i += 1  # 孤立高代理，丢弃
        elif 0xDC00 <= cp <= 0xDFFF:        # 孤立低代理，丢弃
            i += 1
        else:
            result.append(text[i])
            i += 1
    return "".join(result)


def _make_chunk(request_id: str, model: str, content: str, finish: bool = False) -> str:
    delta = {} if finish else {"content": _sanitize(content)}
    finish_reason = "stop" if finish else None
    payload = {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n"


# ─── WebSocket 端点（扩展连接） ───────────────────────────────────────────────


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    global _extension_ws
    await websocket.accept()
    _extension_ws = websocket
    print("[WS] Extension connected")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # Sanitize all string values at ingestion to prevent UTF-8 encoding errors downstream
            for _key in list(msg.keys()):
                if isinstance(msg[_key], str):
                    msg[_key] = _sanitize(msg[_key])
            request_id: str = msg.get("request_id", "")
            if request_id and request_id in _pending:
                await _pending[request_id].put(msg)
            elif request_id and request_id in _pending_internal:
                await _pending_internal[request_id].put(msg)
    except WebSocketDisconnect:
        print("[WS] Extension disconnected")
    finally:
        if _extension_ws is websocket:
            _extension_ws = None


# ─── HTTP 端点 ────────────────────────────────────────────────────────────────


@app.get("/v1/models")
async def list_models(authorization: Optional[str] = Header(None)):
    _check_auth(authorization)
    models = [
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
    ]
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": 0, "owned_by": "anthropic"}
            for m in models
        ],
    }


@app.post("/v1/chat/completions", response_model=None)
async def chat_completions(
    request: ChatRequest,
    authorization: Optional[str] = Header(None),
) -> StreamingResponse | JSONResponse:
    _check_auth(authorization)

    if _extension_ws is None:
        raise HTTPException(status_code=503, detail="Chrome extension not connected")

    request_id = uuid.uuid4().hex
    queue: asyncio.Queue = asyncio.Queue()
    _pending[request_id] = queue

    # 将任务推送给扩展
    task_payload = {
        "type": "task",
        "request_id": request_id,
        "model": request.model,
        "messages": [m.model_dump() for m in request.messages],
    }
    try:
        await _extension_ws.send_text(json.dumps(task_payload))
    except Exception as exc:
        del _pending[request_id]
        raise HTTPException(status_code=503, detail=f"Failed to send to extension: {exc}")

    # ─── 流式响应 ─────────────────────────────────────────────────────────────
    if request.stream:
        async def generate() -> AsyncIterator[str]:
            # 发送 role delta
            role_chunk = {
                "id": f"chatcmpl-{request_id}",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": request.model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(role_chunk)}\n\n"

            try:
                streamed_parts: list[str] = []
                stream_complete_text: str | None = None
                while True:
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=1800)
                    except asyncio.TimeoutError:
                        yield _make_chunk(request_id, request.model, "", finish=True)
                        yield "data: [DONE]\n\n"
                        break

                    if msg["type"] == "chunk":
                        text = msg.get("text", "")
                        streamed_parts.append(text)
                        yield _make_chunk(request_id, request.model, text)
                    elif msg["type"] == "split":
                        streamed_parts.append("\n\n")
                        yield _make_chunk(request_id, request.model, "\n\n")
                    elif msg["type"] == "complete_text":
                        stream_complete_text = msg.get("text", "")
                    elif msg["type"] == "done":
                        # 用 complete_text 校验并补发遗漏的尾部内容
                        if stream_complete_text:
                            streamed = "".join(streamed_parts)
                            full = stream_complete_text.replace("<<SPLIT>>", "\n\n")
                            if len(full) > len(streamed) and full.startswith(streamed):
                                delta = full[len(streamed):]
                                if delta.strip():
                                    yield _make_chunk(request_id, request.model, delta)
                        yield _make_chunk(request_id, request.model, "", finish=True)
                        yield "data: [DONE]\n\n"
                        break
                    elif msg["type"] == "error":
                        err_payload = {"error": {"message": msg.get("message", "Unknown error"), "type": "upstream_error"}}
                        yield f"data: {json.dumps(err_payload)}\n\n"
                        yield "data: [DONE]\n\n"
                        break
            finally:
                _pending.pop(request_id, None)

        return StreamingResponse(generate(), media_type="text/event-stream")

    # ─── 非流式响应 ───────────────────────────────────────────────────────────
    full_text: list[str] = []
    complete_text: str | None = None
    try:
        while True:
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=1800)
            except asyncio.TimeoutError:
                break
            if msg["type"] == "chunk":
                full_text.append(msg.get("text", ""))
            elif msg["type"] == "split":
                full_text.append("<<SPLIT>>")
            elif msg["type"] == "complete_text":
                complete_text = msg.get("text", "")   # 最终权威文本，优先使用
            elif msg["type"] in ("done", "error"):
                break
    finally:
        _pending.pop(request_id, None)

    content = _sanitize(complete_text if complete_text else "".join(full_text))
    return JSONResponse({
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


# ─── 状态接口 ─────────────────────────────────────────────────────────────────


@app.get("/status")
async def status():
    return {
        "extension_connected": _extension_ws is not None,
        "pending_requests": len(_pending),
    }


# ─── 内部指令接口（供 wechat_bot 调用） ──────────────────────────────────────


class NewChatRequest(BaseModel):
    model: Optional[str] = None   # "opus" | "sonnet" | "research" | None


@app.post("/internal/new_chat")
async def internal_new_chat(request: NewChatRequest):
    if _extension_ws is None:
        raise HTTPException(status_code=503, detail="Chrome extension not connected")
    await _extension_ws.send_text(json.dumps({
        "type":  "new_chat",
        "model": request.model,
    }))
    return {"ok": True}


@app.post("/internal/reload")
async def internal_reload():
    if _extension_ws is None:
        raise HTTPException(status_code=503, detail="Chrome extension not connected")
    await _extension_ws.send_text(json.dumps({"type": "reload"}))
    return {"ok": True}


@app.get("/internal/get_recents")
async def internal_get_recents():
    if _extension_ws is None:
        raise HTTPException(status_code=503, detail="Chrome extension not connected")

    request_id = uuid.uuid4().hex
    queue: asyncio.Queue = asyncio.Queue()
    _pending_internal[request_id] = queue

    try:
        await _extension_ws.send_text(json.dumps({
            "type": "get_recents",
            "request_id": request_id,
        }))
    except Exception as exc:
        del _pending_internal[request_id]
        raise HTTPException(status_code=503, detail=f"Failed to send: {exc}")

    try:
        msg = await asyncio.wait_for(queue.get(), timeout=30)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout waiting for recents")
    finally:
        _pending_internal.pop(request_id, None)

    if "error" in msg:
        raise HTTPException(status_code=500, detail=msg["error"])
    return {"recents": msg.get("recents", [])}


class SelectChatRequest(BaseModel):
    index: int  # 0-based


@app.post("/internal/select_chat")
async def internal_select_chat(request: SelectChatRequest):
    if _extension_ws is None:
        raise HTTPException(status_code=503, detail="Chrome extension not connected")
    await _extension_ws.send_text(json.dumps({
        "type":  "select_chat",
        "index": request.index,
    }))
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)

