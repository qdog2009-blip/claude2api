"""
WeChat Bot 集成模块
- 在服务启动时作为 asyncio 后台任务运行
- 收到微信消息后调用本地 /v1/chat/completions API
- 每个用户维护最多 5 条对话历史消息（不含本次请求）
- 支持 /help /new 指令
"""

import asyncio
import base64
import os
import sys
import time
from collections import defaultdict, deque

import httpx

# 动态导入 wechatbot（路径由环境变量或相对位置决定）
_WECHAT_SDK_PATH = os.getenv(
    "WECHAT_SDK_PATH",
    os.path.join(os.path.dirname(__file__), "..", "wechatbot", "python"),
)
if _WECHAT_SDK_PATH not in sys.path:
    sys.path.insert(0, _WECHAT_SDK_PATH)

from wechatbot import WeChatBot  # noqa: E402

# ─── 配置 ─────────────────────────────────────────────────────────────────────

HISTORY_SIZE = 5           # 历史消息条数上限
API_BASE     = os.getenv("WECHAT_API_BASE", "http://localhost:8000")
BOT_MODEL    = os.getenv("WECHAT_BOT_MODEL", "claude-3-5-sonnet-20241022")
API_KEY      = os.getenv("API_KEY", "")

# ─── 指令定义 ──────────────────────────────────────────────────────────────────

COMMANDS: dict[str, str] = {
    "/help":       "列出所有指令及说明",
    "/new":        "清除历史上下文，在网页创建新对话（可选: opus | sonnet | research）",
    "/list":       "列出最近 10 条对话（序号 + 标题）",
    "/select":     "选中指定对话，例如: /select 3",
    "/reload":     "刷新整个对话页面",
}

PENDING_IMAGE_TIMEOUT = 120   # 图片缓存有效期（秒），超时后图片自动丢弃
# user_id → {"b64": str, "mime": str, "ts": float}
_pending_images: dict[str, dict] = {}

VALID_MODELS  = ("opus", "sonnet", "research")
SPLIT_MARKER  = "<<SPLIT>>"

# ─── 对话历史管理 ──────────────────────────────────────────────────────────────

def _make_empty_history() -> deque:
    """预填充 HISTORY_SIZE 条空消息（交替 user/assistant，内容为空字符串）"""
    roles = ["user", "assistant"] * HISTORY_SIZE
    d: deque = deque(maxlen=HISTORY_SIZE)
    for role in roles[:HISTORY_SIZE]:
        d.append({"role": role, "content": ""})
    return d

# user_id → deque（maxlen=HISTORY_SIZE，自动淘汰最旧消息）
_histories: dict[str, deque] = defaultdict(_make_empty_history)


def _get_messages(user_id: str, new_content) -> list[dict]:
    """返回历史记录（≤5条）+ 本轮用户消息，new_content 可为 str 或多模态 list"""
    return list(_histories[user_id]) + [{"role": "user", "content": new_content}]


def _save_turn(user_id: str, user_text: str, assistant_text: str) -> None:
    """将本轮 user+assistant 各追加一条，deque 自动丢弃最旧消息保持 ≤5 条"""
    h = _histories[user_id]
    h.append({"role": "user",      "content": user_text})
    h.append({"role": "assistant", "content": assistant_text})


def _reset_history(user_id: str) -> None:
    _histories[user_id] = _make_empty_history()
    _pending_images.pop(user_id, None)  # 同时清除缓存的待处理图片


def _detect_mime(data: bytes) -> str:
    """根据文件头字节猜测图片 MIME 类型"""
    if data[:2] == b'\xff\xd8':
        return "image/jpeg"
    if data[:4] == b'\x89PNG':
        return "image/png"
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return "image/gif"
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return "image/webp"
    return "image/jpeg"


# ─── 指令处理 ──────────────────────────────────────────────────────────────────

async def _handle_command(user_id: str, text: str) -> str | None:
    """
    若 text 匹配指令则处理并返回回复字符串，否则返回 None。
    """
    stripped = text.strip()
    if not stripped.startswith("/"):
        return None

    parts = stripped.split()
    cmd   = parts[0].lower()

    # /help
    if cmd == "/help":
        lines = [f"{k}  —  {v}" for k, v in COMMANDS.items()]
        return "指令列表：\n" + "\n".join(lines)

    # /new [opus|sonnet]
    if cmd == "/new":
        model: str | None = None
        if len(parts) >= 2:
            model = parts[1].lower()
            if model not in VALID_MODELS:
                return f"不支持的模型「{parts[1]}」，可选：opus | sonnet"

        # 清除本用户历史
        _reset_history(user_id)

        # 通知 Python 服务推送 new_chat 指令给扩展
        try:
            headers = {"Content-Type": "application/json"}
            if API_KEY:
                headers["Authorization"] = f"Bearer {API_KEY}"
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(
                    f"{API_BASE}/internal/new_chat",
                    json={"model": model},
                    headers=headers,
                )
        except Exception as e:
            print(f"[WechatBot] new_chat 推送失败: {e}", flush=True)

        model_tip = "，已启用 Research 模式（Opus）" if model == "research" else (f"，已切换模型: {model}" if model else "")
        return f"已创建新对话，历史上下文已清除{model_tip}"

    # /reload
    if cmd == "/reload":
        try:
            headers = {"Content-Type": "application/json"}
            if API_KEY:
                headers["Authorization"] = f"Bearer {API_KEY}"
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(f"{API_BASE}/internal/reload", headers=headers)
        except Exception as e:
            print(f"[WechatBot] reload 推送失败: {e}", flush=True)
        return "已刷新页面"

    # /list
    if cmd == "/list":
        try:
            headers = {"Content-Type": "application/json"}
            if API_KEY:
                headers["Authorization"] = f"Bearer {API_KEY}"
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{API_BASE}/internal/get_recents", headers=headers)
                resp.raise_for_status()
                recents = resp.json().get("recents", [])
        except httpx.HTTPStatusError as e:
            try:
                detail = e.response.json().get("detail", str(e))
            except Exception:
                detail = str(e)
            return f"获取对话列表失败: {detail}"
        except Exception as e:
            return f"获取对话列表失败: {e}"
        if not recents:
            return "暂无最近对话"
        lines = [f"{i + 1}. {r['title']}" for i, r in enumerate(recents)]
        return "最近对话：\n" + "\n".join(lines)

    # /select <序号>
    if cmd == "/select":
        if len(parts) < 2:
            return "用法: /select <序号>，例如: /select 3"
        try:
            num = int(parts[1])
            if num < 1:
                raise ValueError
        except ValueError:
            return f"序号无效「{parts[1]}」，请输入正整数"
        headers = {"Content-Type": "application/json"}
        if API_KEY:
            headers["Authorization"] = f"Bearer {API_KEY}"
        # 先获取列表拿到标题
        title = ""
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(f"{API_BASE}/internal/get_recents", headers=headers)
                resp.raise_for_status()
                recents = resp.json().get("recents", [])
                if 0 <= num - 1 < len(recents):
                    title = recents[num - 1].get("title", "")
        except Exception:
            pass  # 拿不到标题不影响切换
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(
                    f"{API_BASE}/internal/select_chat",
                    json={"index": num - 1},
                    headers=headers,
                )
        except Exception as e:
            return f"选择对话失败: {e}"
        title_tip = f"：{title}" if title else ""
        return f"已切换到对话 {num}{title_tip}"

    return f"未知指令「{parts[0]}」，输入 /help 查看所有指令"

# ─── API 调用 ──────────────────────────────────────────────────────────────────

async def _call_api(messages: list[dict]) -> str:
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"

    async with httpx.AsyncClient(timeout=1800) as client:
        resp = await client.post(
            f"{API_BASE}/v1/chat/completions",
            json={
                "model":    BOT_MODEL,
                "messages": messages,
                "stream":   False,
            },
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]

# ─── 主入口（作为 asyncio 后台任务运行） ──────────────────────────────────────

async def run_wechat_bot() -> None:
    # 用于在 on_error 回调中访问当前消息上下文
    _ctx: dict = {"msg": None}
    _loop = asyncio.get_running_loop()  # 在协程内获取，保证拿到正确的 loop

    async def _send_err(msg, text: str) -> None:
        """向微信发送错误通知（内部用，不再递归触发 on_error）"""
        if not text:
            text = "未知错误"
        print(f"[WechatBot] 尝试发送错误通知: {text[:60]}", flush=True)
        try:
            await bot.reply(msg, text)
            print("[WechatBot] 错误通知已发送", flush=True)
        except Exception as e2:
            print(f"[WechatBot] 错误通知发送失败: {e2}", flush=True)

    def _on_error(err) -> None:
        """SDK 内部错误回调（同步），通过 create_task 异步通知微信"""
        print(f"[WechatBot] 错误: {err} | ctx={'有msg' if _ctx.get('msg') else '无msg'}", flush=True)
        msg = _ctx.get("msg")
        if msg is not None:
            try:
                _loop.call_soon_threadsafe(
                    lambda: _loop.create_task(_send_err(msg, f"发生错误: {err}"))
                )
            except Exception as e2:
                print(f"[WechatBot] 无法调度错误通知: {e2}", flush=True)
        else:
            print("[WechatBot] ctx_msg 为 None，无法通知微信", flush=True)

    async def _keep_typing(user_id: str, stop_evt: asyncio.Event) -> None:
        """每 5 秒刷新一次 typing 状态，直到 stop_evt 被设置"""
        while True:
            try:
                await bot.send_typing(user_id)
            except Exception:
                pass
            try:
                await asyncio.wait_for(stop_evt.wait(), timeout=5.0)
                break  # stop_evt 已设置，退出
            except asyncio.TimeoutError:
                pass  # 5s 到期，继续刷新

    bot = WeChatBot(
        on_qr_url=lambda url: print(f"\n[WechatBot] 扫码登录:\n{url}\n", flush=True),
        on_error=_on_error,
    )

    try:
        creds = await bot.login()
        print(f"[WechatBot] 登录成功: {creds.account_id} ({creds.user_id})", flush=True)
    except Exception as e:
        print(f"[WechatBot] 登录失败: {e}", flush=True)
        return

    @bot.on_message
    async def handle(msg):
        _ctx["msg"] = msg  # 供 on_error 使用

        # ── 纯图片消息：缓存图片，等待后续文字 ──────────────────────────────
        if msg.type == "image":
            print(f"[WechatBot] ← {msg.user_id}: [图片]", flush=True)
            try:
                media = await bot.download(msg)
                if media and media.type == "image":
                    mime = _detect_mime(media.data)
                    b64 = base64.b64encode(media.data).decode()
                    _pending_images[msg.user_id] = {"b64": b64, "mime": mime, "ts": time.time()}
                    print(f"[WechatBot] 图片已缓存，等待文字问题", flush=True)
                    try:
                        await bot.reply(msg, "已收到图片，请发送您的问题")
                    except Exception:
                        pass
                else:
                    await bot.reply(msg, "图片格式不支持")
            except Exception as e:
                print(f"[WechatBot] 图片下载失败: {e}", flush=True)
                try:
                    await bot.reply(msg, f"图片下载失败: {e}")
                except Exception:
                    pass
            return

        # ── 非文字消息（语音/文件/视频）：暂不支持 ──────────────────────────
        if msg.type != "text" or not msg.text:
            return

        # ── 文字消息（可能与缓存图片合并）────────────────────────────────────
        print(f"[WechatBot] ← {msg.user_id}: {msg.text}", flush=True)

        try:
            # 指令检测
            cmd_reply = await _handle_command(msg.user_id, msg.text)
            if cmd_reply is not None:
                print(f"[WechatBot] [cmd] → {msg.user_id}: {cmd_reply}", flush=True)
                if cmd_reply.strip():
                    try:
                        await bot.reply(msg, cmd_reply)
                    except Exception as e:
                        print(f"[WechatBot] 指令回复失败: {e}", flush=True)
                return

            # 检查是否有缓存图片（未超时则合并）
            user_content: str | list = msg.text
            history_text = msg.text
            pending = _pending_images.pop(msg.user_id, None)
            if pending and (time.time() - pending["ts"]) <= PENDING_IMAGE_TIMEOUT:
                user_content = [
                    {"type": "image_url", "image_url": {"url": f"data:{pending['mime']};base64,{pending['b64']}"}},
                    {"type": "text", "text": msg.text},
                ]
                print(f"[WechatBot] 图片+文字组合请求", flush=True)

            # 启动 typing 保活，调用 API，发送回复后停止
            typing_stop = asyncio.Event()
            typing_task = asyncio.create_task(_keep_typing(msg.user_id, typing_stop))

            try:
                messages = _get_messages(msg.user_id, user_content)

                try:
                    reply = await _call_api(messages)
                except Exception as e:
                    print(f"[WechatBot] API 调用失败: {e}", flush=True)
                    reply = ""

                if not reply or not reply.strip():
                    reply = "（服务返回了空回复，请稍后重试）"

                _save_turn(msg.user_id, history_text, reply.replace(SPLIT_MARKER, " "))

                # 按分隔标记拆成多条微信消息
                parts = [p.strip() for p in reply.split(SPLIT_MARKER) if p.strip()]
                if not parts:
                    parts = ["（服务返回了空回复，请稍后重试）"]

                print(f"[WechatBot] → {msg.user_id} ({len(parts)}条): {parts[0][:60]}{'...' if len(parts[0]) > 60 else ''}", flush=True)

                # 发完所有部分后再停止 typing
                for i, part in enumerate(parts):
                    if not part:  # 严格防空，避免 SDK 报错
                        continue
                    await bot.reply(msg, part)
                    if i < len(parts) - 1:
                        await asyncio.sleep(0.5)

            except Exception as e:
                print(f"[WechatBot] 发送回复失败: {e}", flush=True)
                err_msg = f"发送失败: {e}"
                if err_msg.strip():
                    try:
                        await bot.reply(msg, err_msg)
                    except Exception:
                        pass

            finally:
                typing_stop.set()
                typing_task.cancel()
                try:
                    await typing_task
                except (asyncio.CancelledError, Exception):
                    pass

        except Exception as e:
            print(f"[WechatBot] 顶层异常: {e}", flush=True)
            err_msg = f"发生错误: {e}"
            if err_msg.strip():
                try:
                    await bot.reply(msg, err_msg)
                except Exception:
                    pass

        finally:
            _ctx["msg"] = None  # 清除上下文，避免跨消息误触发

    print("[WechatBot] 开始监听消息…", flush=True)
    try:
        await bot.start()
    except asyncio.CancelledError:
        bot.stop()
        print("[WechatBot] 已停止", flush=True)


