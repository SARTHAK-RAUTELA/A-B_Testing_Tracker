/**
 * A/B Test Tracker - DevTools Script
 * Runs in the DevTools page context (devtools.html).
 * Opens a long-lived port to background, creates the panel,
 * and bridges messages to the panel window once it is shown.
 */

// 1. Open port to background
const port = chrome.runtime.connect({ name: 'devtools-panel' });

// Tell background which tab we are inspecting
port.postMessage({ type: 'DEVTOOLS_INIT', tabId: chrome.devtools.inspectedWindow.tabId });

// 2. Queue messages that arrive before the panel window is ready
let panelWindow = null;
const queue = [];

port.onMessage.addListener(function (msg) {
  if (panelWindow) {
    panelWindow.receiveData(msg);
  } else {
    queue.push(msg);
  }
});

// 3. Create the panel
chrome.devtools.panels.create(
  'A/B TRACKER',
  'icons/icon16.png',
  'panel.html',
  function (panel) {
    // 4. Capture panel window reference when the panel is shown
    panel.onShown.addListener(function (win) {
      panelWindow = win;
      // Drain the queue
      queue.forEach(function (msg) { panelWindow.receiveData(msg); });
      queue.length = 0;
    });

    panel.onHidden.addListener(function () {
      panelWindow = null;
    });
  }
);
