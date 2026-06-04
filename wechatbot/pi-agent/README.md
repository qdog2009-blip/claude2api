# @wechatbot/pi-agent

Pi extension — type `/wechat` in pi, scan QR code in terminal, chat with Pi from WeChat.

## Install

### From npm (recommended)

```bash
pi install npm:@wechatbot/pi-agent
```

Done. The extension auto-loads on next `pi` session. Type `/wechat` to start.

### From git

```bash
pi install https://github.com/jiweiyuan/wechatbot
```

### Quick test (no install)

```bash
pi -e npm:@wechatbot/pi-agent
```

### Manual (local development)

```bash
git clone https://github.com/jiweiyuan/wechatbot
cd wechatbot/pi-agent && npm install

# Load directly
pi -e ./src/index.ts

# Or copy to auto-discovery directory
cp -r . ~/.pi/agent/extensions/wechat/
```

## Usage

```
/wechat              Scan QR code → connect WeChat to this pi session
/weixin              Alias for /wechat
/wechat --force      Force re-login (new QR code)
/wechat-disconnect   Disconnect
/wechat-send <text>  Send text to WeChat user manually
```

### What happens

```
> /wechat

  📱 Scan this QR code in WeChat:

    ▄▄▄▄▄▄▄ ▄▄▄ ▄▄▄▄▄▄▄
    █ ▄▄▄ █ █▀█ █ ▄▄▄ █
    █ ███ █ ▄▀▄ █ ███ █
    █▄▄▄▄▄█ █ ▄ █▄▄▄▄▄█
    ▄▄▄▄▄ ▄▄▄█▄▄▄ ▄▄▄▄▄
    █▄█▀█▄▄ ▀▀▄▀▀█▄▀█▀▄
    ▄▄▄▄▄▄▄ ▀▄ █▀▄█▄█▀▄
    █▄▄▄▄▄█ █▀▄█▀▀█▀███

  [wechat] ✓ Connected: e06c1ceea05e@im.bot

# Now send "帮我看看这个bug" from WeChat...
# Pi processes it, sends reply back to WeChat.
# "对方正在输入中..." shown while Pi thinks.
```

## How It Works

```
WeChat User (phone)
    │
    ▼
iLink API (Tencent) ←── @wechatbot/wechatbot SDK
    │
    ▼
Pi Extension
    │
    ├── WeChat msg → pi.sendUserMessage(text)  → pi processes as prompt
    │
    └── pi.on('agent_end') → bot.reply(text)   → sent back to WeChat
```

1. `/wechat` creates a `WeChatBot` instance (SDK)
2. SDK calls iLink API → gets QR URL
3. `qrcode-terminal` renders QR code in pi TUI via `ctx.ui.setWidget()`
4. User scans QR in WeChat → login confirmed → credentials saved
5. SDK starts long-poll → incoming WeChat messages trigger `pi.sendUserMessage()`
6. When pi finishes (`agent_end` event), response is sent back via `bot.reply()`
7. `bot.sendTyping()` shows "对方正在输入中..." while pi thinks

## QR Code Display

The QR code is rendered using `qrcode-terminal` — a real scannable QR code in the terminal.

The **SDK does NOT render QR codes** — that is the developer's responsibility.
This extension is the developer. It receives the URL via `onQrUrl` callback and renders it.

## Dependencies

| Package | Purpose |
|---|---|
| `@wechatbot/wechatbot` | WeChat iLink Bot SDK — login, poll, send, typing, context_token |
| `qrcode-terminal` | Render scannable QR code in terminal |
| `@mariozechner/pi-coding-agent` | Pi extension API (peer dependency) |

## Pi Package

This is a [pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md). It declares `"keywords": ["pi-package"]` and `"pi": { "extensions": [...] }` in package.json. Pi auto-discovers the extension after install.
