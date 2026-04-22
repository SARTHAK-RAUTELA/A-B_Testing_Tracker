/**
 * A/B Test Tracker - Page-World Injector
 *
 * This file runs in the PAGE's JavaScript context (world: MAIN), so it can
 * directly access window.convert, window._vwo_exp, window.optimizely, etc.
 *
 * It posts messages to the content script via window.postMessage using the
 * channel prefix "__abTracker__".
 */

(function () {
  'use strict';

  if (window.__abTrackerPageInjected) return;
  window.__abTrackerPageInjected = true;

  var experiments = {};
  var goals       = [];
  var platforms   = {};

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function safeStr(v) {
    return (v !== null && v !== undefined) ? String(v) : '';
  }

  // ─── Convert goal name lookup ────────────────────────────────────────────────
  // Goal NAMES live in convert.data (static config), NOT in currentData.
  //   currentData.goals            = { id: 1 }   ← just a fired-flag, no name
  //   currentData.experiencesGoals = {}           ← empty in modern snippet
  //
  // Name sources in priority order:
  //   1. convert.data.goals  — modern: Array of {id, name, ...}
  //                          — legacy: Object keyed by id with .name / .goal_name / .n
  //   2. convert.data.experiences[*].goals[*] — some versions nest goal info per exp
  function getConvertGoalName(gId) {
    try {
      var sid  = String(gId);
      var data = window.convert && window.convert.data;
      var cd   = window.convert && window.convert.currentData;

      // 1. convert.data.goals — Array (modern) or Object (legacy)
      if (data) {
        var dg = data.goals;
        if (Array.isArray(dg)) {
          for (var i = 0; i < dg.length; i++) {
            if (String(dg[i].id) === sid) {
              var n1 = dg[i].name || dg[i].goal_name || dg[i].goalName || dg[i].n;
              if (n1) return String(n1);
            }
          }
        } else if (dg && dg[sid] && typeof dg[sid] === 'object') {
          var n2 = dg[sid].name || dg[sid].goal_name || dg[sid].goalName || dg[sid].n;
          if (n2) return String(n2);
        }
      }

      // 2. convert.currentData.experiencesGoals — keyed by experience ID,
      //    each value has a goals sub-object keyed by goal ID
      if (cd && cd.experiencesGoals) {
        var eg = cd.experiencesGoals;
        var egKeys = Object.keys(eg);
        for (var a = 0; a < egKeys.length; a++) {
          var expGoals = eg[egKeys[a]];
          if (!expGoals) continue;
          // expGoals may be { goalId: { name, ... } } or { goalId: 1 }
          if (expGoals[sid] && typeof expGoals[sid] === 'object') {
            var n3 = expGoals[sid].name || expGoals[sid].goal_name || expGoals[sid].goalName;
            if (n3) return String(n3);
          }
        }
      }

      // 3. Scan data.experiences / data.experiments for nested goals
      if (data) {
        var de = data.experiences || data.experiments;
        var expList = Array.isArray(de) ? de : Object.values(de || {});
        for (var j = 0; j < expList.length; j++) {
          var exp = expList[j];
          if (!exp || !exp.goals) continue;
          var gl = exp.goals;
          var goalEntry = Array.isArray(gl)
            ? gl.find(function (g) { return String(g.id) === sid; })
            : (gl[sid] || null);
          if (goalEntry && typeof goalEntry === 'object') {
            var n4 = goalEntry.name || goalEntry.goal_name || goalEntry.goalName || goalEntry.n;
            if (n4) return String(n4);
          }
        }
      }

      // 4. convert.currentData.goals — some versions store full objects here
      if (cd && cd.goals && cd.goals[sid] && typeof cd.goals[sid] === 'object') {
        var n5 = cd.goals[sid].name || cd.goals[sid].goal_name || cd.goals[sid].goalName;
        if (n5) return String(n5);
      }

    } catch (e) {}
    return null;
  }

  var _goalKeys = new Set();
  // trackingStatus: 'tracked'   = beacon actually sent to Optimizely/Convert/VWO servers
  //                 'evaluated' = goal selector matched / event evaluated, but NOT sent
  //                               (e.g. force-variation QA mode, or VWO goal detected
  //                               via cookie/hook before SDK decides to beacon)
  // For Convert and VWO all detections are 'tracked' — their hooks only fire when
  // the platform actually records the conversion. Only Optimizely has the
  // 'evaluated' distinction because it evaluates clicks even when not bucketed.
  function recordGoal(platform, goalId, goalName, trackingStatus, extra) {
    var gid      = safeStr(goalId);
    var status   = trackingStatus || 'tracked';
    // FIX 3: Tightened from 200ms to 50ms so rapid-fire goals on the same
    // platform within a 200ms window are no longer collapsed into one entry.
    var tsBucket = Math.floor(Date.now() / 50);
    var key      = platform + '|' + gid + '|' + tsBucket;
    if (_goalKeys.has(key)) return;
    _goalKeys.add(key);

    var entry = {
      platform      : platform,
      goalId        : gid,
      goalName      : goalName || gid,
      trackingStatus: status,
      timestamp     : new Date().toISOString(),
      url           : location.href
    };
    // Merge any extra fields (e.g. vwoSelector for VWO goals)
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) { entry[k] = extra[k]; });
    }
    goals.push(entry);
    if (goals.length > 100) goals.shift();
    postToContent();
  }

  // ─── Post data to content script ────────────────────────────────────────────

  function postToContent() {
    var payload = {
      experiments: Object.values(experiments),
      goals      : goals.slice(),
      platforms  : platforms,
      url        : location.href,
      ts         : Date.now()
    };

    // Write to window.__abTrackerData so DevTools panel can read via eval()
    window.__abTrackerData = payload;

    // Also post to content script bridge via postMessage
    window.postMessage({
      __abTracker__: true,
      type         : 'AB_DATA',
      payload      : payload
    }, '*');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // NETWORK INTERCEPT
  // ════════════════════════════════════════════════════════════════════════════

  function interceptNetwork() {
    if (!XMLHttpRequest.prototype.__abTrackerHooked) {
      XMLHttpRequest.prototype.__abTrackerHooked = true;
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__abUrl = String(url || '');
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        sniffRequest(this.__abUrl || '', body);
        return origSend.apply(this, arguments);
      };
    }

    if (!window.__abFetchHooked) {
      window.__abFetchHooked = true;
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var url = (typeof input === 'string' ? input : (input && input.url)) || '';
        sniffRequest(url, init && init.body);
        return origFetch.apply(this, arguments);
      };
    }

    if (!navigator.__abBeaconHooked && typeof navigator.sendBeacon === 'function') {
      navigator.__abBeaconHooked = true;
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        sniffRequest(String(url || ''), data);
        return origBeacon(url, data);
      };
    }
  }

  function sniffRequest(url, body) {
    try {
      // ── Convert goal beacons ──────────────────────────────────────────────────
      // Modern format: metrics.convertexperiments.com/track?...ev[N][evt]=hitGoal&ev[N][goals][]=12345
      // Legacy format: ...goal_id=12345 or goal-id=12345
      if (/convert\.com|convertexperiments\.com/.test(url)) {
        var goalIds = [];

        // Modern: ev[N][goals][]=ID  (may appear multiple times)
        var reGoals = /ev\[\d+\]\[goals\]\[\]=(\d+)/g;
        var mg;
        while ((mg = reGoals.exec(url)) !== null) {
          goalIds.push(mg[1]);
        }

        // Legacy: goal_id=ID or goal-id=ID
        if (!goalIds.length) {
          var ml = url.match(/goal[_-]?id[=\/](\w+)/i);
          if (ml) goalIds.push(ml[1]);
        }

        // Also check if it's a hitGoal event even without extractable ID
        if (!goalIds.length && /hitGoal|goal|conversion/i.test(url)) {
          goalIds.push('unknown');
        }

        goalIds.forEach(function (gId) {
          var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
          recordGoal('Convert', gId, gName);
        });
      }
      // Optimizely event beacons
      if (/logx\.optimizely\.com|optimizely\.com\/events/.test(url)) {
        // FIX 2: Body decoding and JSON.parse are each in their own try/catch.
        // A malformed payload no longer aborts the rest of sniffRequest (e.g.
        // the VWO check below), and a decode error doesn't kill the parse step.
        var bodyStr = null;
        try {
          if (typeof body === 'string') {
            bodyStr = body;
          } else if (body && typeof body === 'object' && body.constructor && body.constructor.name === 'URLSearchParams') {
            bodyStr = decodeURIComponent(body.toString());
          } else if (body instanceof ArrayBuffer) {
            bodyStr = new TextDecoder().decode(body);
          } else if (ArrayBuffer.isView(body)) {
            bodyStr = new TextDecoder().decode(body.buffer);
          }
        } catch (_) {}

        try {
          var parsed = bodyStr ? JSON.parse(bodyStr) : null;
          if (parsed && parsed.visitors) {
            parsed.visitors.forEach(function (vis) {
              (vis.snapshots || []).forEach(function (snap) {
                (snap.events || []).forEach(function (ev) {
                  // ev.entity_id = numeric goal ID (e.g. "5047863646879744")
                  // ev.key       = api_name (e.g. "swo__addtocart_any_product")
                  var evKey    = ev.key || '';
                  var entityId = ev.entity_id || evKey;
                  if (!evKey || evKey === 'campaign_activated') return;
                  var evName = getOptimizelyEventName(evKey) || evKey;
                  recordGoal('Optimizely', safeStr(entityId), evName, 'tracked');
                });
              });
            });
          }
        } catch (_) {}
      }
      // VWO goal beacons
      // FIX 1: Extended to parse the POST body (modern VWO SDKs send goal data
      // in the body as JSON, not only in the URL). Also improved URL-based
      // extraction with a more specific regex.
      if (/visualwebsiteoptimizer\.com|vwo\.com/.test(url)) {
        var vwoGoalFound = false;

        // Try URL-based extraction first (legacy beacons)
        if (/goal|conv/i.test(url)) {
          var mvUrl = url.match(/(?:goal_id|goalId|goal)[=\/](\w+)/i);
          if (mvUrl) {
            var gNameUrl = getVWOGoalName('', mvUrl[1]) || ('VWO Goal ' + mvUrl[1]);
            recordGoal('VWO', mvUrl[1], gNameUrl, 'tracked');
            vwoGoalFound = true;
          }
        }

        // Try body-based extraction (modern VWO SDK sends JSON body)
        if (!vwoGoalFound && body) {
          var vwoBodyStr = null;
          try {
            if (typeof body === 'string') {
              vwoBodyStr = body;
            } else if (body instanceof ArrayBuffer) {
              vwoBodyStr = new TextDecoder().decode(body);
            } else if (ArrayBuffer.isView(body)) {
              vwoBodyStr = new TextDecoder().decode(body.buffer);
            }
          } catch (_) {}

          if (vwoBodyStr) {
            try {
              var vwoParsed = JSON.parse(vwoBodyStr);
              // Modern VWO event payload: { d: { event: { props: { vwo_event_type, id } } } }
              var evType = vwoParsed && vwoParsed.d && vwoParsed.d.event &&
                           vwoParsed.d.event.props && vwoParsed.d.event.props.vwo_event_type;
              var evId   = vwoParsed && vwoParsed.d && vwoParsed.d.event &&
                           vwoParsed.d.event.props && vwoParsed.d.event.props.id;
              if (evType === 'goal' && evId) {
                var gNameBody = getVWOGoalName('', safeStr(evId)) || ('VWO Goal ' + evId);
                recordGoal('VWO', safeStr(evId), gNameBody, 'tracked');
              }
            } catch (_) {
              // Not JSON — try a plain goal ID pattern in the raw string
              var mvBody = vwoBodyStr.match(/["']?(?:goal_id|goalId|goal)["']?\s*[:=]\s*["']?(\w+)["']?/i);
              if (mvBody) {
                var gNameRaw = getVWOGoalName('', mvBody[1]) || ('VWO Goal ' + mvBody[1]);
                recordGoal('VWO', mvBody[1], gNameRaw, 'tracked');
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CONVERT
  // ════════════════════════════════════════════════════════════════════════════

  function installConvertListeners() {
    // ── Hook console output to catch Convert's internal goal log messages ────────
    // Convert logs: "Marking goal 100037426 triggered for experience 100051424"
    // This is the same approach Convert Experience Tools extension uses.
    try {
      function hookConvertLog(fnName) {
        if (console[fnName] && !console[fnName].__abConvertHooked) {
          console[fnName].__abConvertHooked = true;
          var orig = console[fnName].bind(console);
          console[fnName] = function () {
            try {
              for (var i = 0; i < arguments.length; i++) {
                var arg = String(arguments[i]);
                // "Marking goal 100037426 triggered for experience 100051424"
                var m = arg.match(/[Mm]arking goal\s+(\d+)\s+triggered(?:\s+for experience\s+(\d+))?/);
                if (m) {
                  var gId   = m[1];
                  var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
                  recordGoal('Convert', gId, gName);
                }
              }
            } catch (e) {}
            return orig.apply(console, arguments);
          };
        }
      }
      hookConvertLog('log');
      hookConvertLog('info');
      hookConvertLog('debug');
    } catch (e) {}

    // Lifecycle listener: catches ALL goal types (click, visit, form, JS)
    // Per Convert docs, event object is:
    // { event: "goal.triggered", data: { goal_id, experience_id, variation_id,
    //                                    experience_name, variation_name } }
    // goal NAME is NOT included — must be looked up from config.
    // When Data Anonymization is ON, names are replaced with IDs.
    try {
      window._conv_q = window._conv_q || [];
      if (!window._conv_q.__abGoalListenerAdded) {
        window._conv_q.__abGoalListenerAdded = true;
        window._conv_q.push({
          what  : 'addListener',
          params: {
            event  : 'goal.triggered',
            handler: function (event) {
              try {
                // event.data is the primary structure per Convert docs
                var d   = event.data || event;
                var gId = d.goal_id || d['goal-id'] || d.goalId || event['goal-id'] || event.goal_id || 'unknown';

                // Try to get goal name from config first
                var gName = getConvertGoalName(gId);

                // If no name (anonymization on or goal not in config),
                // build a descriptive label from what we DO have
                if (!gName) {
                  var expName = d.experience_name || d.experienceName || '';
                  var varName = d.variation_name  || d.variationName  || '';
                  if (expName) {
                    // "Goal 100037426 (in: My Test Name)"
                    gName = 'Goal ' + gId + ' \u2014 ' + expName;
                  } else {
                    gName = 'Convert Goal ' + gId;
                  }
                }

                recordGoal('Convert', gId, gName);
              } catch (e) {}
            }
          }
        });
      }
    } catch (e) {}

    // Hook _conv_q.push for manual triggerConversion calls
    // FIX 12: Convert sometimes reassigns window._conv_q to a new array after
    // SDK init, silently losing the hook on the old reference. We now intercept
    // window._conv_q via defineProperty so any reassignment is caught and
    // re-hooked automatically.
    // NOTE: var expression (not function declaration) — function declarations
    // inside try blocks are a syntax error in strict mode.
    var hookConvQ = function (q) {
      if (!q || q.__abPushHooked) return;
      q.__abPushHooked = true;
      var origPush = Array.prototype.push.bind(q);
      q.push = function (cmd) {
        try {
          if (Array.isArray(cmd) && cmd[0] === 'triggerConversion') {
            var gId   = cmd[1];
            var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
            recordGoal('Convert', gId, gName);
          }
        } catch (e) {}
        return origPush(cmd);
      };
    };

    try {
      hookConvQ(window._conv_q);

      // Watch for reassignment of window._conv_q
      if (!window.__abConvQWatched) {
        window.__abConvQWatched = true;
        var _convQVal = window._conv_q;
        try {
          Object.defineProperty(window, '_conv_q', {
            configurable: true,
            enumerable  : true,
            get: function () { return _convQVal; },
            set: function (val) {
              _convQVal = val;
              hookConvQ(val);
            }
          });
        } catch (e) {
          // defineProperty not available — nothing more we can do
        }
      }
    } catch (e) {}
  }

  // ─── Convert experiment name lookup ─────────────────────────────────────────
  // currentData.experiences has NO name field — names live in convert.data:
  //   Modern: convert.data.experiences = Array of { id, name, ... }
  //   Legacy: convert.data.experiments = Object keyed by id, value has .n or .name
  function getConvertExpName(expId) {
    try {
      var data = window.convert && window.convert.data;
      if (!data) return null;
      var sid = String(expId);

      // Modern snippet: data.experiences is an Array
      var de = data.experiences;
      if (Array.isArray(de)) {
        for (var i = 0; i < de.length; i++) {
          if (String(de[i].id) === sid) {
            return de[i].name || de[i].test_name || null;
          }
        }
      }
      // Also try as object (some versions)
      if (de && !Array.isArray(de) && de[sid]) {
        return de[sid].name || de[sid].test_name || de[sid].n || null;
      }

      // Legacy snippet: data.experiments keyed by id, name stored as .n or .name
      var dex = data.experiments;
      if (dex && dex[sid]) {
        return dex[sid].name || dex[sid].test_name || dex[sid].n || null;
      }
    } catch (e) {}
    return null;
  }

  function detectConvert() {
    var found = false;

    // Method 1 — window.convert.currentData.experiences (modern snippet)
    try {
      var cd   = window.convert && window.convert.currentData;
      var exps = cd && cd.experiences;
      if (exps && typeof exps === 'object') {
        Object.keys(exps).forEach(function (expId) {
          var exp  = exps[expId];
          if (!exp) return;
          var vObj = (exp.variation && typeof exp.variation === 'object') ? exp.variation : {};

          var varName = vObj.name
            || (vObj.id  ? ('Variation ' + vObj.id)  : null)
            || (vObj.key ? ('Variation ' + vObj.key) : null)
            || 'Control / Original';

          experiments['c_' + expId] = {
            platform : 'Convert',
            id       : expId,
            name     : getConvertExpName(expId) || exp.name || exp.experiment_name || ('Convert Exp ' + expId),
            variant  : varName,
            variantId: safeStr(vObj.id || vObj.key || ''),
            firstTime: !!exp.firstTime,
            status   : 'active'
          };
          found = true;
        });
      }
    } catch (e) {}

    // Method 2 — window._conv_r (legacy)
    try {
      var r = window._conv_r;
      if (r && typeof r === 'object') {
        Object.keys(r).forEach(function (expId) {
          if (experiments['c_' + expId]) return;
          var exp     = r[expId];
          var varName = exp && (exp.variation_name || exp.variationName);
          if (!varName) return;
          experiments['c_' + expId] = {
            platform : 'Convert',
            id       : expId,
            name     : exp.exp_name || exp.name || ('Convert Exp ' + expId),
            variant  : varName,
            variantId: safeStr(exp.variation_id || exp.variationId || ''),
            status   : 'active'
          };
          found = true;
        });
      }
    } catch (e) {}

    // Method 3 — _conv_v cookie
    try {
      document.cookie.split(';').forEach(function (c) {
        var eq = c.indexOf('=');
        if (eq === -1) return;
        var cName = c.substring(0, eq).trim();
        var cVal  = c.substring(eq + 1).trim();
        if (!cName.startsWith('_conv_v')) return;
        var decoded = decodeURIComponent(cVal);
        var re = /v\.(\d+)\.(\d+)/g, m;
        while ((m = re.exec(decoded)) !== null) {
          var expId = m[1], varId = m[2];
          if (experiments['c_' + expId]) return;
          experiments['c_' + expId] = {
            platform : 'Convert',
            id       : expId,
            name     : getConvertExpName(expId) || ('Convert Exp ' + expId),
            variant  : varId === '0' ? 'Control' : ('Variation ' + varId),
            variantId: varId,
            status   : 'active'
          };
          found = true;
        }
      });
    } catch (e) {}

    // Method 4 — window.convert.data.experiments (older snippet)
    try {
      var d = window.convert && window.convert.data;
      if (d && d.experiments && typeof d.experiments === 'object') {
        Object.keys(d.experiments).forEach(function (expId) {
          if (experiments['c_' + expId]) return;
          var exp = d.experiments[expId];
          if (!exp) return;
          experiments['c_' + expId] = {
            platform : 'Convert',
            id       : expId,
            name     : exp.name || ('Convert Exp ' + expId),
            variant  : exp.variation_name || exp.variationName || 'Unknown',
            variantId: safeStr(exp.variation_id || exp.variationId || ''),
            status   : 'active'
          };
          found = true;
        });
      }
    } catch (e) {}

    if (found) platforms.convert = true;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // OPTIMIZELY
  // ════════════════════════════════════════════════════════════════════════════

  // ─── Optimizely event name lookup ───────────────────────────────────────────
  // The SDK stores event metadata in optimizely.get('data').events
  // Each event: { id, key, name (display name), ...}
  // The beacon sends ev.key (api_name) — we can look up the display name from here
  function getOptimizelyEventName(eventKey) {
    try {
      var optly = window.optimizely;
      if (!optly || typeof optly.get !== 'function') return null;
      var data = optly.get('data');
      if (!data) return null;

      // data.events is an object keyed by event ID
      var events = data.events;
      if (events && typeof events === 'object') {
        var eIds = Object.keys(events);
        for (var i = 0; i < eIds.length; i++) {
          var ev = events[eIds[i]];
          // match by key (api_name) or by id
          if (ev && (ev.key === eventKey || String(ev.id) === String(eventKey))) {
            return ev.name || ev.key || null;
          }
        }
      }

      // Also try as array
      if (Array.isArray(events)) {
        for (var j = 0; j < events.length; j++) {
          var ev2 = events[j];
          if (ev2 && (ev2.key === eventKey || String(ev2.id) === String(eventKey))) {
            return ev2.name || ev2.key || null;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // Returns the numeric entity_id for an event key
  function getOptimizelyEventId(eventKey) {
    try {
      var optly = window.optimizely;
      if (!optly || typeof optly.get !== 'function') return null;
      var data = optly.get('data');
      if (!data) return null;
      var events = data.events;
      if (events && typeof events === 'object') {
        var eIds = Object.keys(events);
        for (var i = 0; i < eIds.length; i++) {
          var ev = events[eIds[i]];
          if (ev && ev.key === eventKey) return String(ev.id || eIds[i]);
        }
      }
      if (Array.isArray(events)) {
        for (var j = 0; j < events.length; j++) {
          if (events[j] && events[j].key === eventKey) return String(events[j].id);
        }
      }
    } catch (e) {}
    return null;
  }

  // ─── Recover goals that already fired before injected.js loaded ─────────────
  // Optimizely keeps a log of every dispatched event in:
  //   optimizely.get('state').getDecisionObject()  — not useful
  //   optimizely.get('log')                        — SDK internal log (string array)
  //   optimizely.get('data').events                — event metadata only
  //
  // The most reliable replay source is the network beacon itself.
  // But the SDK also stores activated campaign/variation states we can diff:
  // Any campaign that is "isActive" but we haven't recorded a goal for yet
  // means it fired a view_activated / page-view goal silently.
  //
  // Additionally, Optimizely 2.x+ stores a pending event queue on
  // window.optimizely.push — if it's an Array before SDK init, those are
  // commands queued by the page before SDK loaded. We don't need those.
  //
  // What we CAN do: after SDK is available, scan
  //   optimizely.get('state').getCampaignStates()
  // and for each active campaign that has a "view" event in data.events,
  // treat it as having fired a visit/page-view goal.
  function recoverOptimizelyEarlyGoals(optly) {
    try {
      if (!optly || typeof optly.get !== 'function') return;
      var state = optly.get('state');
      var data  = optly.get('data');
      if (!state || !data) return;

      // Build a map of event key → event metadata
      var eventMeta = {};
      var rawEvents = data.events;
      var evArr = Array.isArray(rawEvents)
        ? rawEvents
        : Object.values(rawEvents || {});
      evArr.forEach(function (ev) {
        if (ev && ev.key) eventMeta[ev.key] = ev;
      });

      // For each active campaign, find its associated conversion events
      var campaigns = (typeof state.getCampaignStates === 'function')
        ? state.getCampaignStates({ isActive: true })
        : {};

      Object.keys(campaigns || {}).forEach(function (campId) {
        var cs = campaigns[campId];
        var pageId = cs.pageId || (cs.page && cs.page.id);
        if (!pageId) return;

        Object.keys(eventMeta).forEach(function (evKey) {
          var ev = eventMeta[evKey];
          // Skip bucketing events — not a conversion goal
          if (evKey === 'campaign_activated') return;
          // Only recover events tied to this campaign's page
          if (String(ev.pageId || '') !== String(pageId) &&
              String(ev.page_id || '') !== String(pageId)) return;

          // FIX 7: Skip pure view/page-activation events — these are targeting
          // signals, not conversion goals. Only recover events whose category
          // is explicitly "Conversion" or that carry a custom event type.
          // Optimizely event categories: "View Activation", "Click", "Custom",
          // "Engagement", "Revenue" etc. We skip "View Activation" events here
          // because they fire on every page load for targeting purposes.
          var evCategory = ev.category || ev.type || '';
          if (/view.activation|pageview|page_view/i.test(evCategory)) return;

          var evName   = getOptimizelyEventName(evKey) || ev.name || evKey;
          var entityId = safeStr(ev.id || evKey);
          var tsBucket = Math.floor(Date.now() / 50);
          var key = 'Optimizely|' + entityId + '|' + tsBucket;
          if (!_goalKeys.has(key)) {
            recordGoal('Optimizely', entityId, evName, 'evaluated');
          }
        });
      });
    } catch (e) {}
  }

  // ─── window.optimizely getter trap ───────────────────────────────────────────
  // If Optimizely hasn't loaded yet when injected.js runs, we set a
  // defineProperty trap on window.optimizely. The instant the SDK sets itself
  // on window, our setter fires — we immediately hook it before any page code
  // can trigger a goal event through it.
  function trapOptimizelyInit() {
    // If already loaded, nothing to trap
    if (window.optimizely && typeof window.optimizely.push === 'function') return;

    var _optlyValue = window.optimizely; // may be [] (pre-init queue)
    try {
      Object.defineProperty(window, 'optimizely', {
        configurable: true,
        enumerable  : true,
        get: function () { return _optlyValue; },
        set: function (val) {
          _optlyValue = val;
          // Only act when the real SDK object is assigned (has .push + .get)
          if (val && typeof val.push === 'function' && typeof val.get === 'function') {
            // Remove the trap — restore normal property
            try {
              Object.defineProperty(window, 'optimizely', {
                configurable: true, enumerable: true, writable: true, value: val
              });
            } catch (e) {}
            // Hook immediately so we catch goals that fire right after SDK init
            installOptimizelyListeners();
            detectOptimizely();
            // Small delay to let SDK finish its own init cycle, then recover
            // any view/page goals it silently fired during startup
            setTimeout(function () {
              recoverOptimizelyEarlyGoals(window.optimizely);
              postToContent();
            }, 50);
          }
        }
      });
    } catch (e) {
      // defineProperty failed (e.g. already non-configurable) — no-op, normal
      // path will handle it
    }
  }

  // ─── Extract goal name/id from an Optimizely event object ────────────────────
  // Works for both the beacon format and the internal decision log format.
  // The console log format (from optimizely_log=info) is:
  //   { id, viewId, name, category, apiName, ... }
  // The analytics trackEvent format is:
  //   { eventName/eventKey, name, entityId, ... }
  function extractOptimizelyGoal(evData) {
    if (!evData) return null;
    // Internal decision log format: apiName is the key, name is display name
    var evKey    = evData.apiName || evData.eventName || evData.eventKey || evData.key || '';
    var evName   = evData.name    || evData.eventName || evData.apiName  || evKey;
    var entityId = evData.id      || evData.entityId  || evData.entity_id || evKey;
    if (!evKey || evKey === 'campaign_activated' || evKey === 'view_activated') return null;
    var resolved = getOptimizelyEventName(evKey) || evName || evKey;
    return { key: evKey, name: resolved, id: safeStr(entityId) };
  }

  function installOptimizelyListeners() {
    try {
      var optly = window.optimizely;
      if (!optly || typeof optly.push !== 'function') return;

      // ── 1. campaignDecided — experiment bucketing ──────────────────────────────
      if (!optly.__abCampaignListenerAdded) {
        optly.__abCampaignListenerAdded = true;
        optly.push({
          type  : 'addListener',
          filter: { type: 'lifecycle', name: 'campaignDecided' },
          handler: function (event) {
            try {
              var data   = event.data || {};
              var expObj = data.experiment || {};
              var varObj = data.variation  || {};
              var camp   = data.campaign   || {};
              if (!expObj.id) return;
              experiments['o_' + expObj.id] = {
                platform : 'Optimizely',
                id       : safeStr(expObj.id),
                name     : expObj.name || camp.name || ('Optimizely Exp ' + expObj.id),
                variant  : varObj.name || safeStr(varObj.id) || 'Unknown',
                variantId: safeStr(varObj.id || ''),
                status   : 'active'
              };
              platforms.optimizely = true;
              postToContent();
            } catch (e) {}
          }
        });
      }

      // ── 2. analytics trackEvent — fires when Optimizely DOES send a beacon ────
      if (!optly.__abTrackListenerAdded) {
        optly.__abTrackListenerAdded = true;
        optly.push({
          type  : 'addListener',
          filter: { type: 'analytics', name: 'trackEvent' },
          handler: function (event) {
            try {
              var g = extractOptimizelyGoal(event.data || {});
              if (g) recordGoal('Optimizely', g.id, g.name, 'tracked');
            } catch (e) {}
          }
        });
      }

      // ── 2b. decision lifecycle — fires for ALL evaluated click/custom events ────
      // This is the KEY listener for catching "Not tracking click event" goals.
      // When a visitor is in preview mode or the experiment is in QA, Optimizely
      // evaluates the click (logs "Not tracking click event" to console) but does
      // NOT send a network beacon — so the analytics trackEvent listener above
      // never fires. The 'decision' lifecycle fires for EVERY evaluated event
      // regardless of whether it was actually tracked or not.
      // This is what makes the extension show goals even in preview/QA mode,
      // matching what &optimizely_log=info shows in the console.
      if (!optly.__abDecisionListenerAdded) {
        optly.__abDecisionListenerAdded = true;
        optly.push({
          type  : 'addListener',
          filter: { type: 'lifecycle', name: 'decision' },
          handler: function (event) {
            try {
              var d = event.data || {};
              // decision event structure:
              // { decisionType, experimentId, variationId, enabled,
              //   ruleKey, flagKey, ... }
              // We only care about click/custom event decisions, not
              // experiment activation decisions (those are campaignDecided)
              if (d.decisionType === 'flag' || d.decisionType === 'experiment') return;

              var evKey  = d.eventKey || d.apiName || d.ruleKey || '';
              var evName = d.eventName || d.name || evKey;
              if (!evKey || evKey === 'campaign_activated' || evKey === 'view_activated') return;
              var resolved  = getOptimizelyEventName(evKey) || evName || evKey;
              var entityId  = safeStr(d.id || d.entityId || evKey);
              recordGoal('Optimizely', entityId, resolved, 'evaluated');
            } catch (e) {}
          }
        });
      }

      // ── 3. page lifecycle — fires for every page/view activation ───────────────
      if (!optly.__abPageListenerAdded) {
        optly.__abPageListenerAdded = true;
        optly.push({
          type  : 'addListener',
          filter: { type: 'lifecycle', name: 'pageActivated' },
          handler: function (event) {
            try {
              var page = (event.data || {}).page || {};
              var evKey  = page.apiName || page.key || '';
              var evName = page.name    || evKey;
              var evId   = safeStr(page.id || evKey);
              if (!evKey || evKey === 'campaign_activated') return;

              // FIX 6: pageActivated fires for EVERY page Optimizely evaluates,
              // including pure targeting pages that are not conversion goals.
              // Use a blocklist (not allowlist) so untagged pages — common in many
              // Optimizely setups — are still recorded rather than silently dropped.
              // Only skip if Optimizely explicitly marks the page as non-conversion.
              if (page.isConversionPage === false) return;

              var resolved = getOptimizelyEventName(evKey) || evName || evKey;
              recordGoal('Optimizely', evId, resolved, 'evaluated');
            } catch (e) {}
          }
        });
      }

      // ── 4. Hook optimizely.push — catches manual trackEvent calls ──────────────
      if (!optly.__abPushHooked) {
        optly.__abPushHooked = true;
        var origPush = optly.push.bind(optly);
        optly.push = function (payload) {
          try {
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
              if (payload.type === 'event') {
                var g = extractOptimizelyGoal(payload);
                if (g) recordGoal('Optimizely', g.id, g.name, 'tracked');
              }
            }
            if (Array.isArray(payload) && payload[0] === 'trackEvent') {
              var evKey2 = payload[1] || '';
              if (evKey2 && evKey2 !== 'campaign_activated') {
                var resolved2 = getOptimizelyEventName(evKey2) || evKey2;
                var entityId2 = getOptimizelyEventId(evKey2) || evKey2;
                recordGoal('Optimizely', safeStr(entityId2), resolved2, 'tracked');
              }
            }
          } catch (e) {}
          return origPush(payload);
        };
      }

      // ── 5. Hook the internal logger — catches ALL evaluated events ─────────────
      // This is EXACTLY the same data source as &optimizely_log=info.
      // Optimizely uses an internal logging module accessible via:
      //   optimizely.get('logger') or window.optimizelyLogger
      // It logs every click/engagement evaluation even "Not tracking" ones.
      // The log message format is: "Optly / Not tracking click event" with
      // the event object as the second argument.
      // We intercept this by hooking the logger's log() method.
      if (!optly.__abLoggerHooked) {
        optly.__abLoggerHooked = true;
        try {
          // Try to get internal logger module
          var logger = (typeof optly.get === 'function') && optly.get('logger');
          if (logger && typeof logger.log === 'function' && !logger.__abHooked) {
            logger.__abHooked = true;
            var origLog = logger.log.bind(logger);
            logger.log = function (level, msg, data) {
              try {
                // "Not tracking click event" and "Tracking click event" both
                // carry the event object as `data` — same format as console log
                if (data && typeof data === 'object' && data.apiName) {
                  var g = extractOptimizelyGoal(data);
                  if (g) recordGoal('Optimizely', g.id, g.name, 'tracked');
                }
                // Also handle array of events
                if (Array.isArray(data)) {
                  data.forEach(function (item) {
                    if (item && item.apiName) {
                      var g2 = extractOptimizelyGoal(item);
                      if (g2) recordGoal('Optimizely', g2.id, g2.name, 'tracked');
                    }
                  });
                }
              } catch (e) {}
              return origLog(level, msg, data);
            };
          }
        } catch (e) {}

        // Also try window.optimizelyLogger (some versions expose it globally)
        try {
          if (window.optimizelyLogger && typeof window.optimizelyLogger.log === 'function'
              && !window.optimizelyLogger.__abHooked) {
            window.optimizelyLogger.__abHooked = true;
            var origGLog = window.optimizelyLogger.log.bind(window.optimizelyLogger);
            window.optimizelyLogger.log = function (level, msg, data) {
              try {
                if (data && typeof data === 'object' && data.apiName) {
                  var g = extractOptimizelyGoal(data);
                  if (g) recordGoal('Optimizely', g.id, g.name, 'tracked');
                }
              } catch (e) {}
              return origGLog(level, msg, data);
            };
          }
        } catch (e) {}
      }

      // ── 7. Own click listener — catches goals even when Optimizely says "Not tracking" ──
      // When a visitor is in preview/QA mode or not bucketed into the live experiment,
      // Optimizely evaluates the click but sends NO beacon and fires NO SDK listener.
      // The only public signal is the console log — but ONLY when &optimizely_log=info
      // is active. Without it, there is complete silence.
      //
      // Solution: read Optimizely's own event config from optimizely.get('data').events
      // which contains every configured click goal's selector (eventFilter.selector).
      // We attach ONE document-level capture listener and match clicks against those
      // selectors ourselves. When a match is found, we record the goal directly.
      // This is clean — no console pollution, no URL param needed, works in all modes.
      if (!window.__abOptlyClickListenerAdded) {
        window.__abOptlyClickListenerAdded = true;
        document.addEventListener('click', function (e) {
          try {
            var optly2 = window.optimizely;
            if (!optly2 || typeof optly2.get !== 'function') return;
            var data2 = optly2.get('data');
            if (!data2) return;
            var evts = data2.events;
            if (!evts) return;

            var evArr2 = Array.isArray(evts) ? evts : Object.values(evts);
            evArr2.forEach(function (ev) {
              if (!ev) return;
              // Only process click-type events
              var evType = ev.eventType || ev.type || ev.category || '';
              if (!/click/i.test(evType) && ev.eventType !== 'click') {
                // Also check eventFilter if present
                var ef = ev.eventFilter || {};
                if (ef.filterType !== 'target_selector' && !/click/i.test(ef.filterType || '')) return;
              }

              // Get the selector Optimizely uses for this click goal
              var ef2     = ev.eventFilter || {};
              var selector = ef2.selector || ef2.target_selector || '';
              if (!selector) return;

              // Check if the clicked element (or any ancestor) matches the selector
              var target = e.target;
              var matched = false;
              try {
                matched = target.matches(selector) ||
                          !!(target.closest && target.closest(selector));
              } catch (_) { return; }

              if (!matched) return;

              // Record the goal — same name/id lookup as the SDK listener path
              var evKey3   = ev.key || ev.apiName || '';
              var evName3  = getOptimizelyEventName(evKey3) || ev.name || evKey3;
              var entityId3 = safeStr(ev.id || evKey3);
              if (!evKey3 || evKey3 === 'campaign_activated') return;
              recordGoal('Optimizely', entityId3, evName3, 'evaluated');
            });
          } catch (e2) {}
        }, true); // capture phase — same as Optimizely's own listener
      }

      // ── 6. Hook console.log to intercept "Optly / Not tracking click event" ────
      if (!console.__abOptlyConsoleHooked) {
        // FIX 8: Guard is now on the console object itself (not window.__abOptlyConsoleHooked).
        // If console is ever reassigned between the retry timeouts, window.__abOptlyConsoleHooked
        // would still be true and the new console object would never be hooked.
        // Per-object guard ensures we only hook each console instance once.
        console.__abOptlyConsoleHooked = true;
        var origConsoleLog = console.log.bind(console);
        console.log = function () {
          try {
            var msg = arguments[0];
            if (typeof msg === 'string' && /Optly\s*\//.test(msg)) {
              for (var i = 1; i < arguments.length; i++) {
                var arg = arguments[i];
                if (arg && typeof arg === 'object') {
                  var items = Array.isArray(arg) ? arg : [arg];
                  items.forEach(function (item) {
                    if (item && (item.apiName || item.name)) {
                      var g = extractOptimizelyGoal(item);
                      if (g) recordGoal('Optimizely', g.id, g.name, 'tracked');
                    }
                  });
                }
              }
            }
          } catch (e) {}
          return origConsoleLog.apply(console, arguments);
        };
      }

    } catch (e) {}
  }

  function detectOptimizely() {
    try {
      var optly = window.optimizely;
      if (!optly) return;
      platforms.optimizely = true;

      // Modern SDK
      if (typeof optly.get === 'function') {
        var st = optly.get('state');
        if (st) {
          // Primary: getCampaignStates
          if (typeof st.getCampaignStates === 'function') {
            var campaigns = st.getCampaignStates({ isActive: true });
            Object.keys(campaigns || {}).forEach(function (campId) {
              var cs    = campaigns[campId];
              var expObj = cs.experiment || {};
              var varObj = cs.variation  || {};
              if (!expObj.id) return;
              experiments['o_' + expObj.id] = {
                platform : 'Optimizely',
                id       : safeStr(expObj.id),
                name     : expObj.name || cs.campaignName || ('Optimizely Exp ' + expObj.id),
                variant  : varObj.name || safeStr(varObj.id) || 'Unknown',
                variantId: safeStr(varObj.id || ''),
                status   : cs.isActive ? 'active' : 'inactive'
              };
            });
          }

          // Fallback: getExperimentStates
          if (typeof st.getActiveExperimentIds === 'function' && typeof st.getExperimentStates === 'function') {
            var activeIds = st.getActiveExperimentIds();
            var allStates = st.getExperimentStates();
            activeIds.forEach(function (expId) {
              if (experiments['o_' + expId]) return;
              var es = allStates[expId];
              if (!es) return;
              var v = es.variation || {};
              experiments['o_' + expId] = {
                platform : 'Optimizely',
                id       : safeStr(expId),
                name     : es.experimentName || ('Optimizely Exp ' + expId),
                variant  : v.name || safeStr(v.id) || 'Unknown',
                variantId: safeStr(v.id || ''),
                status   : es.isActive ? 'active' : 'inactive'
              };
            });
          }
        }
      }

      // Classic SDK
      if (optly.data) {
        var exps2   = optly.data.experiments || {};
        var varMap  = (optly.data.state && optly.data.state.variationNamesMap) || {};
        var actives = (optly.data.state && optly.data.state.activeExperiments) || [];
        actives.forEach(function (expId) {
          if (experiments['o_' + expId]) return;
          var exp = exps2[expId] || {};
          experiments['o_' + expId] = {
            platform : 'Optimizely',
            id       : safeStr(expId),
            name     : exp.name || ('Optimizely Exp ' + expId),
            variant  : varMap[expId] || 'Unknown',
            variantId: '',
            status   : 'active'
          };
        });
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VWO
  // ════════════════════════════════════════════════════════════════════════════

  function installVWOListeners() {
    // onVariationApplied — timing-safe bucketing callback
    try {
      window.VWO = window.VWO || [];
      if (!window.VWO.__abVariationListenerAdded) {
        window.VWO.__abVariationListenerAdded = true;
        window.VWO.push(['onVariationApplied', function (data) {
          try {
            // FIX 11: Older VWO SDKs pass data as [campaignType, campaignKey, variationName]
            // (strings), while newer SDKs pass numeric IDs. Guard both cases.
            // data[0] = campaign type (e.g. "VISUAL_AB", "SURVEY")
            // data[1] = campaign ID (numeric string in new SDK, key string in old)
            // data[2] = combination/variation ID (numeric string) or variation name
            var rawExpId = safeStr(data[1]);
            var rawVarId = safeStr(data[2]);
            if (!rawExpId) return;

            var numericExpId = parseInt(rawExpId, 10);
            // If data[1] is not a pure integer, it's a campaign key (old SDK) —
            // look up the numeric ID from _vwo_exp by scanning for a matching key
            var expId = rawExpId;
            if (isNaN(numericExpId) && window._vwo_exp) {
              Object.keys(window._vwo_exp).forEach(function (k) {
                if (window._vwo_exp[k] && window._vwo_exp[k].k === rawExpId) {
                  expId = k;
                }
              });
            }

            var exp   = window._vwo_exp && window._vwo_exp[expId];
            var numericVarId = parseInt(rawVarId, 10);
            var vName;
            if (!isNaN(numericVarId)) {
              // Numeric varId path (new SDK)
              vName = (exp && exp.comb_n && exp.comb_n[rawVarId])
                || (rawVarId === '1' ? 'Control' : ('Variation ' + (numericVarId - 1)));
            } else {
              // String variation name path (old SDK) — use it directly
              vName = rawVarId || 'Unknown';
            }

            experiments['v_' + expId] = {
              platform : 'VWO',
              id       : expId,
              name     : (exp && exp.name) || ('VWO Exp ' + expId),
              variant  : vName,
              variantId: rawVarId,
              status   : 'active'
            };
            platforms.vwo = true;
            postToContent();
          } catch (e) {}
        }]);
      }
    } catch (e) {}

    // Hook classic goal functions
    try {
      if (typeof window._vis_opt_goal_conversion === 'function' && !window._vis_opt_goal_conversion.__abHooked) {
        var orig1 = window._vis_opt_goal_conversion;
        window._vis_opt_goal_conversion = function (goalId) {
          var gName = getVWOGoalName('', goalId) || ('VWO Goal ' + goalId);
          recordGoal('VWO', goalId, gName, 'tracked');
          return orig1.apply(this, arguments);
        };
        window._vis_opt_goal_conversion.__abHooked = true;
      }
    } catch (e) {}

    try {
      if (typeof window._vis_opt_register_conversion === 'function' && !window._vis_opt_register_conversion.__abHooked) {
        var orig2 = window._vis_opt_register_conversion;
        window._vis_opt_register_conversion = function (goalId, campaignId) {
          var gName = getVWOGoalName(campaignId || '', goalId) || ('VWO Goal ' + goalId);
          recordGoal('VWO', goalId, gName, 'tracked');
          return orig2.apply(this, arguments);
        };
        window._vis_opt_register_conversion.__abHooked = true;
      }
    } catch (e) {}

    // Hook VWO.event (SmartCode / new SDK)
    try {
      if (window.VWO && typeof window.VWO.event === 'function' && !window.VWO.event.__abHooked) {
        var origEvt = window.VWO.event.bind(window.VWO);
        window.VWO.event = function (goalId) {
          var gName = getVWOGoalName('', goalId) || ('VWO Goal ' + goalId);
          recordGoal('VWO', goalId, gName, 'tracked');
          return origEvt.apply(this, arguments);
        };
        window.VWO.event.__abHooked = true;
      }
    } catch (e) {}

    // Hook VWO queue push for ['track.goal', id]
    try {
      if (Array.isArray(window.VWO) && !window.VWO.__abQueueHooked) {
        window.VWO.__abQueueHooked = true;
        var origVwoPush = Array.prototype.push.bind(window.VWO);
        window.VWO.push = function (cmd) {
          if (Array.isArray(cmd) && cmd[0] === 'track.goal') {
            var gName = getVWOGoalName('', cmd[1]) || ('VWO Goal ' + cmd[1]);
            recordGoal('VWO', cmd[1], gName, 'tracked');
          }
          return origVwoPush(cmd);
        };
      }
    } catch (e) {}
  }

  function detectVWO() {
    var found = false;

    // Method 1 — window._vwo_exp
    try {
      if (window._vwo_exp && typeof window._vwo_exp === 'object') {
        Object.keys(window._vwo_exp).forEach(function (expId) {
          var exp = window._vwo_exp[expId];
          if (!exp || exp.status !== 'RUNNING') return;
          if (exp.combination_chosen === undefined || exp.combination_chosen === null) return;
          var cId   = safeStr(exp.combination_chosen);
          var cName = (exp.comb_n && exp.comb_n[exp.combination_chosen])
            || (exp.combination_chosen === 1 ? 'Control' : ('Variation ' + (exp.combination_chosen - 1)));
          experiments['v_' + expId] = {
            platform : 'VWO',
            id       : expId,
            name     : exp.name || ('VWO Exp ' + expId),
            variant  : cName,
            variantId: cId,
            status   : 'active'
          };
          found = true;
        });
      }
    } catch (e) {}

    // Method 2 — _vis_opt_exp_{id}_combi cookies
    try {
      document.cookie.split(';').forEach(function (c) {
        var eq = c.indexOf('=');
        if (eq === -1) return;
        var cName = c.substring(0, eq).trim();
        var cVal  = c.substring(eq + 1).trim();
        var m     = cName.match(/^_vis_opt_exp_(\d+)_combi$/);
        if (!m) return;
        var expId = m[1];
        if (experiments['v_' + expId]) return;
        var combi = parseInt(cVal, 10);
        var exp   = window._vwo_exp && window._vwo_exp[expId];
        var vName = (exp && exp.comb_n && exp.comb_n[combi])
          || (combi === 1 ? 'Control' : ('Variation ' + (combi - 1)));
        experiments['v_' + expId] = {
          platform : 'VWO',
          id       : expId,
          name     : (exp && exp.name) || ('VWO Exp ' + expId),
          variant  : vName,
          variantId: safeStr(combi),
          status   : 'active'
        };
        found = true;
      });
    } catch (e) {}

    if (found) {
      platforms.vwo = true;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LISTEN FOR CONTENT SCRIPT PINGS (asking us to re-scan)
  // ════════════════════════════════════════════════════════════════════════════

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.data && e.data.__abTracker__ && e.data.type === 'RESCAN') {
      runDetection();
      postToContent();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // RUN
  // ════════════════════════════════════════════════════════════════════════════

  function installAllListeners() {
    interceptNetwork();
    installConvertListeners();
    installOptimizelyListeners();
    installVWOListeners();
  }

  function runDetection() {
    detectConvert();
    detectOptimizely();
    detectVWO();
  }

  // Set the trap BEFORE installAllListeners so we catch SDK init if it hasn't
  // happened yet. trapOptimizelyInit() is a no-op if SDK is already present.
  trapOptimizelyInit();

  installAllListeners();
  runDetection();
  // Immediately try to recover any view/page goals that fired before us
  recoverOptimizelyEarlyGoals(window.optimizely);
  postToContent();

  setTimeout(function () { installAllListeners(); runDetection(); recoverOptimizelyEarlyGoals(window.optimizely); postToContent(); }, 800);
  setTimeout(function () { installAllListeners(); runDetection(); recoverOptimizelyEarlyGoals(window.optimizely); postToContent(); }, 2500);
  setTimeout(function () { installAllListeners(); runDetection(); recoverOptimizelyEarlyGoals(window.optimizely); postToContent(); }, 6000);

  // ── VWO goal cookie poller ───────────────────────────────────────────────────
  // ─── VWO goal name builder ────────────────────────────────────────────────────
  // VWO stores NO goal names — only identifier (event type) and url (selector).
  // We build a readable name: e.g. "Click: renew", "Page View", "Bounce".
  function getVWOGoalName(expId, goalId) {
    var sid     = String(goalId);
    var goalObj = null;

    try {
      // 1. Specific campaign in _vwo_exp
      var exp = window._vwo_exp && window._vwo_exp[expId];
      if (exp && exp.goals && exp.goals[sid]) goalObj = exp.goals[sid];

      // 2. Scan all campaigns in _vwo_exp
      if (!goalObj) {
        var allExp = window._vwo_exp;
        if (allExp && typeof allExp === 'object') {
          var eKeys = Object.keys(allExp);
          for (var i = 0; i < eKeys.length; i++) {
            var e = allExp[eKeys[i]];
            if (e && e.goals && e.goals[sid]) { goalObj = e.goals[sid]; break; }
          }
        }
      }

      // 3. VWO._.allSettings.dataStore.campaigns
      if (!goalObj) {
        var camps = window.VWO && window.VWO._ && window.VWO._.allSettings &&
                    window.VWO._.allSettings.dataStore &&
                    window.VWO._.allSettings.dataStore.campaigns;
        if (camps) {
          var cKeys = Object.keys(camps);
          for (var j = 0; j < cKeys.length; j++) {
            var c = camps[cKeys[j]];
            if (c && c.goals && c.goals[sid]) { goalObj = c.goals[sid]; break; }
          }
        }
      }
    } catch (e) {}

    if (!goalObj) return null;

    try {
      var identifier = goalObj.identifier || '';
      var url        = goalObj.url || '';

      var identifierMap = {
        'vwo_pageView'        : 'Page View',
        'vwo_engagement'      : 'Engagement',
        'vwo_bounce'          : 'Bounce',
        'vwo_dom_click'       : 'Click',
        'vwo_dom_submit'      : 'Form Submit',
        'vwo_dom_hover'       : 'Hover',
        'vwo_revenue'         : 'Revenue',
        'vwo_customConversion': 'Custom Conversion'
      };

      var baseName = identifierMap[identifier] || identifier || 'Goal';

      // For interaction goals, append the selector.
      // We store the FULL selector in the goal object (as vwoSelector) so the
      // UI can show a truncated version in the row but the full selector on hover.
      // The name itself gets a readable short version — last meaningful class/id
      // segment — so the goal list stays scannable.
      if (url && (identifier === 'vwo_dom_click' || identifier === 'vwo_dom_submit' || identifier === 'vwo_dom_hover')) {
        var firstSel = url.split(',')[0].trim();

        // Simplify href attributes to just the last path segment
        var cleanedSel = firstSel.replace(/\[href[^\]]*\]/g, function (m) {
          var hm = m.match(/href[*^$]?=["']([^"']+)/);
          if (hm) {
            var parts = hm[1].replace(/\/$/, '').split('/');
            return '[' + parts[parts.length - 1] + ']';
          }
          return '';
        });

        // Store full cleaned selector for tooltip use (returned alongside name)
        goalObj.__abFullSelector = cleanedSel;

        // For the display name: take up to 50 chars, break at a class/id boundary
        var displaySel = cleanedSel;
        if (displaySel.length > 50) {
          // Try to break at a word boundary (., #, [, space)
          var cutAt = displaySel.lastIndexOf('.', 50);
          if (cutAt < 20) cutAt = displaySel.lastIndexOf('#', 50);
          if (cutAt < 20) cutAt = displaySel.lastIndexOf('[', 50);
          if (cutAt < 20) cutAt = 50;
          displaySel = displaySel.substring(0, cutAt) + '…';
        }
        if (displaySel) baseName = baseName + ': ' + displaySel;
      }

      return baseName;
    } catch (e) {}

    return null;
  }

  // VWO writes _vis_opt_exp_{campaignId}_goal_{goalId} cookie the instant a
  // goal fires — this is the most reliable signal, works for ALL goal types
  // (click, page visit, form submit, custom JS) regardless of which SDK method
  // is used internally. We poll every 500ms and record any newly appeared ones.
  var _seenVwoGoalCookies = new Set();

  function pollVWOGoalCookies() {
    try {
      var changed = false;
      document.cookie.split(';').forEach(function (c) {
        var eq = c.indexOf('=');
        if (eq === -1) return;
        var cName = c.substring(0, eq).trim();
        // Match both formats:
        //   _vis_opt_exp_{campaignId}_goal_{goalId}
        //   _vis_opt_exp_{campaignId}_goal_{goalId}_{accountId}
        var m = cName.match(/^_vis_opt_exp_(\d+)_goal_(\d+)/);
        if (!m) return;
        if (_seenVwoGoalCookies.has(cName)) return;
        _seenVwoGoalCookies.add(cName);

        var expId  = m[1];
        var goalId = m[2];
        var gName  = getVWOGoalName(expId, goalId) || ('VWO Goal ' + goalId);
        // getVWOGoalName stores the full selector on goalObj.__abFullSelector
        var vwoGoalObj2 = (window._vwo_exp && window._vwo_exp[expId] &&
                           window._vwo_exp[expId].goals && window._vwo_exp[expId].goals[goalId]);
        var vwoSel2 = (vwoGoalObj2 && vwoGoalObj2.__abFullSelector) || (vwoGoalObj2 && vwoGoalObj2.url) || '';

        recordGoal('VWO', goalId, gName, 'tracked', vwoSel2 ? { vwoSelector: vwoSel2 } : null);
        changed = true;
      });
      if (changed) postToContent();
    } catch (e) {}
  }

  // Seed the seen-set with any goal cookies already present on page load
  // so we don't re-fire goals from a previous session
  function seedVWOGoalCookies() {
    try {
      document.cookie.split(';').forEach(function (c) {
        var eq = c.indexOf('=');
        if (eq === -1) return;
        var cName = c.substring(0, eq).trim();
        if (/_vis_opt_exp_\d+_goal_\d+/.test(cName)) {
          _seenVwoGoalCookies.add(cName);
        }
      });
    } catch (e) {}
  }

  seedVWOGoalCookies();
  setInterval(pollVWOGoalCookies, 500);

  // SPA support
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    Object.keys(experiments).forEach(function (k) { delete experiments[k]; });
    Object.keys(platforms).forEach(function (k)   { delete platforms[k];   });
    // Goals are intentionally NOT cleared on SPA navigation —
    // cross-page goal tracking is useful (goals from page A are still
    // visible after navigating to page B within the same session).
    // On SPA nav, clear seen goal cookies so new-page goals are picked up fresh
    _seenVwoGoalCookies.clear();
    seedVWOGoalCookies();
    setTimeout(function () { installAllListeners(); runDetection(); postToContent(); }, 600);
  }, 1000);

}());
