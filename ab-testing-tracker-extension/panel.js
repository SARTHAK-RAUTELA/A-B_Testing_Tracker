/**
 * A/B Test Tracker - Panel Script
 * Receives data via window.receiveData() called from devtools.js.
 * NO direct chrome.runtime messaging here — devtools.js owns the port.
 */
'use strict';

var localGoals = [];
var allExps    = [];
var filterText = '';
var tabId      = null;

// ── Called by devtools.js when data arrives from background ──────────────────
window.receiveData = function (msg) {
  if (!msg || msg.type !== 'AB_DATA_PUSH') return;
  var data = msg.data;
  if (data) handleData(data);
  else showEmpty();
};

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById('p-' + tab.dataset.t).classList.add('active');
  });
});

document.getElementById('filterInput').addEventListener('input', function () {
  filterText = this.value.toLowerCase();
  renderExperiments(allExps);
  renderGoals();
});

document.getElementById('btnRefresh').addEventListener('click', function () {
  var btn = this;
  btn.classList.add('spin');
  // Ask devtools.js to trigger a refresh via the port
  // We do this by sending a message to the background directly
  if (typeof chrome !== 'undefined' && chrome.devtools) {
    tabId = tabId || chrome.devtools.inspectedWindow.tabId;
    chrome.runtime.sendMessage({ type: 'DEVTOOLS_GET_DATA', tabId: tabId }, function (resp) {
      if (chrome.runtime.lastError) { btn.classList.remove('spin'); return; }
      if (resp && resp.data) handleData(resp.data);
      setTimeout(function () { btn.classList.remove('spin'); }, 600);
    });
    // Also ask content script to rescan
    chrome.tabs.sendMessage(tabId, { type: 'POPUP_WANTS_DATA' }, function () {
      if (chrome.runtime.lastError) {}
    });
  }
});

document.getElementById('btnClear').addEventListener('click', function () {
  localGoals = [];
  renderGoals();
});

// ── Handle data ───────────────────────────────────────────────────────────────
function handleData(data) {
  if (!data) { showEmpty(); return; }
  allExps = data.experiments || [];

  if (Array.isArray(data.goals)) {
    var existing = new Set(localGoals.map(function (g) {
      return g.platform + g.goalId + g.timestamp;
    }));
    data.goals.forEach(function (g) {
      var key = g.platform + g.goalId + g.timestamp;
      if (!existing.has(key)) { localGoals.push(g); existing.add(key); }
    });
  }

  renderPlatforms(data.platforms || {});
  renderExperiments(allExps);
  renderGoals();
  renderFooter(data.url, data.ts);
}

// ── Platform badges ───────────────────────────────────────────────────────────
function renderPlatforms(plats) {
  function sc(id, cls) { var el = document.getElementById(id); if (el) el.className = cls; }
  sc('pb-c', plats.convert    ? 'pb on-c' : 'pb off');
  sc('pb-o', plats.optimizely ? 'pb on-o' : 'pb off');
  sc('pb-v', plats.vwo        ? 'pb on-v' : 'pb off');
  // Show Optimizely Tracked/Evaluated legend only when Optimizely is detected
  var legend = document.getElementById('optlyLegend');
  if (legend) {
    if (plats.optimizely) {
      legend.classList.add('visible');
    } else {
      legend.classList.remove('visible');
    }
  }
}

// ── Experiments ───────────────────────────────────────────────────────────────
function renderExperiments(exps) {
  var loading = document.getElementById('loadingEl');
  if (loading) loading.style.display = 'none';
  var list = document.getElementById('expList');
  if (!list) return;

  var filtered = filterText
    ? exps.filter(function (e) {
        return (e.name + e.id + e.variant + e.platform).toLowerCase().includes(filterText);
      })
    : exps;

  var ecEl = document.getElementById('ec');
  if (ecEl) ecEl.textContent = exps.length;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty">' +
      '<div class="e-icon"><svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="16" stroke="#64748b" stroke-width="1.3"/><path d="M11 18h14M18 11v14" stroke="#64748b" stroke-width="1.3" stroke-linecap="round"/></svg></div>' +
      '<div class="e-title">' + (filterText ? 'No matches' : 'No experiments detected') + '</div>' +
      '<div class="e-sub">' + (filterText ? 'Try a different filter.' : 'No Convert, Optimizely, or VWO experiments found on this page.') + '</div>' +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map(function (exp) {
    var p = exp.platform.toLowerCase()[0];
    return '<div class="ec">' +
      '<div class="ec-head">' +
        '<div class="ec-name">' + h(exp.name) + '</div>' +
        '<span class="ptag ptag-' + p + '">' + h(exp.platform) + '</span>' +
      '</div>' +
      '<div class="vchip"><div class="vdot vdot-' + p + '"></div>' + h(exp.variant) + '</div>' +
      '<div class="ec-meta">' +
        '<div class="mi"><span class="ml">EXP ID</span><span class="mv">' + h(exp.id) + '</span></div>' +
        (exp.variantId ? '<div class="mi"><span class="ml">VAR ID</span><span class="mv">' + h(exp.variantId) + '</span></div>' : '') +
        '<div class="mi"><span class="ml">STATUS</span><span class="mv" style="color:var(--goal)">● active</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Goals ─────────────────────────────────────────────────────────────────────
function renderGoals() {
  var list  = document.getElementById('goalList');
  var empty = document.getElementById('goalEmpty');
  var gcEl  = document.getElementById('gc');
  if (gcEl) gcEl.textContent = localGoals.length;

  var filtered = filterText
    ? localGoals.filter(function (g) {
        return (g.goalName + g.goalId + g.platform).toLowerCase().includes(filterText);
      })
    : localGoals;

  if (!localGoals.length) {
    if (list)  list.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  if (list) {
    list.innerHTML = filtered.slice().reverse().map(function (g) {
      var p = g.platform.toLowerCase()[0];
      var statusBadge = '';
      if (g.platform === 'Optimizely') {
        if (g.trackingStatus === 'evaluated') {
          statusBadge = '<span class="gstatus gstatus-eval" title="Click detected, goal selector matched — but NOT sent to Optimizely (QA/force-variation mode)">Evaluated</span>';
        } else {
          statusBadge = '<span class="gstatus gstatus-tracked" title="Beacon sent to Optimizely servers — counts as a real conversion">Tracked</span>';
        }
      }
      // For VWO goals, show full selector as a tooltip on the goal name
      var goalTitle = '';
      if (g.platform === 'VWO' && g.vwoSelector) {
        goalTitle = ' title="Full selector: ' + h(g.vwoSelector) + '"';
      }
      return '<div class="gc-row">' +
        '<div class="gi"></div>' +
        '<div class="gb">' +
          '<div class="gn"' + goalTitle + '>' + h(g.goalName || g.goalId) + '</div>' +
          '<div class="gm">' +
            '<span class="gplat gplat-' + p + '">' + h(g.platform) + '</span>' +
            '<span class="gid">ID: ' + h(g.goalId) + '</span>' +
            statusBadge +
            '<span class="gt">' + fmtTime(g.timestamp) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
}

// ── Empty state ───────────────────────────────────────────────────────────────
function showEmpty() {
  var loading = document.getElementById('loadingEl');
  if (loading) loading.style.display = 'none';
  if (!allExps.length) {
    var list = document.getElementById('expList');
    if (list) list.innerHTML =
      '<div class="empty">' +
      '<div class="e-icon"><svg width="36" height="36" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="16" stroke="#64748b" stroke-width="1.3"/><path d="M11 18h14M18 11v14" stroke="#64748b" stroke-width="1.3" stroke-linecap="round"/></svg></div>' +
      '<div class="e-title">No experiments detected</div>' +
      '<div class="e-sub">No Convert, Optimizely, or VWO experiments found on this page.</div>' +
      '</div>';
  }
}

// ── Footer ────────────────────────────────────────────────────────────────────
function renderFooter(url, ts) {
  var urlEl = document.getElementById('ftUrl');
  var tsEl  = document.getElementById('ftTs');
  if (url && urlEl) {
    try {
      var u = new URL(url);
      urlEl.textContent = u.hostname + u.pathname.slice(0, 50);
    } catch (_) { urlEl.textContent = (url || '').slice(0, 60); }
  }
  if (ts && tsEl) tsEl.textContent = fmtTime(new Date(ts).toISOString());
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
  catch(_) { return '—'; }
}
function h(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
