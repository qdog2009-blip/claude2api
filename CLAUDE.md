# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**claude2api** 将 claude.ai 网页端转换为 OpenAI 兼容的 REST API，无需 Anthropic API Key。整体由三个组件协作完成：

```
调用方 (curl / 任意 OpenAI 客户端)
    ↓ HTTP POST /v1/chat/completions
Python FastAPI 服务 (server/main.py)
    ↓ WebSocket ws://localhost:8000/ws
Chrome 扩展 background.js
    ↓ chrome.tabs.sendMessage
content.js（注入 claude.ai 页面）
    → DOM 注入文本 → 提交 → MutationObserver 采集响应
    ← chunk / done / error 逐步上报
```

## 启动服务

```bash
cd server
pip install -r requirements.txt
python main.py            # 监听 0.0.0.0:8000
# 或
uvicorn main:app --host 0.0.0.0 --port 8000
```

Chrome 扩展：在 `chrome://extensions/` 开启开发者模式，以「加载已解压的扩展」方式加载 `extension/` 目录。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `API_KEY` | `""` | Bearer 鉴权密钥；留空则跳过鉴权 |
| `ENABLE_WECHAT_BOT` | `"0"` | 设为 `"1"` 启用微信机器人 |
| `WECHAT_SDK_PATH` | `../wechatbot/python` | Python wechatbot SDK 路径 |
| `WECHAT_API_BASE` | `http://localhost:8000` | 微信 Bot 调用本地 API 的地址 |
| `WECHAT_BOT_MODEL` | `claude-3-5-sonnet-20241022` | 微信 Bot 使用的模型 |

## 架构细节

### server/main.py — FastAPI 中间层

- **单连接模型**：`_extension_ws` 存储唯一的扩展 WebSocket 连接。
- **请求队列**：`_pending[request_id]` 是每个请求的 `asyncio.Queue`，用于接收来自扩展的 chunk。
- **消息类型**（扩展 → 服务）：`chunk`、`split`（多段回复分隔）、`complete_text`（完整权威文本）、`done`、`error`。
- **`_sanitize()`**：修复 JSON/WebSocket 传输后残留的 surrogate 字符（合法代理对合并，孤立代理丢弃）。
- **流式路径**：收到 `complete_text` 后会与已流式输出的文本做 delta 对比，补发遗漏的尾部内容。
- **内部指令接口** (`/internal/*`)：供 `wechat_bot.py` 调用，驱动扩展执行新建对话、刷新页面、获取/切换历史对话。

### extension/background.js — Service Worker

- 维护与 Python 服务的 WebSocket 连接，断线后指数退避重连（1s → 30s）。
- 每 20s 发送 `ping` 保活心跳。
- 收到 `task` 指令后：找到或创建 `claude.ai` Tab → 激活 → 等待 `content.js` 就绪（ping/pong 握手，最多重试 10 次）→ 转发给 `content.js`。
- WebSocket 服务地址可通过 Popup 保存到 `chrome.storage.local`。

### extension/content.js — 页面注入脚本

- 内置任务队列（`taskQueue`），保证多任务串行执行。
- **文本注入**：优先 `document.execCommand("insertText")`，失效则直接赋值 + 派发合成事件（兼容 React）。
- **图片注入**：模拟 `ClipboardEvent("paste")`，支持 base64 data URL 和远程 URL。
- **响应采集** (`collectResponse`)：
  - 等待停止按钮出现（生成开始信号）。
  - `MutationObserver` 监听 DOM 变化，对每个新增的 assistant 元素增量输出 chunk。
  - 定时器（500ms）轮询：停止按钮消失 + 距上次输出 ≥ 2s → 认为完成。
  - 超时保护 30 分钟（兼容 Research 模式）。
  - 多 assistant 元素（多轮 Research 块）之间发送 `split` 信号。
  - Research 模式下额外采集 `div.flex.flex-col.gap-1 a` 中的参考来源。
- **`<<SPLIT>>`**：多个 assistant 元素的完整文本用此分隔符拼接后作为 `complete_text` 发出；`wechat_bot.py` 据此拆分为多条微信消息。

### server/wechat_bot.py — 微信 Bot（可选）

- 作为 `asyncio` 后台 Task 在服务启动时运行。
- 每用户维护最近 5 条历史（`deque(maxlen=5)`），`/new` 指令清空。
- 支持图片+文字组合请求：图片消息缓存 120s，下一条文字消息触发合并为多模态请求。
- 支持 `/help /new /reload /list /select` 五个指令。
- `_keep_typing` 每 5 秒刷新 WeChat typing 状态，直到回复发送完毕。

### wechatbot/ — WeChat Bot SDK

Python SDK 位于 `wechatbot/python/wechatbot/`，由 `wechat_bot.py` 动态导入，无需独立安装。核心接口：`WeChatBot(on_qr_url, on_error)`、`bot.login()`、`bot.on_message`装饰器、`bot.reply(msg, text)`、`bot.download(msg)`、`bot.send_typing(user_id)`、`bot.start()`。

## API 端点

| 端点 | 说明 |
|---|---|
| `GET /v1/models` | 返回可用模型列表 |
| `POST /v1/chat/completions` | OpenAI 兼容，支持 `stream: true` |
| `GET /status` | 扩展连接状态 + 挂起请求数 |
| `POST /internal/new_chat` | 创建新对话（可选指定模型） |
| `POST /internal/reload` | 刷新 claude.ai 页面 |
| `GET /internal/get_recents` | 获取最近对话列表 |
| `POST /internal/select_chat` | 切换到指定对话 |
| `WS /ws` | Chrome 扩展连接点 |
