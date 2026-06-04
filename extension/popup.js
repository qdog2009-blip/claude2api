const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const urlInput = document.getElementById("urlInput");
const saveBtn = document.getElementById("saveBtn");

// ─── 加载保存的服务地址 ────────────────────────────────────────────────────────
chrome.storage.local.get(["serverUrl"], (result) => {
  urlInput.value = result.serverUrl || "ws://localhost:8000/ws";
});

// ─── 查询连接状态 ──────────────────────────────────────────────────────────────
function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setStatus(false);
      return;
    }
    setStatus(resp.connected);
  });
}

function setStatus(connected) {
  dot.className = "dot " + (connected ? "connected" : "disconnected");
  statusText.textContent = connected ? "已连接到 Python 服务" : "未连接";
}

refreshStatus();
setInterval(refreshStatus, 2000);

// ─── 保存并重连 ───────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const url = urlInput.value.trim() || "ws://localhost:8000/ws";
  chrome.storage.local.set({ serverUrl: url }, () => {
    statusText.textContent = "已保存，重连中…";
    setTimeout(refreshStatus, 1500);
  });
});
