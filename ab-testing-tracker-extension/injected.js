/**
 * A/B Test Tracker - Page-World Injector
 *
 * This file runs in the PAGE's JavaScript context (world: MAIN), so it can
 * directly access window.convert, window._vwo_exp, window.optimizely, etc.
 *
 * It posts messages to the content script via window.postMessage using the
 * channel prefix "__abTracker__".
 */