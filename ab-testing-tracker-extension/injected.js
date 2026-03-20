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
    var goals = [];
    var platforms = {};

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
            var data = window.convert && window.convert.data;
            if (!data) return null;
            var sid = String(gId);

            // 1a. data.goals as Array (modern snippet)
            var dg = data.goals;
            if (Array.isArray(dg)) {
                for (var i = 0; i < dg.length; i++) {
                    if (String(dg[i].id) === sid) {
                        var n = dg[i].name || dg[i].goal_name || dg[i].goalName || dg[i].n;
                        if (n) return String(n);
                    }
                }
            }

            // 1b. data.goals as Object keyed by id (legacy snippet)
            if (dg && !Array.isArray(dg) && dg[sid]) {
                var obj = dg[sid];
                if (typeof obj === 'object') {
                    var n2 = obj.name || obj.goal_name || obj.goalName || obj.n;
                    if (n2) return String(n2);
                }
            }

            // 2. Scan data.experiences array for nested goal definitions
            var de = data.experiences || data.experiments;
            var expList = Array.isArray(de) ? de : Object.values(de || {});
            for (var j = 0; j < expList.length; j++) {
                var exp = expList[j];
                if (!exp || !exp.goals) continue;
                var gl = exp.goals;
                var goalEntry = Array.isArray(gl)
                    ? gl.find(function (g) { return String(g.id) === sid; })
                    : gl[sid];
                if (goalEntry && typeof goalEntry === 'object') {
                    var n3 = goalEntry.name || goalEntry.goal_name || goalEntry.goalName || goalEntry.n;
                    if (n3) return String(n3);
                }
            }
        } catch (e) { }
        return null;
    }

    var _goalKeys = new Set();
    function recordGoal(platform, goalId, goalName) {
        var gid = safeStr(goalId);
        var tsBucket = Math.floor(Date.now() / 200);
        var key = platform + '|' + gid + '|' + tsBucket;
        if (_goalKeys.has(key)) return;
        _goalKeys.add(key);

        goals.push({
            platform: platform,
            goalId: gid,
            goalName: goalName || gid,
            timestamp: new Date().toISOString(),
            url: location.href
        });
        if (goals.length > 100) goals.shift();
        postToContent();
    }

    // ─── Post data to content script ────────────────────────────────────────────

    function postToContent() {
        window.postMessage({
            __abTracker__: true,
            type: 'AB_DATA',
            payload: {
                experiments: Object.values(experiments),
                goals: goals.slice(),
                platforms: platforms,
                url: location.href,
                ts: Date.now()
            }
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
            // Convert goal beacons
            if (/convert\.com/.test(url) && /goal|conversion/i.test(url)) {
                var m1 = url.match(/goal[_-]?id[=\/](\w+)/i);
                var gId = m1 ? m1[1] : 'unknown';
                var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
                recordGoal('Convert', gId, gName);
            }
            // Optimizely event beacons
            if (/logx\.optimizely\.com|optimizely\.com\/events/.test(url)) {
                try {
                    var bodyStr = null;
                    if (typeof body === 'string') {
                        bodyStr = body;
                    } else if (body && typeof body === 'object' && body.constructor && body.constructor.name === 'URLSearchParams') {
                        bodyStr = decodeURIComponent(body.toString());
                    } else if (body instanceof ArrayBuffer) {
                        bodyStr = new TextDecoder().decode(body);
                    } else if (ArrayBuffer.isView(body)) {
                        bodyStr = new TextDecoder().decode(body.buffer);
                    }

                    var parsed = bodyStr ? JSON.parse(bodyStr) : null;
                    if (parsed && parsed.visitors) {
                        parsed.visitors.forEach(function (vis) {
                            (vis.snapshots || []).forEach(function (snap) {
                                (snap.events || []).forEach(function (ev) {
                                    // ev.key = api_name (human-readable key like "add_to_cart")
                                    // ev.entity_id = numeric ID
                                    // Skip internal decision/activation events
                                    var evKey = ev.key || '';
                                    if (!evKey || evKey === 'campaign_activated') return;
                                    var evName = getOptimizelyEventName(evKey) || evKey;
                                    recordGoal('Optimizely', evKey, evName);
                                });
                            });
                        });
                    }
                } catch (_) { }
            }
            // VWO goal beacons
            if (/visualwebsiteoptimizer\.com|vwo\.com/.test(url) && /goal|conv/i.test(url)) {
                var m2 = url.match(/(?:goal_id|goal)=(\w+)/);
                recordGoal('VWO', m2 ? m2[1] : 'unknown', 'VWO Goal');
            }
        } catch (e) { }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CONVERT
    // ════════════════════════════════════════════════════════════════════════════

    function installConvertListeners() {
        // Lifecycle listener: catches ALL goal types (click, visit, form, JS)
        try {
            window._conv_q = window._conv_q || [];
            if (!window._conv_q.__abGoalListenerAdded) {
                window._conv_q.__abGoalListenerAdded = true;
                window._conv_q.push({
                    what: 'addListener',
                    params: {
                        event: 'goal.triggered',
                        handler: function (event) {
                            try {
                                var gId = event['goal-id'] || event.goalId || event.goal_id || 'unknown';
                                var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
                                recordGoal('Convert', gId, gName);
                            } catch (e) { }
                        }
                    }
                });
            }
        } catch (e) { }

        // Hook _conv_q.push for manual triggerConversion calls
        try {
            var q = window._conv_q;
            if (q && !q.__abPushHooked) {
                q.__abPushHooked = true;
                var origPush = Array.prototype.push.bind(q);
                q.push = function (cmd) {
                    if (Array.isArray(cmd) && cmd[0] === 'triggerConversion') {
                        var gId = cmd[1];
                        var gName = getConvertGoalName(gId) || ('Convert Goal ' + gId);
                        recordGoal('Convert', gId, gName);
                    }
                    return origPush(cmd);
                };
            }
        } catch (e) { }
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
        } catch (e) { }
        return null;
    }

    function detectConvert() {
        var found = false;

        // Method 1 — window.convert.currentData.experiences (modern snippet)
        try {
            var cd = window.convert && window.convert.currentData;
            var exps = cd && cd.experiences;
            if (exps && typeof exps === 'object') {
                Object.keys(exps).forEach(function (expId) {
                    var exp = exps[expId];
                    if (!exp) return;
                    var vObj = (exp.variation && typeof exp.variation === 'object') ? exp.variation : {};

                    var varName = vObj.name
                        || (vObj.id ? ('Variation ' + vObj.id) : null)
                        || (vObj.key ? ('Variation ' + vObj.key) : null)
                        || 'Control / Original';

                    experiments['c_' + expId] = {
                        platform: 'Convert',
                        id: expId,
                        name: getConvertExpName(expId) || exp.name || exp.experiment_name || ('Convert Exp ' + expId),
                        variant: varName,
                        variantId: safeStr(vObj.id || vObj.key || ''),
                        firstTime: !!exp.firstTime,
                        status: 'active'
                    };
                    found = true;
                });
            }
        } catch (e) { }

        // Method 2 — window._conv_r (legacy)
        try {
            var r = window._conv_r;
            if (r && typeof r === 'object') {
                Object.keys(r).forEach(function (expId) {
                    if (experiments['c_' + expId]) return;
                    var exp = r[expId];
                    var varName = exp && (exp.variation_name || exp.variationName);
                    if (!varName) return;
                    experiments['c_' + expId] = {
                        platform: 'Convert',
                        id: expId,
                        name: exp.exp_name || exp.name || ('Convert Exp ' + expId),
                        variant: varName,
                        variantId: safeStr(exp.variation_id || exp.variationId || ''),
                        status: 'active'
                    };
                    found = true;
                });
            }
        } catch (e) { }

        // Method 3 — _conv_v cookie
        try {
            document.cookie.split(';').forEach(function (c) {
                var eq = c.indexOf('=');
                if (eq === -1) return;
                var cName = c.substring(0, eq).trim();
                var cVal = c.substring(eq + 1).trim();
                if (!cName.startsWith('_conv_v')) return;
                var decoded = decodeURIComponent(cVal);
                var re = /v\.(\d+)\.(\d+)/g, m;
                while ((m = re.exec(decoded)) !== null) {
                    var expId = m[1], varId = m[2];
                    if (experiments['c_' + expId]) return;
                    experiments['c_' + expId] = {
                        platform: 'Convert',
                        id: expId,
                        name: getConvertExpName(expId) || ('Convert Exp ' + expId),
                        variant: varId === '0' ? 'Control' : ('Variation ' + varId),
                        variantId: varId,
                        status: 'active'
                    };
                    found = true;
                }
            });
        } catch (e) { }

        // Method 4 — window.convert.data.experiments (older snippet)
        try {
            var d = window.convert && window.convert.data;
            if (d && d.experiments && typeof d.experiments === 'object') {
                Object.keys(d.experiments).forEach(function (expId) {
                    if (experiments['c_' + expId]) return;
                    var exp = d.experiments[expId];
                    if (!exp) return;
                    experiments['c_' + expId] = {
                        platform: 'Convert',
                        id: expId,
                        name: exp.name || ('Convert Exp ' + expId),
                        variant: exp.variation_name || exp.variationName || 'Unknown',
                        variantId: safeStr(exp.variation_id || exp.variationId || ''),
                        status: 'active'
                    };
                    found = true;
                });
            }
        } catch (e) { }

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
        } catch (e) { }
        return null;
    }

    function installOptimizelyListeners() {
        try {
            var optly = window.optimizely;
            if (!optly || typeof optly.push !== 'function') return;

            // campaignDecided lifecycle notification
            if (!optly.__abCampaignListenerAdded) {
                optly.__abCampaignListenerAdded = true;
                optly.push({
                    type: 'addListener',
                    filter: { type: 'lifecycle', name: 'campaignDecided' },
                    handler: function (event) {
                        try {
                            var data = event.data || {};
                            var expObj = data.experiment || {};
                            var varObj = data.variation || {};
                            var camp = data.campaign || {};
                            if (!expObj.id) return;
                            experiments['o_' + expObj.id] = {
                                platform: 'Optimizely',
                                id: safeStr(expObj.id),
                                name: expObj.name || camp.name || ('Optimizely Exp ' + expObj.id),
                                variant: varObj.name || safeStr(varObj.id) || 'Unknown',
                                variantId: safeStr(varObj.id || ''),
                                status: 'active'
                            };
                            platforms.optimizely = true;
                            postToContent();
                        } catch (e) { }
                    }
                });
            }

            // trackEvent analytics notification — correct filter type is "analytics"
            // event.data.name = display name, event.data.eventName = api_name/key
            if (!optly.__abTrackListenerAdded) {
                optly.__abTrackListenerAdded = true;
                optly.push({
                    type: 'addListener',
                    filter: { type: 'analytics', name: 'trackEvent' },
                    handler: function (event) {
                        try {
                            var data = event.data || {};
                            // data.name = display name, data.eventName/eventKey = api key
                            var evKey = data.eventName || data.eventKey || data.name || data.key || '';
                            var evName = data.name || data.eventName || data.eventKey || evKey;
                            if (evKey && evKey !== 'campaign_activated') {
                                var resolved = getOptimizelyEventName(evKey) || evName || evKey;
                                recordGoal('Optimizely', evKey, resolved);
                            }
                        } catch (e) { }
                    }
                });
            }

            // Hook push for goal events (both modern object and legacy array form)
            if (!optly.__abPushHooked) {
                optly.__abPushHooked = true;
                var origPush = optly.push.bind(optly);
                optly.push = function (payload) {
                    try {
                        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                            if (payload.type === 'event') {
                                var evKey = payload.eventName || payload.eventKey || payload.name || '';
                                if (evKey && evKey !== 'campaign_activated') {
                                    var resolved = getOptimizelyEventName(evKey) || evKey;
                                    recordGoal('Optimizely', evKey, resolved);
                                }
                            }
                        }
                        if (Array.isArray(payload) && payload[0] === 'trackEvent') {
                            var evKey2 = payload[1] || '';
                            if (evKey2 && evKey2 !== 'campaign_activated') {
                                var resolved2 = getOptimizelyEventName(evKey2) || evKey2;
                                recordGoal('Optimizely', evKey2, resolved2);
                            }
                        }
                    } catch (e) { }
                    return origPush(payload);
                };
            }
        } catch (e) { }
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
                            var cs = campaigns[campId];
                            var expObj = cs.experiment || {};
                            var varObj = cs.variation || {};
                            if (!expObj.id) return;
                            experiments['o_' + expObj.id] = {
                                platform: 'Optimizely',
                                id: safeStr(expObj.id),
                                name: expObj.name || cs.campaignName || ('Optimizely Exp ' + expObj.id),
                                variant: varObj.name || safeStr(varObj.id) || 'Unknown',
                                variantId: safeStr(varObj.id || ''),
                                status: cs.isActive ? 'active' : 'inactive'
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
                                platform: 'Optimizely',
                                id: safeStr(expId),
                                name: es.experimentName || ('Optimizely Exp ' + expId),
                                variant: v.name || safeStr(v.id) || 'Unknown',
                                variantId: safeStr(v.id || ''),
                                status: es.isActive ? 'active' : 'inactive'
                            };
                        });
                    }
                }
            }

            // Classic SDK
            if (optly.data) {
                var exps2 = optly.data.experiments || {};
                var varMap = (optly.data.state && optly.data.state.variationNamesMap) || {};
                var actives = (optly.data.state && optly.data.state.activeExperiments) || [];
                actives.forEach(function (expId) {
                    if (experiments['o_' + expId]) return;
                    var exp = exps2[expId] || {};
                    experiments['o_' + expId] = {
                        platform: 'Optimizely',
                        id: safeStr(expId),
                        name: exp.name || ('Optimizely Exp ' + expId),
                        variant: varMap[expId] || 'Unknown',
                        variantId: '',
                        status: 'active'
                    };
                });
            }
        } catch (e) { }
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
                        var expId = safeStr(data[1]);
                        var varId = safeStr(data[2]);
                        if (!expId) return;
                        var exp = window._vwo_exp && window._vwo_exp[expId];
                        var vName = (exp && exp.comb_n && exp.comb_n[varId])
                            || (varId === '1' ? 'Control' : ('Variation ' + (parseInt(varId, 10) - 1)));
                        experiments['v_' + expId] = {
                            platform: 'VWO',
                            id: expId,
                            name: (exp && exp.name) || ('VWO Exp ' + expId),
                            variant: vName,
                            variantId: varId,
                            status: 'active'
                        };
                        platforms.vwo = true;
                        postToContent();
                    } catch (e) { }
                }]);
            }
        } catch (e) { }

        // Hook classic goal functions
        try {
            if (typeof window._vis_opt_goal_conversion === 'function' && !window._vis_opt_goal_conversion.__abHooked) {
                var orig1 = window._vis_opt_goal_conversion;
                window._vis_opt_goal_conversion = function (goalId) {
                    var gName = getVWOGoalName('', goalId) || ('VWO Goal ' + goalId);
                    recordGoal('VWO', goalId, gName);
                    return orig1.apply(this, arguments);
                };
                window._vis_opt_goal_conversion.__abHooked = true;
            }
        } catch (e) { }

        try {
            if (typeof window._vis_opt_register_conversion === 'function' && !window._vis_opt_register_conversion.__abHooked) {
                var orig2 = window._vis_opt_register_conversion;
                window._vis_opt_register_conversion = function (goalId, campaignId) {
                    var gName = getVWOGoalName(campaignId || '', goalId) || ('VWO Goal ' + goalId);
                    recordGoal('VWO', goalId, gName);
                    return orig2.apply(this, arguments);
                };
                window._vis_opt_register_conversion.__abHooked = true;
            }
        } catch (e) { }

        // Hook VWO.event (SmartCode / new SDK)
        try {
            if (window.VWO && typeof window.VWO.event === 'function' && !window.VWO.event.__abHooked) {
                var origEvt = window.VWO.event.bind(window.VWO);
                window.VWO.event = function (goalId) {
                    var gName = getVWOGoalName('', goalId) || ('VWO Goal ' + goalId);
                    recordGoal('VWO', goalId, gName);
                    return origEvt.apply(this, arguments);
                };
                window.VWO.event.__abHooked = true;
            }
        } catch (e) { }

        // Hook VWO queue push for ['track.goal', id]
        try {
            if (Array.isArray(window.VWO) && !window.VWO.__abQueueHooked) {
                window.VWO.__abQueueHooked = true;
                var origVwoPush = Array.prototype.push.bind(window.VWO);
                window.VWO.push = function (cmd) {
                    if (Array.isArray(cmd) && cmd[0] === 'track.goal') {
                        var gName = getVWOGoalName('', cmd[1]) || ('VWO Goal ' + cmd[1]);
                        recordGoal('VWO', cmd[1], gName);
                    }
                    return origVwoPush(cmd);
                };
            }
        } catch (e) { }
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
                    var cId = safeStr(exp.combination_chosen);
                    var cName = (exp.comb_n && exp.comb_n[exp.combination_chosen])
                        || (exp.combination_chosen === 1 ? 'Control' : ('Variation ' + (exp.combination_chosen - 1)));
                    experiments['v_' + expId] = {
                        platform: 'VWO',
                        id: expId,
                        name: exp.name || ('VWO Exp ' + expId),
                        variant: cName,
                        variantId: cId,
                        status: 'active'
                    };
                    found = true;
                });
            }
        } catch (e) { }

        // Method 2 — _vis_opt_exp_{id}_combi cookies
        try {
            document.cookie.split(';').forEach(function (c) {
                var eq = c.indexOf('=');
                if (eq === -1) return;
                var cName = c.substring(0, eq).trim();
                var cVal = c.substring(eq + 1).trim();
                var m = cName.match(/^_vis_opt_exp_(\d+)_combi$/);
                if (!m) return;
                var expId = m[1];
                if (experiments['v_' + expId]) return;
                var combi = parseInt(cVal, 10);
                var exp = window._vwo_exp && window._vwo_exp[expId];
                var vName = (exp && exp.comb_n && exp.comb_n[combi])
                    || (combi === 1 ? 'Control' : ('Variation ' + (combi - 1)));
                experiments['v_' + expId] = {
                    platform: 'VWO',
                    id: expId,
                    name: (exp && exp.name) || ('VWO Exp ' + expId),
                    variant: vName,
                    variantId: safeStr(combi),
                    status: 'active'
                };
                found = true;
            });
        } catch (e) { }

        if (found || window._vwo_exp || window._vwo_code || window.VWO) {
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

    installAllListeners();
    runDetection();
    postToContent();

    setTimeout(function () { installAllListeners(); runDetection(); postToContent(); }, 800);
    setTimeout(function () { installAllListeners(); runDetection(); postToContent(); }, 2500);
    setTimeout(function () { installAllListeners(); runDetection(); postToContent(); }, 6000);

    // ── VWO goal cookie poller ───────────────────────────────────────────────────
    // ─── VWO goal name builder ────────────────────────────────────────────────────
    // VWO stores NO goal names — only identifier (event type) and url (selector).
    // We build a readable name: e.g. "Click: renew", "Page View", "Bounce".
    function getVWOGoalName(expId, goalId) {
        var sid = String(goalId);
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
        } catch (e) { }

        if (!goalObj) return null;

        try {
            var identifier = goalObj.identifier || '';
            var url = goalObj.url || '';

            var identifierMap = {
                'vwo_pageView': 'Page View',
                'vwo_engagement': 'Engagement',
                'vwo_bounce': 'Bounce',
                'vwo_dom_click': 'Click',
                'vwo_dom_submit': 'Form Submit',
                'vwo_dom_hover': 'Hover',
                'vwo_revenue': 'Revenue',
                'vwo_customConversion': 'Custom Conversion'
            };

            var baseName = identifierMap[identifier] || identifier || 'Goal';

            // For interaction goals, append a short readable selector
            if (url && (identifier === 'vwo_dom_click' || identifier === 'vwo_dom_submit' || identifier === 'vwo_dom_hover')) {
                var shortSel = url.split(',')[0].trim()
                    .replace(/\[href[^\]]*\]/g, function (m) {
                        var hm = m.match(/href[*^$]?=["']([^"']+)/);
                        if (hm) {
                            var parts = hm[1].replace(/\/$/, '').split('/');
                            return '[' + parts[parts.length - 1] + ']';
                        }
                        return '';
                    });
                if (shortSel.length > 45) shortSel = shortSel.substring(0, 45) + '…';
                if (shortSel) baseName = baseName + ': ' + shortSel;
            }

            return baseName;
        } catch (e) { }

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

                var expId = m[1];
                var goalId = m[2];
                var gName = getVWOGoalName(expId, goalId) || ('VWO Goal ' + goalId);

                recordGoal('VWO', goalId, gName);
                changed = true;
            });
            if (changed) postToContent();
        } catch (e) { }
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
        } catch (e) { }
    }

    seedVWOGoalCookies();
    setInterval(pollVWOGoalCookies, 500);

    // SPA support
    var lastHref = location.href;
    setInterval(function () {
        if (location.href === lastHref) return;
        lastHref = location.href;
        Object.keys(experiments).forEach(function (k) { delete experiments[k]; });
        Object.keys(platforms).forEach(function (k) { delete platforms[k]; });
        // On SPA nav, clear seen goal cookies so new-page goals are picked up fresh
        _seenVwoGoalCookies.clear();
        seedVWOGoalCookies();
        setTimeout(function () { installAllListeners(); runDetection(); postToContent(); }, 600);
    }, 1000);

}());
