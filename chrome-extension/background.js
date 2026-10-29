/**
 * Gemini Bridge - Background Service Worker
 * Manages WebSocket connection to local orchestrator without page CSP restrictions.
 */

const WS_URLS = ['ws://127.0.0.1:8765', 'ws://localhost:8765'];
let currentWsIndex = 0;
let socket = null;
let isConnected = false;
let lastKnownConfig = { safeMode: true };
let activeTabId = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const targetUrl = WS_URLS[currentWsIndex % WS_URLS.length];
  try {
    socket = new WebSocket(targetUrl);
  } catch (err) {
    console.error('[Background] WebSocket init error:', err);
    isConnected = false;
    currentWsIndex++;
    setTimeout(connect, 2000);
    return;
  }

  socket.onopen = () => {
    console.log('[Background] Connected to local orchestrator on', targetUrl);
    isConnected = true;
    broadcastToTabs({ type: 'WS_STATUS', connected: true, safeMode: lastKnownConfig.safeMode });
  };

  socket.onclose = () => {
    console.log('[Background] Disconnected from local orchestrator, retrying...');
    isConnected = false;
    socket = null;
    broadcastToTabs({ type: 'WS_STATUS', connected: false });
    currentWsIndex++;
    setTimeout(connect, 2000);
  };

  socket.onerror = (err) => {
    console.error('[Background] Socket error:', err);
    isConnected = false;
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'CONFIG') {
        lastKnownConfig = msg;
        broadcastToTabs(msg);
      } else if (msg.type === 'PROMPT') {
        sendToActiveWebchatTab(msg);
      }
    } catch (e) {
      console.error('[Background] Parse error from server message:', e);
    }
  };
}

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (
        tab.id &&
        tab.url &&
        (tab.url.includes('gemini.google.com') ||
          tab.url.includes('chatgpt.com') ||
          tab.url.includes('chat.openai.com') ||
          tab.url.includes('claude.ai'))
      ) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  });
}

function sendToActiveWebchatTab(message) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (activeTabs) => {
    const candidate = activeTabs.find(
      (t) =>
        t.url &&
        (t.url.includes('gemini.google.com') ||
          t.url.includes('chatgpt.com') ||
          t.url.includes('claude.ai'))
    );
    if (candidate && candidate.id) {
      activeTabId = candidate.id;
      chrome.tabs.sendMessage(candidate.id, message).catch(() => {});
      return;
    }

    chrome.tabs.query({}, (allTabs) => {
      const anyWebchat = allTabs.find(
        (t) =>
          t.url &&
          (t.url.includes('gemini.google.com') ||
            t.url.includes('chatgpt.com') ||
            t.url.includes('claude.ai'))
      );
      if (anyWebchat && anyWebchat.id) {
        activeTabId = anyWebchat.id;
        chrome.tabs.sendMessage(anyWebchat.id, message).catch(() => {});
      } else if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            message: 'No active Gemini, ChatGPT, or Claude tab found in browser.'
          })
        );
      }
    });
  });
}

// Receive messages from content.js (HELLO, STATUS, RESPONSE, ERROR)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.tab && sender.tab.id) {
    activeTabId = sender.tab.id;
  }

  if (request.type === 'GET_WS_STATUS') {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connect();
    }
    const open = Boolean(socket && socket.readyState === WebSocket.OPEN);
    sendResponse({ connected: open, safeMode: lastKnownConfig.safeMode });
    return true;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(request));
  } else {
    console.warn('[Background] Socket not open, dropped message:', request.type);
  }
});

connect();
