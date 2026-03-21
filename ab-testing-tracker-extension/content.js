/**
 * A/B Test Tracker - Content Script (Isolated World bridge)
 *
 * Runs in Chrome's ISOLATED world (cannot touch window.convert etc).
 * Responsibilities:
 *   1. Inject injected.js into the PAGE world so it can read platform globals.
 *   2. Listen for postMessage data from injected.js and forward to background.
 *   3. Tell injected.js to re-scan when the popup asks.
 */

(function () {
  'use strict';

  if (window.__abTrackerContentBridgeInjected) return;
  window.__abTrackerContentBridgeInjected = true;

  // ── 1. Inject the page-world script ─────────────────────────────────────────
  // We use chrome.runtime.getURL so the file is loaded from the extension
  // bundle (listed in web_accessible_resources in manifest.json).
  function injectPageScript() {
    try {
      var s    = document.createElement('script');
      s.src    = chrome.runtime.getURL('injected.js');
      s.type   = 'text/javascript';
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[AB Tracker] Could not inject page script:', e);
    }
  }

  injectPageScript();

  // ── 2. Relay data from page world → background ───────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || !msg.__abTracker__ || msg.type !== 'AB_DATA') return;

    try {
      chrome.runtime.sendMessage({
        type   : 'AB_DATA_FROM_CONTENT',
        payload: msg.payload
      });
    } catch (e) {}
  });

  // ── 3. Listen for popup requesting a re-scan ──────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'POPUP_WANTS_DATA') {
      // Tell the page-world script to re-scan and post fresh data
      window.postMessage({ __abTracker__: true, type: 'RESCAN' }, '*');
    }
  });

}());
