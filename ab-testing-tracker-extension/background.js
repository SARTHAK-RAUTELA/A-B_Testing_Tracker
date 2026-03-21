/**
 * A/B Test Tracker - Background Service Worker
 */

const tabCache = {};

// Map of tabId → port for open DevTools panels
const devtoolsPorts = {};

// ── Badge ─────────────────────────────────────────────────────────────────────
function updateBadge(tabId, payload) {
  const expCount = (payload && payload.experiments && payload.experiments.length) || 0;
  if (expCount > 0) {
    chrome.action.setBadgeText({ text: String(expCount), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// ── Push data to DevTools panel for a tab ─────────────────────────────────────
function pushToPanel(tabId, data) {
  const port = devtoolsPorts[tabId];
  if (!port) return;
  try {
    port.postMessage({ type: 'AB_DATA_PUSH', data });
  } catch (e) {
    delete devtoolsPorts[tabId];
  }
}

// ── Long-lived port from devtools.js ─────────────────────────────────────────
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'devtools-panel') return;

  let connectedTabId = null;

  port.onMessage.addListener(function (msg) {
    if (msg.type === 'DEVTOOLS_INIT') {
      connectedTabId = msg.tabId;
      devtoolsPorts[connectedTabId] = port;

      // Send cached data immediately
      const cached = tabCache[connectedTabId] || null;
      port.postMessage({ type: 'AB_DATA_PUSH', data: cached });

      // Ask content script to re-scan so fresh data arrives
      chrome.tabs.sendMessage(connectedTabId, { type: 'POPUP_WANTS_DATA' }, function () {
        if (chrome.runtime.lastError) {}
      });
    }

    // Panel asked for a manual refresh
    if (msg.type === 'DEVTOOLS_REFRESH') {
      const tabId = msg.tabId || connectedTabId;
      const cached = tabCache[tabId] || null;
      port.postMessage({ type: 'AB_DATA_PUSH', data: cached });
      chrome.tabs.sendMessage(tabId, { type: 'POPUP_WANTS_DATA' }, function () {
        if (chrome.runtime.lastError) {}
      });
    }
  });

  port.onDisconnect.addListener(function () {
    if (connectedTabId) delete devtoolsPorts[connectedTabId];
  });
});

// ── Messages from content script and popup ────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {

  // Content script pushes fresh data
  if (msg && msg.type === 'AB_DATA_FROM_CONTENT' && sender.tab) {
    const tabId = sender.tab.id;
    tabCache[tabId] = msg.payload;
    updateBadge(tabId, msg.payload);
    pushToPanel(tabId, msg.payload);   // forward to open DevTools panel
    sendResponse({ ok: true });
    return;
  }

  // Popup requests data for the active tab
  if (msg && msg.type === 'POPUP_GET_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) { sendResponse({ data: null }); return; }
      const tabId  = tabs[0].id;
      const cached = tabCache[tabId] || null;
      sendResponse({ data: cached, tabId });
    });
    return true; // keep channel open for async sendResponse
  }

  // DevTools direct request (fallback, e.g. refresh button)
  if (msg && msg.type === 'DEVTOOLS_GET_DATA') {
    const cached = tabCache[msg.tabId] || null;
    sendResponse({ data: cached });
    return true;
  }
});

// ── Tab navigation: clear cache and badge ─────────────────────────────────────
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status === 'loading') {
    delete tabCache[tabId];
    chrome.action.setBadgeText({ text: '', tabId });
    // Notify panel the page changed
    pushToPanel(tabId, null);
  }
});

// ── Tab closed ────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(function (tabId) {
  delete tabCache[tabId];
  delete devtoolsPorts[tabId];
});
