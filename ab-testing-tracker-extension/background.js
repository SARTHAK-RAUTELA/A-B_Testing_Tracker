/**
 * A/B Test Tracker - Background Service Worker
 * Stores experiment/goal data per tab and serves it to the popup.
 */

/**
 * A/B Test Tracker - Background Service Worker
 * Stores experiment/goal data per tab and serves it to the popup.
 */

const tabCache = {};

// Content script pushes data here
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'AB_DATA_FROM_CONTENT' && sender.tab) {
    tabCache[sender.tab.id] = msg.payload;
    sendResponse({ ok: true });
    return;
  }

  // Popup requests current tab data
  if (msg && msg.type === 'POPUP_GET_DATA') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) {
        sendResponse({ data: null });
        return;
      }
      const tabId = tabs[0].id;
      const cached = tabCache[tabId] || null;
      sendResponse({ data: cached, tabId: tabId });
    });
    return true; // keep channel open for async sendResponse
  }
});

// Clean up when tab closes
chrome.tabs.onRemoved.addListener(function (tabId) {
  delete tabCache[tabId];
});
