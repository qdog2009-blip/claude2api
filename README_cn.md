# claude2api

[English](README.md) | 中文

将 claude.ai 网页端转换为 OpenAI 兼容的 REST API，无需 Anthropic API Key。

## 工作原理

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

## 快速开始

### 1. 启动 Python 服务

```bash
cd server
pip install -r requirements.txt
python main.py            # 监听 0.0.0.0:8000
# 或
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 2. 加载 Chrome 扩展

在 `chrome://extensions/` 中开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `extension/` 目录。

### 3. 调用 API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `API_KEY` | `""` | Bearer 鉴权密钥；留空则跳过鉴权 |
| `ENABLE_WECHAT_BOT` | `"0"` | 设为 `"1"` 启用微信机器人 |
| `WECHAT_SDK_PATH` | `../wechatbot/python` | Python wechatbot SDK 路径 |
| `WECHAT_API_BASE` | `http://localhost:8000` | 微信 Bot 调用本地 API 的地址 |
| `WECHAT_BOT_MODEL` | `claude-3-5-sonnet-20241022` | 微信 Bot 使用的模型 |

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

## 项目结构

```
claude2api/
├── server/
│   ├── main.py          # FastAPI 中间层，管理 WebSocket 连接与请求队列
│   ├── wechat_bot.py    # 微信 Bot 集成（可选）
│   └── requirements.txt
├── extension/
│   ├── manifest.json
│   ├── background.js    # Service Worker，维护 WebSocket 连接
│   ├── content.js       # 页面注入脚本，负责 DOM 操作与响应采集
│   └── popup.html       # 扩展弹窗，配置服务地址
└── wechatbot/           # WeChat Bot Python SDK
```

## 微信 Bot（可选）

设置 `ENABLE_WECHAT_BOT=1` 后，服务启动时自动运行微信 Bot。支持以下指令：

| 指令 | 说明 |
|---|---|
| `/help` | 显示帮助信息 |
| `/new` | 清空对话历史，开始新会话 |
| `/reload` | 刷新 claude.ai 页面 |
| `/list` | 列出最近对话 |
| `/select <n>` | 切换到指定对话 |

支持图片+文字组合发送（图片缓存 120s，下一条文字消息自动合并为多模态请求）。

## 注意事项

- 需要在浏览器中保持登录 claude.ai
- 同一时间仅支持一个扩展连接
- 响应超时保护为 30 分钟（兼容 Research 模式）
