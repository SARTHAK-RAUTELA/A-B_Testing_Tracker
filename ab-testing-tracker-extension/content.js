/**
 * A/B Test Tracker - Content Script (Isolated World bridge)
 *
 * Runs in Chrome's ISOLATED world (cannot touch window.convert etc).
 * Responsibilities:
 *   1. Inject injected.js into the PAGE world so it can read platform globals.
 *   2. Listen for postMessage data from injected.js and forward to background.
 *   3. Tell injected.js to re-scan when the popup asks.
 */