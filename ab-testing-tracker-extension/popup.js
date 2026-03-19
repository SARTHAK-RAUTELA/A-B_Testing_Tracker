/**
 * A/B Test Tracker - Popup Script
 * 1. Asks background for cached data (POPUP_GET_DATA)
 * 2. Also tells content script to re-run (POPUP_WANTS_DATA)
 * 3. Renders experiments + goals
 */

'use strict';

var localGoals = [];
var currentTabId = null;

// ── Tabs ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('p-' + tab.dataset.t).classList.add('active');
    });
});

// ── refresh ──────────────────────────────────────────────────────
document.getElementById('btnRefresh').addEventListener('click', function () {
    var btn = this;
    btn.classList.add('spin');
    fetchData().finally(function () {
        setTimeout(function () { btn.classList.remove('spin'); }, 500);
    });
});

// ── clear goals ───────────────────────────────────────────────────
document.getElementById('btnClear').addEventListener('click'), function () {
    localGoals = [];
    renderGoals();
    setBadge('gc', 0);
}

// ── fetch data ───────────────────────────────────────────────────
function fetchData() {
    return new Promise(function(resolve){
        // step 1: get cached data from background
        chrome.runtime.sendMessage({ type: 'POPUP_GET_DATA' }, function (resp) {
            var data = resp && resp.data;
            currentTabId = (resp && resp.tabId) || null;
            if (data) {
                handleData(data);
            }

            // step2: also ask the content script to re-scan and push fresh data

            if (currentTabId) {
                chrome.tabs.sendMessage(currentTabId, { type: 'POPUP_WANTS_DATA' }, function () {
                    // ignore errors (content script may not be ready yet)
                    if (chrome.runtime.lastError) { }
                });
            }

// If no data at all, try injecting content script manually (first open)
if (!data && currentTabId) {
        chrome.scripting.executeScript(
          { target: { tabId: currentTabId }, files: ['content.js'] },
          function () {
            if (chrome.runtime.lastError) {}
            // Wait a moment then try again
            setTimeout(function () {
              chrome.runtime.sendMessage({ type: 'POPUP_GET_DATA' }, function (resp2) {
                if (resp2 && resp2.data) handleData(resp2.data);
                else showEmpty();
                resolve();
              });
            }, 1200);
          }
        );
      } else {
        if (!data) showEmpty();
        resolve();
      }

        })
    })
}

// ── Handle incoming data ─────────────────────────────────────────
function handleData(data) {
  if (!data) { showEmpty(); return; }

  // Merge goals without duplication
  if (Array.isArray(data.goals)) {
    var existing = new Set(localGoals.map(function (g) { return g.timestamp + g.goalId; }));
    data.goals.forEach(function (g) {
      var key = g.timestamp + g.goalId;
      if (!existing.has(key)) { localGoals.push(g); existing.add(key); }
    });
  }

  renderPlatforms(data.platforms || {});
  renderExperiments(data.experiments || []);
  renderGoals();
  renderFooter(data.url, data.ts);
}

//─ Listen for live pushes while popup is open ───────────────────
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'AB_DATA_FROM_CONTENT') {
    handleData(msg.payload);
  }
});

// ── Platform badges ──────────────────────────────────────────────
function renderPlatforms(plats) {
  set('pb-c', plats.convert    ? 'pb on-c' : 'pb off');
  set('pb-o', plats.optimizely ? 'pb on-o' : 'pb off');
  set('pb-v', plats.vwo        ? 'pb on-v' : 'pb off');

  function set(id, cls) {
    var el = document.getElementById(id);
    el.className = cls;
  }
}

// ── Experiments ──────────────────────────────────────────────────
function renderExperiments(exps) {
  document.getElementById('loadingEl').style.display = 'none';
  var list = document.getElementById('expList');
  setBadge('ec', exps.length);

  if (!exps.length) {
    showEmpty();
    return;
  }

  list.innerHTML = exps.map(function (exp) {
    var p = exp.platform.toLowerCase();
    var ptag  = 'ptag ptag-' + p[0];
    var vdot  = 'vdot vdot-' + p[0];
    return '<div class="ec">' +
      '<div class="ec-head">' +
        '<div class="ec-name">' + h(exp.name) + '</div>' +
        '<span class="' + ptag + '">' + h(exp.platform) + '</span>' +
      '</div>' +
      '<div class="vchip"><div class="' + vdot + '"></div>' + h(exp.variant) + '</div>' +
      '<div class="ec-meta">' +
        '<div class="mi"><span class="ml">EXP ID</span><span class="mv">' + h(exp.id) + '</span></div>' +
        (exp.variantId ? '<div class="mi"><span class="ml">VAR ID</span><span class="mv">' + h(exp.variantId) + '</span></div>' : '') +
        '<div class="mi"><span class="ml">STATUS</span><span class="mv" style="color:var(--goal)">● active</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}


// ── Goals ────────────────────────────────────────────────────────
function renderGoals() {
  var list  = document.getElementById('goalList');
  var empty = document.getElementById('goalEmpty');
  setBadge('gc', localGoals.length);

  if (!localGoals.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  var sorted = localGoals.slice().reverse();
  list.innerHTML = sorted.map(function (g) {
    var p = g.platform.toLowerCase();
    return '<div class="gc">' +
      '<div class="gi"></div>' +
      '<div class="gb">' +
        '<div class="gn">' + h(g.goalName || g.goalId) + '</div>' +
        '<div class="gm">' +
          '<span class="gplat gplat-' + p[0] + '">' + h(g.platform) + '</span>' +
          '<span class="gid">ID: ' + h(g.goalId) + '</span>' +
          '<span class="gt">' + fmtTime(g.timestamp) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Empty state ──────────────────────────────────────────────────
function showEmpty() {
  document.getElementById('loadingEl').style.display = 'none';
  document.getElementById('expList').innerHTML =
    '<div class="empty">' +
      '<div class="e-icon"><svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="16" stroke="#64748b" stroke-width="1.3"/><path d="M11 18h14M18 11v14" stroke="#64748b" stroke-width="1.3" stroke-linecap="round"/></svg></div>' +
      '<div class="e-title">No experiments detected</div>' +
      '<div class="e-sub">No Convert, Optimizely, or VWO experiments found on this page.</div>' +
    '</div>';
}

// ── Footer ───────────────────────────────────────────────────────
function renderFooter(url, ts) {
  if (url) {
    try {
      var u = new URL(url);
      document.getElementById('ftUrl').textContent = u.hostname + u.pathname.slice(0, 28);
    } catch (_) {
      document.getElementById('ftUrl').textContent = (url || '').slice(0, 40);
    }
  }
  if (ts) {
    document.getElementById('ftTs').textContent = fmtTime(new Date(ts).toISOString());
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function setBadge(id, n) {
  document.getElementById(id).textContent = n;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return '—'; }
}

function h(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────────
fetchData();
// Auto-poll while popup stays open
setInterval(fetchData, 4000);
