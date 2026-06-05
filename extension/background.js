/**
 * background.js — Service Worker
 * 负责：
 *  1. 与 Python FastAPI 服务建立 WebSocket 连接（自动重连）
 *  2. 收到 task 后找到/创建 claude.ai tab，将任务转发给 content.js
 *  3. 将 content.js 的 chunk/done/error 消息通过 WebSocket 发回服务
 */

const DEFAULT_SERVER_URL = "ws://localhost:8000/ws";
const HEARTBEAT_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let heartbeatTimer = null;
let serverUrl = DEFAULT_SERVER_URL;

// ─── 初始化：从 storage 读取配置 ──────────────────────────────────────────────
chrome.storage.local.get(["serverUrl"], (result) => {
  if (result.serverUrl) serverUrl = result.serverUrl;
  connect();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl) {
    serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER_URL;
    if (ws) ws.close();
  }
});

// ─── WebSocket 连接 ────────────────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log("[BG] Connecting to", serverUrl);
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    console.error("[BG] WebSocket creation failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[BG] Connected to Python server");
    reconnectDelay = RECONNECT_BASE_MS;
    startHeartbeat();
    broadcastStatus(true);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "task") {
      await handleTask(msg);
    } else if (msg.type === "new_chat") {
      await handleNewChat(msg.model || null);
    } else if (msg.type === "reload") {
      await handleReload();
    } else if (msg.type === "get_recents") {
      await handleGetRecents(msg);
    } else if (msg.type === "get_last_reply") {
      await handleGetLastReply(msg);
    } else if (msg.type === "select_chat") {
      await handleSelectChat(msg);
    } else if (msg.type === "ping") {
      sendWs({ type: "pong" });
    }
  };

  ws.onerror = (err) => {
    console.warn("[BG] WebSocket error:", err);
  };

  ws.onclose = () => {
    console.log("[BG] WebSocket closed");
    stopHeartbeat();
    broadcastStatus(false);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  setTimeout(() => connect(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: "ping" });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ type: "status", connected }).catch(() => {});
}

// ─── reload 指令处理 ──────────────────────────────────────────────────────────
async function handleReload() {
  const tab = await findClaudeTab();
  if (tab) {
    chrome.tabs.reload(tab.id);
  }
}

// ─── get_recents 指令处理 ─────────────────────────────────────────────────────
async function handleGetRecents({ request_id }) {
  let tab = await findClaudeTab();
  if (!tab) {
    tab = await createClaudeTab();
    await waitForTabLoad(tab.id);
  }

  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);

  const ready = await waitForContentScript(tab.id, 10, 1000);
  if (!ready) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(500);
    } catch (e) {
      console.warn("[BG] Manual inject failed:", e);
    }
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "get_recents" });
    sendWs({ type: "recents_result", request_id, recents: resp.recents || [] });
  } catch (e) {
    sendWs({ type: "recents_result", request_id, error: String(e) });
  }
}

// ─── get_last_reply 指令处理 ──────────────────────────────────────────────────
async function handleGetLastReply({ request_id }) {
  let tab = await findClaudeTab();
  if (!tab) {
    sendWs({ type: "last_reply_result", request_id, error: "No Claude tab found" });
    return;
  }

  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);

  const ready = await waitForContentScript(tab.id, 10, 1000);
  if (!ready) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(500);
    } catch (e) {
      console.warn("[BG] Manual inject failed:", e);
    }
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "get_last_reply" });
    sendWs({ type: "last_reply_result", request_id, text: resp.text || "" });
  } catch (e) {
    sendWs({ type: "last_reply_result", request_id, error: String(e) });
  }
}

// ─── select_chat 指令处理 ─────────────────────────────────────────────────────
async function handleSelectChat({ index }) {
  let tab = await findClaudeTab();
  if (!tab) {
    tab = await createClaudeTab();
    await waitForTabLoad(tab.id);
  }
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);

  const ready = await waitForContentScript(tab.id, 10, 1000);
  if (!ready) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(500);
    } catch (e) {
      console.warn("[BG] Manual inject failed:", e);
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "select_chat", index });
  } catch (e) {
    console.error("[BG] handleSelectChat failed:", e);
  }
}

// ─── new_chat 指令处理 ────────────────────────────────────────────────────────
async function handleNewChat(model) {
  let tab = await findClaudeTab();
  if (!tab) {
    tab = await createClaudeTab();
    await waitForTabLoad(tab.id);
  }

  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);

  const ready = await waitForContentScript(tab.id, 10, 1000);
  if (!ready) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(500);
    } catch (e) {
      console.warn("[BG] Manual inject failed:", e);
    }
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "new_chat", model });
  } catch (e) {
    console.error("[BG] handleNewChat sendMessage failed:", e);
  }
}

// ─── 任务处理：找到/创建 claude.ai tab ────────────────────────────────────────
async function handleTask(task) {
  const { request_id, messages, model } = task;

  let tab = await findClaudeTab();
  if (!tab) {
    tab = await createClaudeTab();
    await waitForTabLoad(tab.id);
  }

  // execCommand 必须在前台标签页才能执行，先激活
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);

  // 确保 content.js 已就绪，最多重试 10 次（每次等 1s）
  const ready = await waitForContentScript(tab.id, 10, 1000);
  if (!ready) {
    // 尝试手动注入
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(500);
    } catch (e) {
      console.warn("[BG] Manual inject failed:", e);
    }
  }

  // 将任务转发给 content.js（带重试）
  const MAX_SEND_RETRIES = 5;
  for (let i = 0; i < MAX_SEND_RETRIES; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "task",
        request_id,
        messages,
        model,
      });
      if (response && response.error) {
        sendWs({ type: "error", request_id, message: response.error });
      }
      return;
    } catch (e) {
      console.warn(`[BG] sendMessage attempt ${i + 1} failed:`, e.message);
      if (i < MAX_SEND_RETRIES - 1) {
        await sleep(1000);
      } else {
        sendWs({ type: "error", request_id, message: String(e) });
      }
    }
  }
}

async function findClaudeTab() {
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  return tabs.length > 0 ? tabs[0] : null;
}

async function createClaudeTab() {
  return chrome.tabs.create({ url: "https://claude.ai/new", active: false });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        // 额外等待 React 渲染
        setTimeout(resolve, 2500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 20_000);
  });
}

// 轮询 content.js 是否就绪（通过 ping/pong 握手）
async function waitForContentScript(tabId, maxRetries, delayMs) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (resp && resp.pong) return true;
    } catch {
      // 尚未就绪
    }
    await sleep(delayMs);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 接收 content.js 的上行消息 ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "chunk" || msg.type === "split" || msg.type === "complete_text" || msg.type === "done" || msg.type === "error") {
    sendWs(msg);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "getStatus") {
    sendResponse({ connected: ws && ws.readyState === WebSocket.OPEN });
    return true;
  }
});
