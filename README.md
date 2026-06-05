# claude2api

[中文](README_cn.md) | English

Turns the claude.ai web interface into an OpenAI-compatible REST API — no Anthropic API key required.

## How It Works

```
Client (curl / any OpenAI-compatible app)
    ↓ HTTP POST /v1/chat/completions
Python FastAPI server (server/main.py)
    ↓ WebSocket ws://localhost:8000/ws
Chrome extension background.js
    ↓ chrome.tabs.sendMessage
content.js (injected into claude.ai)
    → inject text into DOM → submit → MutationObserver collects response
    ← chunk / done / error streamed back
```

## Quick Start

### 1. Start the Python server

```bash
cd server
pip install -r requirements.txt
python main.py            # listens on 0.0.0.0:8000
# or
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 2. Load the Chrome extension

Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` directory.

### 3. Call the API

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `""` | Bearer auth key; leave empty to disable auth |
| `ENABLE_WECHAT_BOT` | `"0"` | Set to `"1"` to enable the WeChat bot |
| `WECHAT_SDK_PATH` | `../wechatbot/python` | Path to the Python wechatbot SDK |
| `WECHAT_API_BASE` | `http://localhost:8000` | Local API address used by the WeChat bot |
| `WECHAT_BOT_MODEL` | `claude-3-5-sonnet-20241022` | Model used by the WeChat bot |

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /v1/models` | List available models |
| `POST /v1/chat/completions` | OpenAI-compatible, supports `stream: true` |
| `GET /status` | Extension connection status + pending request count |
| `POST /internal/new_chat` | Create a new conversation (optionally specify model) |
| `POST /internal/reload` | Reload the claude.ai page |
| `GET /internal/get_recents` | Get recent conversation list |
| `POST /internal/select_chat` | Switch to a specific conversation |
| `WS /ws` | Chrome extension WebSocket endpoint |

## Project Structure

```
claude2api/
├── server/
│   ├── main.py          # FastAPI middleware, manages WebSocket connections and request queue
│   ├── wechat_bot.py    # WeChat bot integration (optional)
│   └── requirements.txt
├── extension/
│   ├── manifest.json
│   ├── background.js    # Service Worker, maintains WebSocket connection
│   ├── content.js       # Page injection script, handles DOM manipulation and response collection
│   └── popup.html       # Extension popup for configuring server address
└── wechatbot/           # WeChat Bot Python SDK
```

## WeChat Bot (Optional)

Set `ENABLE_WECHAT_BOT=1` to start the WeChat bot alongside the server. Supported commands:

| Command | Description |
|---|---|
| `/help` | Show help |
| `/new` | Clear conversation history and start a new session |
| `/reload` | Reload the claude.ai page |
| `/list` | List recent conversations |
| `/select <n>` | Switch to a specific conversation |

Images and text can be sent together — images are cached for 120 seconds, and the next text message automatically triggers a multimodal request.

## Notes

- A logged-in claude.ai session must be open in the browser at all times
- Only one extension connection is supported at a time
- Response timeout is 30 minutes (to support Research mode)
