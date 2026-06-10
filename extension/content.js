/**
 * content.js — 注入 claude.ai 页面
 * 负责：
 *  1. 接收 background.js 转发的 task
 *  2. 将用户消息注入 Claude 输入框并提交
 *  3. 通过 MutationObserver 捕获流式响应，逐 chunk 上报给 background
 */

// ─── 选择器（按优先级 fallback） ───────────────────────────────────────────────
const INPUT_SELECTORS = [
  'div[contenteditable="true"][data-testid="chat-input"]',
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"]',
];

const SEND_SELECTORS = [
  'button[aria-label="Send message"]',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[type="submit"]',
];

// 识别"正在生成"的停止按钮
const STOP_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label*="Stop"]',
  'button[data-testid="stop-button"]',
];

// 助手消息容器（普通模式 + Research 模式）
const RESPONSE_SELECTORS = [
  '[data-testid="assistant-message"]',
  '.assistant-message',
  '[data-is-streaming="true"]',
  'div.font-claude-response',  // Research 模式下无 assistant-message，用此兜底
];

// 新建对话按钮选择器
const NEW_CHAT_SELECTORS = [
  'a[href="/new"]',
  'button[aria-label*="New chat"]',
  'button[aria-label*="new chat"]',
  'a[aria-label*="New chat"]',
];


// 模型选择器选择器
const MODEL_BTN_SELECTORS = [
  'button[data-testid="model-selector-dropdown"]',
  'button[aria-label*="model" i]',
  'button[data-testid*="model"]',
];

// Research 模式按钮选择器
const RESEARCH_BTN_SELECTORS = [
  'button[aria-label*="Research" i]',
  'button[data-testid*="research" i]',
  'button[aria-label*="Deep research" i]',
  'button[data-testid*="deep-research" i]',
];

// 输入框左下角"+"（附加功能）按钮选择器
const PLUS_BTN_SELECTORS = [
  'button[aria-label*="Add content" i]',
  'button[aria-label*="Attach" i]',
  'button[data-testid*="attach" i]',
  'button[data-testid*="add-content" i]',
  'button[aria-label="+"]',
];


const taskQueue = [];
let processing = false;

// ─── 监听来自 background 的消息 ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ pong: true });
    return true;
  }
  if (msg.type === "new_chat") {
    handleNewChat(msg.model || null).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "get_recents") {
    sendResponse({ recents: getRecentChats(10) });
    return true;
  }
  if (msg.type === "get_last_reply") {
    const els = getAssistantElements();
    const last = els[els.length - 1];
    const text = last ? (last.innerText || last.textContent || "").trim() : "";
    sendResponse({ text });
    return true;
  }
  if (msg.type === "select_chat") {
    selectChat(msg.index).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type !== "task") return false;

  taskQueue.push({ msg, sendResponse });
  if (!processing) processNext();
  return true; // 保持 sendResponse 通道开放
});

async function processNext() {
  if (taskQueue.length === 0) {
    processing = false;
    return;
  }
  processing = true;
  const { msg, sendResponse } = taskQueue.shift();
  try {
    await runTask(msg);
    sendResponse({ ok: true });
  } catch (e) {
    console.error("[Content] Task error:", e);
    chrome.runtime.sendMessage({
      type: "error",
      request_id: msg.request_id,
      message: String(e),
    });
    sendResponse({ error: String(e) });
  }
  processNext();
}

// ─── 主任务流程 ────────────────────────────────────────────────────────────────
async function runTask({ request_id, messages }) {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  if (!lastUserMsg) throw new Error("No user message found");

  // 解析内容：兼容纯文本 string 和 OpenAI 多模态 array
  let textContent = "";
  const imageUrls = [];
  const content = lastUserMsg.content;
  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") textContent += (part.text || "");
      else if (part.type === "image_url" && part.image_url?.url) {
        imageUrls.push(part.image_url.url);
      }
    }
  }

  const isNewConversation = userMessages.length === 1;

  if (isNewConversation) {
    // 点击"新建对话"按钮触发 SPA 路由，而非 history.pushState
    const newChatBtn = findElement(NEW_CHAT_SELECTORS);
    if (newChatBtn) {
      newChatBtn.click();
    } else {
      // 兜底：直接跳转（会触发页面刷新，content.js 会重新注入）
      window.location.href = "https://claude.ai/new";
    }
    // 等待输入框出现（SPA 路由完成 + React 渲染）
    await waitForElement(INPUT_SELECTORS, 10_000);
    await sleep(500);
  }

  const inputEl = await waitForElement(INPUT_SELECTORS, 10_000);
  if (!inputEl) throw new Error("Input element not found");

  // 1. 清空输入框
  inputEl.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  await sleep(100);

  // 2. 粘贴图片（若有）
  for (const url of imageUrls) {
    await pasteImageToInput(inputEl, url);
    await sleep(500);
  }

  // 3. 插入文字（追加在图片之后，不清空）
  if (textContent) {
    inputEl.focus();
    document.execCommand("insertText", false, textContent);
    // 兜底：若无图片且 execCommand 失效，直接设置
    if (!imageUrls.length && inputEl.textContent !== textContent) {
      inputEl.textContent = textContent;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: textContent }));
    }
  }
  await sleep(300);

  // 等待发送按钮可用（图片上传期间按钮为 disabled）
  const sendBtn = await waitForSendButtonReady(imageUrls.length > 0 ? 60_000 : 5_000);
  if (!sendBtn) throw new Error("Send button not found");

  // 发送前记录已有的 assistant 元素数量，用于识别新回复
  const prevCount = getAssistantElements().length;

  sendBtn.click();
  await sleep(800);

  await collectResponse(request_id, prevCount);
}

// ─── 图片粘贴（模拟 Ctrl+V） ──────────────────────────────────────────────────
async function pasteImageToInput(inputEl, imageUrl) {
  try {
    let blob;
    if (imageUrl.startsWith("data:")) {
      const [header, b64] = imageUrl.split(",");
      const mime = header.match(/:(.*?);/)[1];
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      blob = new Blob([bytes], { type: mime });
    } else {
      const resp = await fetch(imageUrl);
      blob = await resp.blob();
    }
    const ext = (blob.type || "image/jpeg").split("/")[1] || "jpg";
    const file = new File([blob], `image.${ext}`, { type: blob.type || "image/jpeg" });

    inputEl.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    inputEl.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }));
    await sleep(500);
  } catch (e) {
    console.error("[Claude2API] pasteImageToInput error:", e);
  }
}

// ─── 文本注入（兼容 React 的 contenteditable） ────────────────────────────────
async function injectText(el, text) {
  el.focus();
  // 清空已有内容
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  await sleep(100);
  // 插入文本（触发 React 合成事件）
  document.execCommand("insertText", false, text);
  // 兜底：若 execCommand 失效，直接设置并派发事件
  if (el.textContent !== text) {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
}

// ─── 响应采集 ─────────────────────────────────────────────────────────────────

function getAssistantElements() {
  const seen = new Set();
  const candidates = [];
  for (const sel of RESPONSE_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (!seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    }
  }
  if (candidates.length === 0) return [];
  // 去掉被其他候选元素包含的子元素（普通模式下 font-claude-response 在 assistant-message 内部）
  return candidates.filter(el =>
    !candidates.some(other => other !== el && other.contains(el))
  );
}

async function collectResponse(request_id, prevCount) {
  // 等待停止按钮出现（表示生成已开始）
  await waitForElement(STOP_SELECTORS, 15_000);

  return new Promise((resolve, reject) => {
    // 记录每个新 assistant 元素已输出的文本长度
    const capturedText = new Map();
    const seenElements = new Set(); // 记录已首次遇到的元素
    let settled = false;
    let stopCheckTimer = null;
    let lastChunkTime = Date.now();

    function finish(error) {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(stopCheckTimer);
      if (error) {
        chrome.runtime.sendMessage({ type: "error", request_id, message: error });
        reject(new Error(error));
      } else {
        const newEls = getAssistantElements().slice(prevCount);
        // 补发任何未捕获的尾部文本（例如标签页切到后台时 innerText 曾为空导致漏发）
        for (const el of newEls) {
          const current = el.innerText || el.textContent || "";
          const prev = capturedText.get(el) || "";
          if (current.length > prev.length) {
            chrome.runtime.sendMessage({ type: "chunk", request_id, text: current.slice(prev.length) });
            capturedText.set(el, current);
          }
        }
        // 发送完整权威文本（非流式路径直接使用；流式路径用于 delta 校验）
        const texts = newEls
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean);
        // 捕获搜索来源引用（Research 模式下出现在 assistant-message 之外）
        const sourceLinks = Array.from(document.querySelectorAll('div.flex.flex-col.gap-1 a'));
        if (sourceLinks.length > 0) {
          const sourceEntries = sourceLinks
            .map((a, i) => {
              const title = (a.textContent || "").trim();
              const href = a.href || "";
              if (!title && !href) return null;
              return `${i + 1}. ${title}`;  // 只保留标题，不含 URL（避免微信拒绝含链接消息）
            })
            .filter(Boolean);
          if (sourceEntries.length > 0) {
            const section = "\n\n参考来源：\n" + sourceEntries.join("\n");
            if (texts.length > 0) {
              texts[texts.length - 1] += section;
            } else {
              texts.push(section.trim());
            }
            // 补发来源作为额外 chunk（流式路径 delta 校验也会覆盖，双重保险）
            chrome.runtime.sendMessage({ type: "chunk", request_id, text: section });
          }
        }
        if (texts.length > 0) {
          chrome.runtime.sendMessage({
            type: "complete_text",
            request_id,
            text: texts.join("<<SPLIT>>"),
          });
        }
        chrome.runtime.sendMessage({ type: "done", request_id });
        resolve();
      }
    }

    // 扫描所有比 prevCount 新增的 assistant 元素，输出新增文本
    function sweepNewElements() {
      const all = getAssistantElements();
      const newEls = all.slice(prevCount);   // 只看本次请求后新增的元素
      for (const el of newEls) {
        // 首次遇到该元素：若已有其他元素的内容，发送分隔信号
        if (!seenElements.has(el)) {
          seenElements.add(el);
          if (capturedText.size > 0) {
            // 先把当前已有内容记录下来（避免后续 prev 计算起点错误）
            capturedText.set(el, "");
            chrome.runtime.sendMessage({ type: "split", request_id });
          }
        }
        const current = el.innerText || el.textContent || "";
        const prev = capturedText.get(el) || "";
        if (current.length > prev.length) {
          const chunk = current.slice(prev.length);
          capturedText.set(el, current);
          lastChunkTime = Date.now();
          chrome.runtime.sendMessage({ type: "chunk", request_id, text: chunk });
        }
      }
    }

    // 观察整个 body 子树，捕获新增/变更的 assistant 元素内容
    const observer = new MutationObserver(sweepNewElements);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 轮询：stop 按钮消失 + 距上次输出超过 2s → 认为完成
    stopCheckTimer = setInterval(() => {
      const stopBtn = findElement(STOP_SELECTORS);
      if (!stopBtn) {
        const silence = Date.now() - lastChunkTime;
        if (silence >= 2000) {
          sweepNewElements(); // 最终补刷
          finish(null);
        }
      } else {
        // stop 按钮仍在，继续扫描（防止 MutationObserver 遗漏）
        sweepNewElements();
      }
    }, 500);

    // 超时保护 30 分钟（兼容 Research 模式）
    setTimeout(() => finish("Timeout waiting for response"), 1_800_000);
  });
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function waitForElement(selectors, timeoutMs) {
  return new Promise((resolve) => {
    const el = findElement(selectors);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = findElement(selectors);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// ─── new_chat 指令：新建对话 + 可选切换模型 ───────────────────────────────────
async function handleNewChat(model) {
  const newChatBtn = findElement(NEW_CHAT_SELECTORS);
  if (newChatBtn) {
    newChatBtn.click();
  } else {
    window.location.href = "https://claude.ai/new";
  }
  // 等待输入框就绪
  await waitForElement(INPUT_SELECTORS, 10_000);
  await sleep(500);

  if (model === "research") {
    // research 模式：先切换到 opus，再启用 Research 模式
    await selectModel("Opus");
    await sleep(400);
    await enableResearchMode();
  } else if (model) {
    await selectModel(model);
  }
}

/**
 * 点击模型选择器，找到文本含 keyword（opus/sonnet）的选项并点击。
 * 忽略版本号，只匹配关键字（大小写不敏感）。
 */
async function selectModel(keyword) {
  const btn = await waitForElement(MODEL_BTN_SELECTORS, 5_000);
  if (!btn) {
    console.warn("[Claude2API] model selector button not found");
    return;
  }
  btn.click();
  await sleep(1000);

  // 用 XPath 精确定位 font-ui span 中含 keyword 的选项
  const optionSpan = document.evaluate(
    `//span[@class="font-ui" and contains(normalize-space(),"${keyword}")]`,
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  ).singleNodeValue;
  if (optionSpan) {
    optionSpan.click();
    return;
  }

  // 兜底：遍历所有可见的菜单项，找含 keyword 的第一个
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], [data-testid*="model"]'
  );
  for (const el of candidates) {
    if (el.textContent.toLowerCase().includes(keyword.toLowerCase())) {
      el.click();
      return;
    }
  }
  console.warn(`[Claude2API] model option for "${keyword}" not found`);
}

/**
 * 启用 Research 模式：
 * 1. 点击输入框左下角的"+"按钮展开菜单
 * 2. 在菜单中找到含"Research"的选项并点击
 */
async function enableResearchMode() {
  // 点击 fieldset 内按钮的第二个 span 子元素展开菜单
  const triggerSpan = document.querySelector('fieldset button > span:nth-child(2) > span');
  if (!triggerSpan) {
    console.warn("[Claude2API] Research trigger span not found");
    return;
  }
  triggerSpan.click();
  await sleep(400);

  // 用 XPath 精确定位文字为"Research"的 span 并点击
  const researchSpan = document.evaluate(
    '//span[contains(@class,"block") and contains(@class,"truncate") and normalize-space()="Research"]',
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  ).singleNodeValue;

  if (!researchSpan) {
    console.warn("[Claude2API] Research mode option not found in menu");
    return;
  }
  researchSpan.click();
  await sleep(300);
  console.log("[Claude2API] Research mode enabled");
}

// ─── 最近对话列表 ──────────────────────────────────────────────────────────────
function getRecentChats(limit) {
  const items = document.querySelectorAll('a[data-dd-action-name="sidebar-chat-item"]');
  const results = [];
  for (const el of items) {
    if (results.length >= limit) break;
    const title = (el.textContent || "").trim()
      || el.getAttribute("title")
      || el.getAttribute("aria-label")
      || "(无标题)";
    results.push({ title, href: el.getAttribute("href") });
  }
  return results;
}

// ─── 选中指定对话 ──────────────────────────────────────────────────────────────
async function selectChat(index) {
  const items = document.querySelectorAll('a[data-dd-action-name="sidebar-chat-item"]');
  const el = items[index];
  if (!el) throw new Error(`对话序号 ${index + 1} 不存在`);

  const prevUrl = location.href;
  el.click();

  // 等待 URL 变化，确认 SPA 跳转已发生（避免命中旧页面的输入框就提前返回）
  const navStart = Date.now();
  while (location.href === prevUrl && Date.now() - navStart < 5000) {
    await sleep(100);
  }

  // 等待新页面的输入框及助手消息渲染完成
  await waitForElement(INPUT_SELECTORS, 10_000);
  await waitForElement(RESPONSE_SELECTORS, 5_000); // 空对话会等满后超时返回，无副作用
}

// ─── 等待发送按钮可用（图片上传完成后才会 enabled） ────────────────────────────
async function waitForSendButtonReady(timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = findElement(SEND_SELECTORS);
    if (btn && !btn.disabled && btn.getAttribute("disabled") === null) {
      return btn;
    }
    await sleep(500);
  }
  // 超时后兜底返回（无论是否可用都尝试点击）
  return findElement(SEND_SELECTORS);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log("[Claude2API] content.js loaded");
