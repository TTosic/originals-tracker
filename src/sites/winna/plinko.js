/*
 * Winna Plinko Tracker — content script (ISOLATED world).
 *
 * Plinko drops a ball that bounces down into one of N+1 buckets, each carrying
 * a multiplier (e.g. 0.2x … 1000x). When a ball lands, winna adds the
 * `multiplier-hit` class to that bucket's <li class="multiplier-label">. We
 * watch for that class being added and:
 *   1. Count it as one bet, assigning a running nonce we count ourselves
 *      (aligned to the game via the "Start nonce" setting).
 *   2. Tally how many times each multiplier has hit, and remember the nonces.
 *   3. Render a panel — docked into the empty area beside the game, or popped
 *      out as a draggable card — styled to match the Keno Tracker.
 *
 * Cross-frame: the board runs in the games.winna.com iframe, so we split into
 * reader (in the iframe, detects hits + relays them) and panel (outer page,
 * owns the UI/state/storage). If the board ever shares the top frame, one frame
 * does both (combined). The reader↔panel bridge rides chrome.storage so it
 * never trips winna's "Unknown message type!" console spam.
 */
(function () {
  "use strict";
  if (window.__plinkoTrackerContentLoaded) return;
  window.__plinkoTrackerContentLoaded = true;

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  var STORAGE_KEY = "plinkoTrackerState";

  var DEFAULTS = {
    settings: {
      startNonce: 1, // first nonce assigned to a tracked bet
      open: true,
      collapsed: false,
      mode: "docked", // "docked" | "float"
      floatPos: null,
      panelW: null,
      panelH: null,
      resetOnSeed: true, // rotating the seed pair (new server seed) wipes the history
      debug: false
    },
    // Per-multiplier tally. Array (preserves insertion order; rendered sorted).
    //   { key, text, value, color, count, nonces:[…], lastNonce, _expanded }
    stats: [],
    history: {
      betsTracked: 0,
      lastNonce: null,
      lastMult: null,
      lastColor: null,
      processed: []
    }
  };

  var state = clone(DEFAULTS);
  var saveTimer = null;
  var ROLE = "none"; // "reader" | "panel" | "combined" | "none"
  var boardMults = []; // distinct multipliers currently on the board (for display)
  var detectedRows = null; // e.g. 16, read from the `rows-N` class
  var networkActiveUntil = 0; // while active, DOM class changes are only a fallback
  var historyActiveUntil = 0; // customHistory is the preferred landed-ball signal
  var historyAvailable = false;
  var pendingNetResults = [];
  var seenNetworkIds = {};

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function load(cb) {
    try {
      chrome.storage.local.get(STORAGE_KEY, function (res) {
        var saved = res && res[STORAGE_KEY];
        if (saved) {
          state.settings = Object.assign({}, DEFAULTS.settings, saved.settings || {});
          state.stats = Array.isArray(saved.stats) ? saved.stats : [];
          state.history = Object.assign({}, DEFAULTS.history, saved.history || {});
          repairBadNetworkNonceState();
        }
        cb();
      });
    } catch (e) {
      cb();
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var payload = {};
        payload[STORAGE_KEY] = {
          settings: state.settings,
          stats: state.stats,
          history: state.history
        };
        chrome.storage.local.set(payload);
      } catch (e) {}
    }, 150);
  }

  function log() {
    if (state.settings.debug) {
      try {
        console.log.apply(console, ["[PlinkoTracker]"].concat([].slice.call(arguments)));
      } catch (e) {}
    }
  }

  function repairBadNetworkNonceState() {
    var last = parseInt(state.history.lastNonce, 10);
    var tracked = parseInt(state.history.betsTracked, 10);
    if (!isFinite(last) || !isFinite(tracked) || tracked < 1) return;
    if (last > 1000000) {
      state.history.lastNonce = (state.settings.startNonce || 1) + tracked - 1;
      var seen = [];
      for (var i = 0; i < state.stats.length; i++) {
        var st = state.stats[i];
        if (!st) continue;
        if (parseInt(st.lastNonce, 10) > 1000000) st.lastNonce = null;
        if (Array.isArray(st.nonces)) {
          st.nonces = st.nonces.filter(function (n) {
            return parseInt(n, 10) <= 1000000;
          });
          for (var j = 0; j < st.nonces.length; j++) seen.push(String(st.nonces[j]));
          if (st.lastNonce == null && st.nonces.length) st.lastNonce = st.nonces[st.nonces.length - 1];
        }
      }
      state.history.processed = seen.slice(-500);
      persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Board reading
  // ---------------------------------------------------------------------------
  // "1000x" -> 1000, "0.2x" -> 0.2, "1.5kx" -> 1500. Returns null if unparseable.
  function parseMult(t) {
    var s = String(t || "").toLowerCase().replace(/,/g, "").trim().replace(/x$/, "");
    var scale = 1;
    if (/k$/.test(s)) {
      scale = 1000;
      s = s.replace(/k$/, "");
    }
    var n = parseFloat(s);
    return isFinite(n) ? n * scale : null;
  }

  function labelColor(el) {
    var bg = el && el.style && el.style.backgroundColor;
    if (!bg) {
      try {
        bg = getComputedStyle(el).backgroundColor;
      } catch (e) {}
    }
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" ? bg : null;
  }

  function visibleLabels() {
    var labels = document.querySelectorAll(".multiplier-label");
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      if (isVisible(labels[i])) out.push(labels[i]);
    }
    return out;
  }

  function bucketInfo(bucket, mult) {
    var labels = visibleLabels();
    var idx = typeof bucket === "number" && isFinite(bucket) ? bucket : null;
    if (idx != null && labels[idx]) {
      return { text: multText(labels[idx]), color: labelColor(labels[idx]) };
    }
    var text = formatMult(mult);
    for (var i = 0; i < labels.length; i++) {
      if (multText(labels[i]) === text) return { text: text, color: labelColor(labels[i]) };
    }
    return { text: text, color: null };
  }

  function formatMult(mult) {
    var n = typeof mult === "number" ? mult : parseFloat(mult);
    if (!isFinite(n)) return "";
    return String(n).replace(/\.0+$/, "") + "x";
  }

  function canonicalMultText(text) {
    var raw = String(text || "").trim();
    var parsed = parseMult(raw);
    return parsed == null ? raw : formatMult(parsed);
  }

  function multText(labelEl) {
    var txtEl = labelEl.querySelector(".multiplier-text");
    var t = ((txtEl ? txtEl.textContent : "") || "").trim();
    if (t) return t;
    // On "extreme" risk the 0x buckets render as a skull icon with no text span.
    if (labelEl.querySelector('.skull-icon, img[alt="Skull" i]')) return "0x";
    return (labelEl.textContent || "").trim();
  }

  // winna keeps old row-count bucket rows in the DOM (hidden) after you switch
  // rows, so we only ever read the buckets that are actually on screen.
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The distinct multipliers on the board right now (both symmetric sides merge
  // into one entry per value), so the list can show every bucket up front.
  function readBoardMultipliers() {
    var labels = document.querySelectorAll(".multiplier-label");
    var out = [];
    var seen = {};
    for (var i = 0; i < labels.length; i++) {
      if (!isVisible(labels[i])) continue;
      var t = multText(labels[i]);
      if (!t || seen[t]) continue;
      seen[t] = 1;
      out.push({ text: t, value: parseMult(t), color: labelColor(labels[i]) });
    }
    return out;
  }

  // Rows from the count of visible buckets (N rows -> N+1 buckets). This is
  // immune to stale `rows-N` classes left on hidden rows; the class is only a
  // fallback when we can't see a full row yet.
  function readRows() {
    var labels = document.querySelectorAll(".multiplier-label");
    var visible = 0;
    var cls = null;
    for (var i = 0; i < labels.length; i++) {
      if (!isVisible(labels[i])) continue;
      visible++;
      if (cls == null) {
        var m = (labels[i].className || "").match(/rows-(\d+)/);
        if (m) cls = parseInt(m[1], 10);
      }
    }
    if (visible >= 2) return visible - 1;
    return cls;
  }

  // ---------------------------------------------------------------------------
  // Hit recording
  // ---------------------------------------------------------------------------
  function nextNonce() {
    if (state.history.lastNonce == null) return state.settings.startNonce || 1;
    var n = parseInt(state.history.lastNonce, 10);
    if (isFinite(n)) return n + 1;
    return (state.settings.startNonce || 1) + (state.history.betsTracked || 0);
  }

  function getStat(text) {
    for (var i = 0; i < state.stats.length; i++) {
      if (state.stats[i].text === text) return state.stats[i];
    }
    return null;
  }

  // One ball has landed in the `text` bucket. Count the bet, advance the nonce,
  // and tally it. `color` is the bucket's fill, kept for the pill tint.
  function rememberNonce(nonce) {
    if (nonce == null || nonce === "") return true;
    var key = String(nonce);
    var seen = state.history.processed || (state.history.processed = []);
    if (seen.indexOf(key) !== -1) return false;
    seen.push(key);
    if (seen.length > 500) seen.splice(0, seen.length - 500);
    return true;
  }

  function processHit(text, color, explicitNonce) {
    if (!text) return;
    text = canonicalMultText(text);
    var nonce = explicitNonce != null && explicitNonce !== "" ? String(explicitNonce) : nextNonce();
    if (!rememberNonce(nonce)) return;
    state.history.betsTracked++;
    state.history.lastNonce = nonce;
    state.history.lastMult = text;
    state.history.lastColor = color || state.history.lastColor;

    var st = getStat(text);
    if (!st) {
      st = {
        key: text,
        text: text,
        value: parseMult(text),
        color: color || null,
        count: 0,
        nonces: [],
        lastNonce: null
      };
      state.stats.push(st);
    }
    if (color && !st.color) st.color = color;
    st.count++;
    st.lastNonce = nonce;
    st.nonces.push(nonce);
    if (st.nonces.length > 1000) st.nonces.splice(0, st.nonces.length - 1000);
    st._flash = true;

    log("hit", text, "@ nonce", nonce);
    persist();
    scheduleRender();
  }

  function processNetworkBet(bet) {
    if (!bet || bet.n == null || bet.m == null) return;
    observeCustomHistory();
    if (historyAvailable) return;
    networkActiveUntil = Date.now() + 30000;
    var info = bucketInfo(bet.bucket, bet.m);
    processHit(info.text || formatMult(bet.m), info.color);
  }

  // ---------------------------------------------------------------------------
  // Hit detection — watch for the `multiplier-hit` class being added.
  //
  // On a paid/fast autobet winna may add and remove the class within a frame,
  // but the class-add mutation still fires, so processing records in order
  // catches every landing the instant it happens. (Two balls into the SAME
  // bucket while the class is still present is the one case that can merge into
  // one count — rare outside very fast multi-ball autobet.)
  // ---------------------------------------------------------------------------
  function onBoardMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var el = records[i].target;
      var cn = el && typeof el.className === "string" ? el.className : "";
      if (cn.indexOf("multiplier-label") === -1) continue;
      var hasHit = el.classList.contains("multiplier-hit");
      var hadHit = (" " + (records[i].oldValue || "") + " ").indexOf(" multiplier-hit ") !== -1;
      if (hasHit && !hadHit && !historyAvailable && Date.now() > networkActiveUntil && Date.now() > historyActiveUntil) {
        recordHit(multText(el), labelColor(el));
      }
    }
  }

  // reader relays the hit up to the panel; combined records it locally.
  function recordHit(text, color) {
    if (!text) return;
    if (ROLE === "combined") {
      processHit(text, color);
    } else {
      bridge.hitSeq = (bridge.hitSeq || 0) + 1;
      bridge.hits.push({ seq: bridge.hitSeq, t: text, c: color });
      if (bridge.hits.length > 40) bridge.hits.splice(0, bridge.hits.length - 40);
      writeBridge(true);
    }
  }

  function emitHistoryHit(text, color) {
    if (ROLE === "combined") {
      processHit(text, color);
      return;
    }
    bridge.hitSeq = (bridge.hitSeq || 0) + 1;
    bridge.hits.push({ seq: bridge.hitSeq, t: text, c: color, src: "history" });
    if (bridge.hits.length > 40) bridge.hits.splice(0, bridge.hits.length - 40);
    writeBridge(true);
  }

  function recordHistoryHit(text, color) {
    text = canonicalMultText(text);
    if (!text) return;
    historyActiveUntil = Date.now() + 30000;
    var queued = pendingNetResults.shift();
    if (queued) {
      emitHistoryHit(queued.t || text, queued.c || color);
      return;
    }
    setTimeout(function () {
      var late = pendingNetResults.shift();
      emitHistoryHit(late ? late.t || text : text, late ? late.c || color : color);
    }, 180);
  }

  function recordNetworkBet(bet) {
    if (!bet || bet.n == null || bet.m == null) return;
    observeCustomHistory();
    if (!historyAvailable && Date.now() < historyActiveUntil) return;
    var netId = String(bet.n);
    if (seenNetworkIds[netId]) return;
    seenNetworkIds[netId] = Date.now();
    pruneSeenNetworkIds();
    networkActiveUntil = Date.now() + 30000;
    var info = bucketInfo(bet.bucket, bet.m);
    var queued = {
      t: canonicalMultText(info.text || formatMult(bet.m)),
      c: info.color,
      netId: netId
    };
    if (historyAvailable) {
      pendingNetResults.push(queued);
      if (pendingNetResults.length > 80) pendingNetResults.splice(0, pendingNetResults.length - 80);
      return;
    }
    if (ROLE === "combined") {
      processNetworkBet(bet);
      return;
    }
    bridge.hitSeq = (bridge.hitSeq || 0) + 1;
    bridge.hits.push({
      seq: bridge.hitSeq,
      t: queued.t,
      c: queued.c,
      netId: netId,
      src: "net"
    });
    if (bridge.hits.length > 40) bridge.hits.splice(0, bridge.hits.length - 40);
    writeBridge(true);
  }

  function pruneSeenNetworkIds() {
    var now = Date.now();
    var keys = Object.keys(seenNetworkIds);
    for (var i = 0; i < keys.length; i++) {
      if (now - seenNetworkIds[keys[i]] > 5 * 60 * 1000) delete seenNetworkIds[keys[i]];
    }
  }

  function startNetworkListener() {
    document.addEventListener("pt-net-bet", function (ev) {
      try {
        var detail = typeof ev.detail === "string" ? JSON.parse(ev.detail) : ev.detail;
        recordNetworkBet(detail);
      } catch (e) {}
    });
  }

  var boardObserver = null;
  function observeBoardMutations() {
    if (boardObserver) return;
    try {
      boardObserver = new MutationObserver(onBoardMutations);
      boardObserver.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
        attributeOldValue: true
      });
    } catch (e) {}
  }

  var historyObserver = null;
  var historySeen = typeof WeakSet === "function" ? new WeakSet() : null;

  function historyResultText(el) {
    var textEl =
      (el.querySelector && el.querySelector(".history-button span")) ||
      (el.querySelector && el.querySelector("button span")) ||
      (el.querySelector && el.querySelector("span"));
    var t = canonicalMultText((textEl ? textEl.textContent : el.textContent) || "");
    if (t) return t;
    // On "extreme" risk the 0x result is a skull icon with no text (same as the
    // board buckets). Without this it reads empty, handleHistoryElement bails on
    // `!text`, and the 0x landing is never counted — also desyncing the queued
    // network results onto the next bet.
    if (el.querySelector && el.querySelector('.skull-icon, img[alt="Skull" i]')) return "0x";
    return t;
  }

  function rememberHistoryNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (historySeen) {
      if (historySeen.has(el)) return false;
      historySeen.add(el);
    }
    return true;
  }

  function handleHistoryElement(el) {
    if (!rememberHistoryNode(el)) return;
    var text = historyResultText(el);
    if (!text) return;
    recordHistoryHit(text, labelColor(el));
  }

  function observeCustomHistory() {
    if (historyObserver) return;
    var list = document.querySelector(".customHistory");
    if (!list) return;
    historyAvailable = true;
    try {
      bridge.history = true;
      writeBridge(true);
    } catch (e) {}

    var existing = list.querySelectorAll(".element");
    for (var i = 0; i < existing.length; i++) rememberHistoryNode(existing[i]);

    historyObserver = new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        for (var i2 = 0; i2 < records[r].addedNodes.length; i2++) {
          var node = records[r].addedNodes[i2];
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches(".element")) handleHistoryElement(node);
          var kids = node.querySelectorAll ? node.querySelectorAll(".element") : [];
          for (var k = 0; k < kids.length; k++) handleHistoryElement(kids[k]);
        }
      }
    });
    historyObserver.observe(list, { childList: true, subtree: true });
    log("customHistory ready");
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function resetHistory() {
    state.stats = [];
    state.history = clone(DEFAULTS.history);
    persist();
    render();
  }

  // Seed rotation (account-level, shared across all game modes). plinko-net-hook
  // signals it on `pt-seed-reset`; when the setting is on we wipe the bet/hit
  // history for the fresh seed. The rotation can fire from the game iframe
  // (reader → relay over the bridge) or the top page (panel/combined owns the
  // engine → reset directly).
  function onSeedReset() {
    if (state.settings.resetOnSeed === false) return;
    log("seed rotated — resetting plinko history");
    resetHistory();
    flashStatus("New seed · history reset");
  }
  function handleSeedReset() {
    if (ROLE === "reader") {
      bridge.seedSeq = (bridge.seedSeq || 0) + 1;
      writeBridge(true);
    } else if (ROLE === "combined" || ROLE === "panel") {
      onSeedReset();
    }
  }

  function setStartNonce(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n < 0) return;
    state.settings.startNonce = n;
    persist();
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  var root = null;
  var statusTimer = null;

  function flashStatus(msg) {
    var el = root && root.querySelector("#pt-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("pt-status-show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      el.classList.remove("pt-status-show");
    }, 2500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function parseRgb(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(",").map(parseFloat);
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2] };
  }

  // Readable text colour for a given pill background (dark text on light fills).
  function textOn(color) {
    var c = parseRgb(color);
    if (!c) return "#dbe9f6";
    var lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    return lum > 150 ? "#1a1205" : "#ffffff";
  }

  function buildShell() {
    root = document.createElement("div");
    root.id = "plinko-tracker-root";
    document.body.appendChild(root);
    root.addEventListener("click", onPanelClick);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("change", onPanelChange);
    root.addEventListener("wheel", markPanelScroll, { passive: true });
    root.addEventListener("touchmove", markPanelScroll, { passive: true });
    root.addEventListener("scroll", markPanelScroll, true);
    render();
  }

  // Current board buckets only, with saved hit stats merged in. History remains
  // stored, but rows/risk changes hide multipliers that are not on this board.
  function multiplierRows() {
    var statsByText = {};
    state.stats.forEach(function (s) {
      statsByText[s.text] = s;
    });
    var rows = [];
    var seen = {};
    boardMults.forEach(function (b) {
      if (!b || !b.text || seen[b.text]) return;
      seen[b.text] = 1;
      var st = statsByText[b.text];
      if (st) {
        if (st.value == null) st.value = b.value;
        if (b.color) st.color = b.color;
        rows.push(st);
      } else {
        rows.push({ text: b.text, value: b.value, color: b.color, count: 0, nonces: [], lastNonce: null });
      }
    });
    rows.sort(function (a, b) {
      var av = a.value == null ? -1 : a.value;
      var bv = b.value == null ? -1 : b.value;
      return bv - av;
    });
    return rows;
  }

  function rowSig(s) {
    return [s.count || 0, s.lastNonce, s._expanded ? 1 : 0, (s.nonces || []).length].join("|");
  }

  function rowInner(s) {
    var total = state.history.betsTracked || 0;
    var share = s.count && total ? ((s.count / total) * 100).toFixed(1) + "% of bets" : "not hit yet";
    var meta = s.count ? "last @ nonce " + esc(s.lastNonce) : "—";
    var pillStyle = s.color
      ? 'style="background:' + esc(s.color) + ";color:" + textOn(s.color) + '"'
      : "";

    var caret = "";
    if ((s.nonces || []).length) {
      caret =
        '<button class="pt-caret" data-act="toggle" data-key="' + esc(s.text) +
        '" title="Show nonces">' + (s._expanded ? "▴" : "▾") + "</button>";
    }

    var noncesHtml = "";
    if (s._expanded && (s.nonces || []).length) {
      var list = s.nonces
        .slice()
        .reverse()
        .map(function (n) {
          return esc(n);
        })
        .join(", ");
      noncesHtml = '<div class="pt-nonces"><b>nonces:</b> ' + list + "</div>";
    }

    return (
      '<div class="pt-mult-row">' +
      '<span class="pt-pill" ' + pillStyle + ">" + esc(s.text) + "</span>" +
      '<div class="pt-mult-main">' +
      '<div class="pt-mult-meta">' + meta + "</div>" +
      '<div class="pt-share">' + share + "</div>" +
      "</div>" +
      caret +
      '<span class="pt-count">' + (s.count || 0) + "</span>" +
      "</div>" +
      noncesHtml
    );
  }

  function rowHtml(s) {
    var cls = "pt-mult " + (s.count ? "pt-hit" : "pt-unhit");
    var border = s.color ? ' style="border-left-color:' + esc(s.color) + '"' : "";
    return (
      '<div class="' + cls + '" data-key="' + esc(s.text) + '" data-sig="' + esc(rowSig(s)) + '"' +
      border + ">" + rowInner(s) + "</div>"
    );
  }

  function render() {
    if (!root) return;
    var s = state.settings;

    if (!s.open) {
      // Hidden: no launcher tab. Reopen via the diamond button on the board.
      root.className = "pt-closed";
      root.removeAttribute("style");
      root.innerHTML = "";
      return;
    }

    var prevBody = root.querySelector(".pt-body");
    var prevScroll = prevBody ? prevBody.scrollTop : 0;

    var collapsed = !!s.collapsed;
    root.className =
      (s.mode === "float" ? "pt-open pt-float" : "pt-open pt-docked") + (collapsed ? " pt-collapsed" : "");

    var rows = multiplierRows();
    var rowsHtml = rows.length
      ? rows.map(rowHtml).join("")
      : '<div class="pt-empty">Waiting for the Plinko board… drop a ball and hits will appear here.</div>';

    var last = state.history.lastMult
      ? '<span class="pt-pill" style="' +
        (state.history.lastColor
          ? "background:" + esc(state.history.lastColor) + ";color:" + textOn(state.history.lastColor)
          : "") +
        '">' + esc(state.history.lastMult) + "</span>" +
        '<span class="pt-share">nonce ' + esc(state.history.lastNonce) + "</span>"
      : '<span class="pt-share">none yet</span>';

    var rowsLabel = detectedRows ? detectedRows + " rows" : "—";
    var popTitle = s.mode === "float" ? "Dock to board" : "Pop out (drag anywhere)";
    var collapseTitle = collapsed ? "Expand" : "Collapse to list only";

    var fullHtml =
      '<div class="pt-stats">' +
      '<div><span class="pt-k">Bets</span><span id="pt-bt" class="pt-v">' +
      (state.history.betsTracked || 0) + "</span></div>" +
      '<div><span class="pt-k">Multipliers</span><span id="pt-mc" class="pt-v">' +
      rows.length + "</span></div>" +
      '<div><span class="pt-k">Board</span><span id="pt-rows" class="pt-v">' +
      esc(rowsLabel) + "</span></div>" +
      "</div>" +
      '<div class="pt-lasthit"><span class="pt-k">Last hit</span>' + last + "</div>" +
      '<div class="pt-settings">' +
      '<label for="pt-start"><span>Start nonce</span>' +
      '<input id="pt-start" type="number" min="0" step="1" value="' + (s.startNonce || 1) + '"></label>' +
      '<label for="pt-seedreset"><span>New seed resets history</span>' +
      '<input id="pt-seedreset" type="checkbox"' + (s.resetOnSeed !== false ? " checked" : "") + "></label>" +
      "</div>" +
      '<div class="pt-actions"><button data-act="reset">Reset history</button></div>' +
      '<div id="pt-status" class="pt-status"></div>' +
      '<div class="pt-list-head">Multipliers (by value)</div>';

    root.innerHTML =
      '<div id="plinko-tracker-panel">' +
      '<header class="pt-header">' +
      '<span class="pt-title">Plinko Tracker</span>' +
      '<span class="pt-head-btns">' +
      '<button data-act="collapse" title="' + collapseTitle + '">' + (collapsed ? "▴" : "▾") + "</button>" +
      '<button data-act="popout" title="' + popTitle + '">⤢</button>' +
      "</span>" +
      "</header>" +
      '<div class="pt-body">' +
      (collapsed ? "" : fullHtml) +
      '<div class="pt-mult-list">' + rowsHtml + "</div>" +
      "</div>" +
      '<div class="pt-resize" title="Drag to resize · double-click to reset"></div>' +
      "</div>";

    var newBody = root.querySelector(".pt-body");
    if (newBody && prevScroll) newBody.scrollTop = prevScroll;

    // Restart the flash animation on rows that just took a hit.
    rows.forEach(function (r) {
      if (!r._flash) return;
      r._flash = false;
      var el = root.querySelector('.pt-mult[data-key="' + cssEscape(r.text) + '"]');
      if (!el) return;
      el.classList.remove("pt-flash");
      void el.offsetWidth;
      el.classList.add("pt-flash");
    });

    layout();
    lastRenderAt = Date.now();
  }

  // Minimal attribute-selector escaping for the multiplier text (e.g. "1.5x").
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  var renderTimer = null;
  var scrollQuietUntil = 0;
  var lastRenderAt = 0;
  function markPanelScroll(e) {
    var t = e && e.target;
    if (t && t.closest && !t.closest(".pt-body, .pt-nonces")) return;
    scrollQuietUntil = Date.now() + 850;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function tick() {
      var now = Date.now();
      if (now < scrollQuietUntil && now - lastRenderAt < 3000) {
        renderTimer = setTimeout(tick, Math.max(120, scrollQuietUntil - now));
        return;
      }
      renderTimer = null;
      render();
    }, 160);
  }

  // ---------------------------------------------------------------------------
  // Layout: dock into the empty area beside the game, or float + drag
  // ---------------------------------------------------------------------------
  var DOCK_W = 320;

  function gameIframe() {
    return (
      document.querySelector('iframe[src*="games.winna.com"]') ||
      document.querySelector('iframe[src*="/game/"]') ||
      document.querySelector("iframe")
    );
  }

  function navBottom() {
    var b = 0;
    try {
      ["header", "nav"].forEach(function (sel) {
        var el = document.querySelector(sel);
        if (!el) return;
        var r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 220 && r.top < 200) b = Math.max(b, r.bottom);
      });
    } catch (e) {}
    return b || 64;
  }

  // The visible game card in the outer page (the iframe element is oversized and
  // clipped by its parent, so measure the rounded/aspect wrapper instead).
  function gameBoxRect() {
    var iframe = gameIframe();
    if (!iframe) return null;
    var el = iframe.parentElement;
    var card = el;
    for (var i = 0; i < 5 && el; i++) {
      var cls = (el.getAttribute && el.getAttribute("class")) || "";
      if (/aspect-video|rounded-b|cinema/i.test(cls)) {
        card = el;
        break;
      }
      el = el.parentElement;
    }
    var r = (card || iframe.parentElement || iframe).getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.width < window.innerWidth + 50) {
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    var ir = iframe.getBoundingClientRect();
    return {
      left: ir.left,
      top: ir.top,
      right: Math.min(ir.right, window.innerWidth),
      bottom: ir.bottom,
      width: Math.min(ir.width, window.innerWidth - ir.left),
      height: ir.height
    };
  }

  function clampW(w) {
    return Math.max(240, Math.min(w, window.innerWidth - 16, 760));
  }
  function clampH(h) {
    return Math.max(220, Math.min(h, window.innerHeight - 16));
  }

  function layout() {
    if (!root) return;
    var s = state.settings;

    if (!s.open) {
      root.removeAttribute("style");
      return;
    }
    if (s.mode === "float") {
      var fw = s.panelW ? clampW(s.panelW) : 340;
      var fh = s.panelH ? clampH(s.panelH) : null;
      var p = s.floatPos || { left: window.innerWidth - fw - 20, top: 110 };
      // Full viewport clipping: the whole card stays on screen (when
      // auto-sized, use the rendered height; CSS caps it at 80vh).
      var cardH = fh || (root.getBoundingClientRect().height || 300);
      cardH = Math.min(cardH, window.innerHeight - 16);
      p.left = Math.max(8, Math.min(p.left, window.innerWidth - fw - 8));
      p.top = Math.max(8, Math.min(p.top, window.innerHeight - cardH - 8));
      var maxH = window.innerHeight - p.top - 8;
      if (fh) fh = Math.min(fh, maxH);
      setStyle(root, {
        position: "fixed",
        left: p.left + "px",
        top: p.top + "px",
        right: "auto",
        width: fw + "px",
        height: fh ? fh + "px" : "",
        maxHeight: fh ? fh + "px" : Math.min(maxH, Math.round(window.innerHeight * 0.8)) + "px"
      });
      // The stylesheet caps the floating card at 80vh for the default size;
      // lift that when the user has dragged it to an explicit height.
      var card = root.querySelector("#plinko-tracker-panel");
      if (card) card.style.maxHeight = fh ? "none" : "";
      return;
    }

    // Docked: sit in the empty area to the RIGHT of the visible game box.
    var margin = 8;
    var gap = 12;
    var width = DOCK_W;
    var anchor;
    if (ROLE === "panel") {
      anchor = gameBoxRect();
      if (anchor && panelContentFrac != null && panelContentFrac < 0.999) {
        var b2 = anchor.top + panelContentFrac * anchor.height;
        anchor = { left: anchor.left, top: anchor.top, right: anchor.right, bottom: b2, width: anchor.width, height: b2 - anchor.top };
      }
    } else {
      var content = document.querySelector(".game-content-plinko") || document.querySelector(".game-content");
      var cr = content && content.getBoundingClientRect();
      var container = document.querySelector(".game-container");
      var gr = (container && container.getBoundingClientRect()) || cr;
      if (cr && gr && cr.width > 0) {
        anchor = { right: cr.right, top: gr.top, height: gr.height, bottom: gr.bottom };
      }
    }

    var left, top, height;
    if (anchor) {
      var dockLeft = anchor.right + gap;
      var avail = window.innerWidth - margin - dockLeft;
      var defWidth = avail >= 220 ? Math.min(DOCK_W, avail) : DOCK_W;
      var navB = navBottom();
      var defHeight;
      if (anchor.top >= navB) {
        top = anchor.top;
        defHeight = Math.max(Math.min(anchor.bottom, window.innerHeight) - top, 260);
      } else {
        top = navB;
        defHeight = Math.max(Math.min(anchor.height, window.innerHeight - top), 260);
      }
      width = s.panelW ? clampW(s.panelW) : defWidth;
      height = s.panelH ? clampH(s.panelH) : defHeight;
      left = dockLeft;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    } else {
      width = s.panelW ? clampW(s.panelW) : DOCK_W;
      top = 70;
      height = s.panelH ? clampH(s.panelH) : window.innerHeight - top - margin;
      left = window.innerWidth - margin - width;
    }

    width = Math.min(width, window.innerWidth - 2 * margin);
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(4, Math.min(top, window.innerHeight - 80));
    height = Math.max(160, Math.min(height, window.innerHeight - top - margin));

    setStyle(root, {
      position: "fixed",
      left: left + "px",
      top: top + "px",
      right: "auto",
      width: width + "px",
      height: height + "px",
      maxHeight: height + "px"
    });
  }

  function setStyle(el, obj) {
    for (var k in obj) el.style[k] = obj[k];
  }

  // ---- resize handle (bottom-left) ----
  var resize = null;
  var resizeShield = null;
  var lastResizeDown = 0;
  function startResize(e) {
    var now = Date.now();
    if (now - lastResizeDown < 350) {
      lastResizeDown = 0;
      state.settings.panelW = null;
      state.settings.panelH = null;
      persist();
      layout();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    lastResizeDown = now;
    var rect = root.getBoundingClientRect();
    resize = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    resizeShield = document.createElement("div");
    setStyle(resizeShield, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "2147483647",
      cursor: "nesw-resize",
      background: "transparent"
    });
    (document.body || document.documentElement).appendChild(resizeShield);
    document.addEventListener("pointermove", onResizeMove, true);
    document.addEventListener("pointerup", onResizeUp, true);
    e.preventDefault();
    e.stopPropagation();
  }
  function onResizeMove(e) {
    if (!resize) return;
    state.settings.panelW = clampW(resize.w + (resize.x - e.clientX));
    state.settings.panelH = clampH(resize.h + (e.clientY - resize.y));
    layout();
  }
  function onResizeUp() {
    if (!resize) return;
    resize = null;
    if (resizeShield && resizeShield.parentNode) resizeShield.parentNode.removeChild(resizeShield);
    resizeShield = null;
    document.removeEventListener("pointermove", onResizeMove, true);
    document.removeEventListener("pointerup", onResizeUp, true);
    persist();
  }

  // ---- dragging in float mode ----
  var drag = null;
  function onPointerDown(e) {
    if (e.target.closest && e.target.closest(".pt-resize")) {
      startResize(e);
      return;
    }
    if (state.settings.mode !== "float") return;
    var header = e.target.closest && e.target.closest(".pt-header");
    if (!header || (e.target.closest && e.target.closest("button"))) return;
    var rect = root.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag) return;
    var left = e.clientX - drag.dx;
    var top = e.clientY - drag.dy;
    // Clip the drag to the viewport so the card can't be dropped off-screen.
    var w = root.getBoundingClientRect().width || 340;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - 68));
    state.settings.floatPos = { left: left, top: top };
    root.style.left = left + "px";
    root.style.top = top + "px";
  }
  function onPointerUp() {
    if (!drag) return;
    drag = null;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    persist();
  }

  // ---- styled confirm dialog (replaces window.confirm; mirrors keno's) ----
  var confirmEl = null;
  function ptConfirm(message, onYes) {
    if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
    confirmEl = document.createElement("div");
    confirmEl.className = "pt-confirm";
    confirmEl.innerHTML =
      '<div class="pt-confirm-card">' +
      '<div class="pt-confirm-msg">' + esc(message) + "</div>" +
      '<div class="pt-confirm-btns">' +
      '<button class="pt-confirm-no">Cancel</button>' +
      '<button class="pt-confirm-yes">Confirm</button>' +
      "</div></div>";
    root.appendChild(confirmEl);
    function close() {
      if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
      confirmEl = null;
    }
    confirmEl.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest(".pt-confirm-yes")) {
        close();
        onYes();
      } else if (e.target.closest(".pt-confirm-no") || e.target === confirmEl) {
        close(); // cancel button, or a click on the dimmed backdrop
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Panel events
  // ---------------------------------------------------------------------------
  function onPanelChange(e) {
    if (e.target && e.target.id === "pt-start") setStartNonce(e.target.value);
    else if (e.target && e.target.id === "pt-seedreset") {
      state.settings.resetOnSeed = !!e.target.checked;
      persist();
    }
  }

  function onPanelClick(e) {
    if (e.target.closest("#pt-open")) {
      state.settings.open = true;
      persist();
      render();
      return;
    }
    var actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    switch (actEl.getAttribute("data-act")) {
      case "collapse":
        state.settings.collapsed = !state.settings.collapsed;
        persist();
        render();
        break;
      case "popout":
        state.settings.mode = state.settings.mode === "float" ? "docked" : "float";
        if (state.settings.mode === "float" && !state.settings.floatPos) {
          state.settings.floatPos = { left: window.innerWidth - 380, top: 120 };
        }
        persist();
        render();
        break;
      case "reset":
        ptConfirm("Reset all bet/hit history?", resetHistory);
        break;
      case "toggle": {
        var key = actEl.getAttribute("data-key");
        var st = getStat(key);
        if (st) {
          st._expanded = !st._expanded;
          render();
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-frame wiring (reader ↔ panel over chrome.storage)
  // ---------------------------------------------------------------------------
  var panelContentFrac = null;

  var layoutScheduled = false;
  function scheduleLayout() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(function () {
      layoutScheduled = false;
      layout();
    });
  }

  var BRIDGE_KEY = "plinkoTrackerBridge";
  var bridge = { mults: [], rows: null, hitSeq: 0, hits: [], toggleSeq: 0, cf: 0, history: false, ts: 0 };
  var bridgeWriteT = null;
  function writeBridge(immediate) {
    bridge.ts = Date.now();
    var doWrite = function () {
      try {
        var o = {};
        o[BRIDGE_KEY] = bridge;
        chrome.storage.local.set(o);
      } catch (e) {}
    };
    if (immediate) {
      clearTimeout(bridgeWriteT);
      bridgeWriteT = null;
      doWrite();
      return;
    }
    if (bridgeWriteT) return;
    bridgeWriteT = setTimeout(function () {
      bridgeWriteT = null;
      doWrite();
    }, 120);
  }

  function onToggleClick() {
    // The toggle now lives in the top-page toolbar (panel context), so the
    // panel toggles directly; only the iframe reader relays over the bridge.
    if (ROLE === "reader") {
      bridge.toggleSeq = (bridge.toggleSeq || 0) + 1;
      writeBridge(true);
    } else {
      state.settings.open = !state.settings.open;
      persist();
      render();
    }
  }

  // ---- reader (game iframe) ----
  var readerMultSig = "";
  function readerTick() {
    observeCustomHistory();
    var mults;
    try {
      mults = readBoardMultipliers();
    } catch (e) {
      return;
    }
    var sig = JSON.stringify(mults);
    if (sig !== readerMultSig) {
      readerMultSig = sig;
      bridge.mults = mults;
      bridge.rows = readRows();
      writeBridge();
    }
    var gc =
      document.querySelector(".game-content-plinko") ||
      document.querySelector(".game-container") ||
      document.querySelector(".multiplier-label");
    if (gc) {
      var gr = gc.getBoundingClientRect();
      var vh = window.innerHeight || 1;
      var frac = Math.max(0.3, Math.min(1, gr.bottom / vh));
      if (Math.abs(frac - (bridge.cf || 0)) > 0.004) {
        bridge.cf = frac;
        writeBridge();
      }
    }
    ensureBottomButton();
  }

  // A gem toggle injected into the game's bottom toolbar so the tracker can be
  // reopened from there — adopts a sibling button's classes to look native.
  var TOGGLE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20"/><path d="M8 9l4 12 4-12"/></svg>';
  // Fixed toolbar-icon class so the gem is styled identically every refresh.
  // No tooltip (removed — the gem is self-explanatory).
  var TOOLBAR_BTN_CLASS =
    "flex size-6 items-center justify-center rounded-[8px] text-typography-secondary " +
    "hover:bg-body-level-3 hover:text-accent-blue lg:size-8";
  function styleToggle(btn, refClass) {
    if (refClass) {
      btn.className = refClass;
      btn.style.cssText = "cursor:pointer;display:inline-flex;align-items:center;justify-content:center";
    } else {
      btn.className = "";
      btn.style.cssText =
        "all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;" +
        "width:32px;height:32px;border-radius:8px;color:#7fb0d8;";
    }
  }
  function toolbarRefBtn(bar) {
    var btns = bar.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].id === "pt-bottom-toggle") continue;
      var r = btns[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return btns[i];
    }
    return null;
  }
  function makeToggleBtn(refClass) {
    var btn = document.createElement("button");
    btn.id = "pt-bottom-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Plinko Tracker");
    styleToggle(btn, refClass);
    btn.innerHTML = TOGGLE_SVG;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      onToggleClick();
    });
    return btn;
  }

  // The game toolbar is on the TOP PAGE (board iframe ends above it). Anchor on
  // the unique "Fairness" button and pick its icon-button cluster; fall back to
  // a document scan of small text-typography-secondary buttons.
  function fairnessSection() {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if (!/^fairness$/i.test((btns[i].textContent || "").trim())) continue;
      var r = btns[i].getBoundingClientRect();
      if (r.width <= 0) continue;
      return (btns[i].closest && btns[i].closest("section")) || btns[i].parentNode.parentNode;
    }
    return null;
  }
  function findToolbar() {
    var scope = fairnessSection() || document;
    var divs = scope.querySelectorAll('div[class*="items-center"]');
    var best = null;
    for (var d = 0; d < divs.length; d++) {
      var cb = divs[d].querySelectorAll("button");
      var sq = 0;
      var top = 0;
      for (var j = 0; j < cb.length; j++) {
        var b = cb[j];
        if (b.id === "pt-bottom-toggle") continue;
        if (typeof b.className !== "string" || b.className.indexOf("text-typography-secondary") === -1)
          continue;
        var r = b.getBoundingClientRect();
        if (!(r.width > 0 && r.width <= 60 && Math.abs(r.width - r.height) < 16)) continue;
        sq++;
        if (r.top > top) top = r.top;
      }
      if (sq < 2) continue;
      if (!best || sq > best.sq || (sq === best.sq && top > best.top)) best = { el: divs[d], sq: sq, top: top };
    }
    return best ? best.el : null;
  }

  // Active look: icon goes white while the panel is open (matches native tools).
  function setToggleActive(btn) {
    if (btn) btn.style.color = state.settings.open ? "#fff" : "";
  }
  function ensureBottomButton() {
    try {
      var bar = findToolbar();
      var btn = document.getElementById("pt-bottom-toggle");
      if (bar) {
        // Fixed class (not a copied sibling) → identical look every time.
        if (!btn) btn = makeToggleBtn(TOOLBAR_BTN_CLASS);
        // Append (not insertBefore firstChild) so a foreign node at the front
        // of the framework-managed cluster can't drop sibling tooltips.
        if (btn.parentElement !== bar) bar.appendChild(btn);
        setToggleActive(btn);
        return;
      }
      // Only combined floats a fallback; reader/panel dock via the top-page bar.
      if (ROLE === "combined" && !btn) {
        btn = makeToggleBtn(null);
        btn.style.position = "fixed";
        btn.style.right = "14px";
        btn.style.bottom = "14px";
        btn.style.zIndex = "2147483647";
        btn.style.background = "rgba(15,29,51,0.92)";
        document.body.appendChild(btn);
      }
    } catch (e) {}
  }

  function runReader() {
    var start = function () {
      observeCustomHistory();
      observeBoardMutations();
      startNetworkListener();
      setInterval(readerTick, 250);
      log("reader ready");
    };
    try {
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (b) {
          bridge.hitSeq = b.hitSeq || 0;
          bridge.toggleSeq = b.toggleSeq || 0;
          bridge.history = !!b.history;
        }
        start();
      });
    } catch (e) {
      start();
    }
  }

  // ---- panel: consume the reader's bridge ----
  var lastHitSeq = 0;
  var lastToggleSeq = 0;
  var lastSeedSeq = 0;

  function handleBridge(b) {
    if (!b) return;
    if (b.history) historyAvailable = true;
    if (b.seedSeq && b.seedSeq > lastSeedSeq) {
      lastSeedSeq = b.seedSeq;
      onSeedReset(); // reader saw a seed rotation — reset for the new seed
    }
    if (typeof b.cf === "number") panelContentFrac = b.cf;
    var rowsChanged = false;
    if (typeof b.rows === "number" && b.rows !== detectedRows) {
      detectedRows = b.rows;
      rowsChanged = true;
    }
    var multsChanged = false;
    if (Array.isArray(b.mults) && JSON.stringify(b.mults) !== JSON.stringify(boardMults)) {
      boardMults = b.mults;
      multsChanged = true;
    }
    var hadHit = false;
    if (Array.isArray(b.hits)) {
      b.hits.forEach(function (h) {
        if (h && h.seq > lastHitSeq) {
          lastHitSeq = h.seq;
          if (h.src === "history") {
            historyActiveUntil = Date.now() + 30000;
            processHit(h.t, h.c);
          } else if (h.src === "net") {
            if (historyAvailable) return;
            networkActiveUntil = Date.now() + 30000;
            processHit(h.t, h.c);
          } else if (Date.now() > networkActiveUntil) {
            processHit(h.t, h.c);
          }
          hadHit = true;
        }
      });
    }
    if (b.toggleSeq && b.toggleSeq > lastToggleSeq) {
      lastToggleSeq = b.toggleSeq;
      state.settings.open = !state.settings.open;
      persist();
      render();
    }
    if ((multsChanged || rowsChanged) && !hadHit) scheduleRender();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[BRIDGE_KEY]) return;
    handleBridge(changes[BRIDGE_KEY].newValue);
  }

  function plinkoActive() {
    return /plinko/i.test(location.pathname);
  }

  // ---- panel (outer page) ----
  function runPanel() {
    buildShell();
    root.style.display = "none";
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, true);
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {}
    try {
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (!b) return;
        lastHitSeq = b.hitSeq || 0;
        lastToggleSeq = b.toggleSeq || 0;
        lastSeedSeq = b.seedSeq || 0;
        if (Array.isArray(b.mults)) boardMults = b.mults;
        if (b.history) historyAvailable = true;
        if (typeof b.rows === "number") detectedRows = b.rows;
        if (typeof b.cf === "number") panelContentFrac = b.cf;
        render();
      });
    } catch (e2) {}
    setInterval(function () {
      if (!root) return;
      var active = plinkoActive();
      root.style.display = active ? "" : "none";
      if (active) ensureBottomButton(); // toolbar lives on the top page → panel docks it
      if (active && state.settings.open && state.settings.mode === "docked") layout();
    }, 200);
    log("panel ready");
  }

  // ---- combined (board + page in the same frame) ----
  function runCombined() {
    buildShell();
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, true);
    observeBoardMutations();
    observeCustomHistory();
    startNetworkListener();
    setInterval(function () {
      try {
        boardMults = readBoardMultipliers();
        detectedRows = readRows();
      } catch (e) {}
      ensureBottomButton();
      if (state.settings.open && root && state.settings.mode === "docked") layout();
    }, 400);
    log("combined ready");
  }

  function hasBoardDom() {
    return !!document.querySelector(".multiplier-label");
  }
  function isGameHost() {
    return /(^|\.)games\.winna\.com$/i.test(location.hostname);
  }

  function init() {
    // Seed-rotation signal from plinko-net-hook.js. Added in every frame (the
    // /unhash call fires from whichever frame hosts the fairness UI); routed by
    // role inside handleSeedReset.
    try {
      document.addEventListener("pt-seed-reset", handleSeedReset);
    } catch (e) {}
    var isTop = window === window.top;
    var gameHere = hasBoardDom() || (isGameHost() && /plinko/i.test(location.pathname));
    if (gameHere && isTop) {
      ROLE = "combined";
      runCombined();
    } else if (gameHere && !isTop) {
      ROLE = "reader";
      runReader();
    } else if (isTop) {
      ROLE = "panel";
      runPanel();
    } else {
      ROLE = "none";
    }
    log("role", ROLE);
  }

  load(init);
})();
