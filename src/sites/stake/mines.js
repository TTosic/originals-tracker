/*
 * Stake Mines Tracker — Phase 4 + 5.
 *
 * Keno-parity tracker for Stake mines. Docking + footer gem ported from the
 * Stake keno adapter; theme matches keno (sm-*).
 *
 * Config = a set of tiles (0-idx), shown as a mini 5×5 board with Stake's real
 * gem art. HIT = round's mines avoid ALL its tiles (binary all-safe). Config
 * stores its saved multiplier. Math: Stake HOUSE 1% → mult(k,m)=0.99·Π(25−i)/
 * (25−m−i); all-safe prob = Π(25−m−i)/(25−i) (position-independent — honest).
 *
 * Features: pre-select-to-save (`.cover.selected`), live mine-count, dry counter
 * + "chasing X", resize/float/collapse, ⚙ settings (keno-styled switches),
 * ⇅ sort (Manual/Hit/Mult/Dry), ⓘ per-config odds popup, expandable hit history,
 * export/import, and board GLOW (rings a config's tiles on the real board).
 *
 * Rounds from mines-net-hook (active:false + state.mines[], dedupe on id).
 * Net field/mines 0-idx; DOM game-tile-N 1-idx (f=N−1).
 *
 * Namespaced: guard __stakeMinesTrackerLoaded, root #stake-mines-root, sm-*,
 * storage stakeMinesTrackerState, net __sm_net, toggle sm-bottom-toggle.
 */
(function () {
  "use strict";
  if (window.__stakeMinesTrackerLoaded) return;
  window.__stakeMinesTrackerLoaded = true;

  var TAG = "[StakeMines]";
  var GRID = 25;
  var HOUSE = 0.99;
  var DOCK_W = 365;
  var MIN_W = 288, MAX_W = 560, MIN_H = 240;
  var STORAGE_KEY = "stakeMinesTrackerState";
  var EXPORT_TAG = "originals-mines-tracker";

  var TOGGLE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20"/><path d="M8 9l4 12 4-12"/></svg>';

  var state = {
    nonce: 0,
    processed: [],
    configs: [],
    recent: [], // rolling {n, mines[], mc} per round — replayed to verify the seed checker
    seeds: [], // revealed (rotated-away) seed records: {server, client, stopNonce, ts, offset, verified, trusted, matched, checked}
    algoOk: false, // set once a revealed seed replays our recorded rounds exactly (mines maths confirmed, one-time)
    algoOffset: 0, // nonce offset from that confirmation, reused to trust later 0-round reveals
    settings: {
      open: true,
      collapsed: false,
      mode: "docked",
      floatPos: null,
      panelW: null,
      panelH: null,
      gemArt: true,
      glow: true,
      hitFlash: true,
      notify: true,
      hideTitle: false,
      resetOnSeed: true, // rotating the seed pair wipes the hit history
      sortMode: "manual",
      sortDir: "desc"
    }
  };
  function S() {
    return state.settings;
  }

  var liveMines = null;
  var lastLayout = null;
  var selection = [];
  var selKey = "";
  var pendingHit = null; // {items:[{mult,tiles,mines,color}], nonce} — hit card
  var dragging = false;
  var draggedRow = null;
  var dropLine = null;
  var GLOW_PALETTE = ["#ffd23f", "#38bdf8", "#c084fc", "#fb7185", "#4ef08a", "#f97316"];
  var EYE_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';

  function onMinesPage() {
    return /\/casino\/games\/mines(\/|$|\?)/i.test(location.pathname + location.search);
  }
  function log() {
    try {
      console.log.apply(console, [TAG].concat([].slice.call(arguments)));
    } catch (e) {}
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function numsort(a, b) {
    return a - b;
  }
  function keyOf(t) {
    return t.slice().sort(numsort).join(",");
  }
  function uid() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  function setStyle(el, o) {
    for (var k in o) el.style[k] = o[k];
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function findConfig(id) {
    for (var i = 0; i < state.configs.length; i++) if (state.configs[i].id === id) return state.configs[i];
    return null;
  }

  function trueProb(k, m) {
    if (k <= 0 || m == null) return 1;
    var p = 1;
    for (var i = 0; i < k; i++) p *= (GRID - m - i) / (GRID - i);
    return p < 0 ? 0 : p;
  }
  function payoutMult(k, m) {
    var tp = trueProb(k, m);
    return tp > 0 ? HOUSE / tp : 0;
  }

  // ---- persistence ----
  function serialize() {
    return {
      nonce: state.nonce,
      processed: state.processed.slice(-200),
      configs: state.configs,
      recent: state.recent.slice(-1000),
      seeds: state.seeds,
      algoOk: state.algoOk,
      algoOffset: state.algoOffset,
      settings: S()
    };
  }
  function persist() {
    try {
      var o = {};
      o[STORAGE_KEY] = serialize();
      chrome.storage.local.set(o);
    } catch (e) {}
  }
  function load(cb) {
    try {
      chrome.storage.local.get(STORAGE_KEY, function (res) {
        var s = res && res[STORAGE_KEY];
        if (s) {
          state.nonce = s.nonce || 0;
          state.processed = s.processed || [];
          state.configs = s.configs || [];
          state.recent = Array.isArray(s.recent) ? s.recent : [];
          state.seeds = Array.isArray(s.seeds) ? s.seeds : [];
          state.algoOk = s.algoOk === true;
          state.algoOffset = typeof s.algoOffset === "number" ? s.algoOffset : 0;
          var d = state.settings, ss = s.settings || {};
          for (var k in d) if (ss[k] == null) ss[k] = d[k];
          state.settings = ss;
        }
        cb();
      });
    } catch (e) {
      cb();
    }
  }

  // ---- board reads ----
  function tileButtons() {
    return document.querySelectorAll('button[data-testid^="game-tile-"]');
  }
  function tileByField(f) {
    return document.querySelector('button[data-testid="game-tile-' + (f + 1) + '"]');
  }
  function liveMinesCount() {
    var sel = document.querySelector('select[data-testid="mines-count"]');
    if (sel && sel.value) {
      var n = parseInt(sel.value, 10);
      if (!isNaN(n)) return n;
    }
    return null;
  }
  function readSelection() {
    var picks = [];
    Array.prototype.forEach.call(tileButtons(), function (t) {
      if (t.querySelector(".cover.selected")) {
        var id = t.getAttribute("data-testid") || "";
        var n = parseInt(id.replace("game-tile-", ""), 10);
        if (!isNaN(n)) picks.push(n - 1);
      }
    });
    return picks.sort(numsort);
  }

  // ---- network → rounds ----
  function handleNet(raw) {
    if (typeof raw !== "string" || raw.indexOf("mines") === -1) return;
    var obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return;
    }
    var p = obj && (obj.minesBet || obj.minesNext || obj.minesCashout);
    if (!p || !p.state) return;
    var s = p.state;
    if (typeof s.minesCount === "number") liveMines = s.minesCount;

    // Bet-start: a fresh minesBet means a new round began — clear the hit glow
    // and the notification card immediately, like keno clears at bet-start.
    if (obj.minesBet) {
      clearGlow();
      if (pendingHit) {
        pendingHit = null;
        refreshLive();
      }
    }

    if (p.active === false && Array.isArray(s.mines) && s.mines.length) {
      if (p.id && state.processed.indexOf(p.id) !== -1) return;
      if (p.id) {
        state.processed.push(p.id);
        if (state.processed.length > 200) state.processed.splice(0, state.processed.length - 200);
      }
      state.nonce++;
      lastLayout = { mines: s.mines.slice(), minesCount: s.minesCount, mult: p.payoutMultiplier || 0 };
      // Rolling log for the seed checker: prove the maths by replaying these.
      state.recent.push({ n: state.nonce, mines: s.mines.slice(), mc: s.minesCount });
      if (state.recent.length > 1000) state.recent.splice(0, state.recent.length - 1000);
      var hits = evalRound(lastLayout);
      persist();
      if (hits.length) {
        // Bet-hits (gold) first, then biggest multiplier — assigns the glow
        // colours and the notification-card order.
        hits.sort(function (a, b) {
          return (b._bet ? 1 : 0) - (a._bet ? 1 : 0) || b.mult - a.mult;
        });
        var items = hits.map(function (c, i) {
          return {
            mult: c.mult,
            tiles: c.tiles.length,
            mines: c.mines,
            color: c._bet ? "#ffd23f" : GLOW_PALETTE[i % GLOW_PALETTE.length]
          };
        });
        pendingHit = S().notify !== false ? { items: items, nonce: state.nonce } : null;
        setHitGlow(hits.map(function (c, i) {
          return { tiles: c.tiles, color: c._bet ? "#ffd23f" : GLOW_PALETTE[i % GLOW_PALETTE.length] };
        }));
      } else {
        pendingHit = null;
      }
      refreshLive();
      log("round #" + state.nonce + " · mines", s.mines);
    }
  }
  function evalRound(round) {
    var mineSet = {};
    round.mines.forEach(function (f) {
      mineSet[f] = 1;
    });
    var hits = [];
    state.configs.forEach(function (c) {
      if (!c.tiles || !c.tiles.length) return;
      // A config is a setup (its tiles AT its mine count). Only evaluate it on
      // rounds actually played at that mine count — otherwise an 8-tile/11-mine
      // set trivially "wins" every 5-mine round, which isn't the same bet.
      if (c.mines !== round.minesCount) return;
      var hit = true;
      for (var i = 0; i < c.tiles.length; i++) {
        if (mineSet[c.tiles[i]]) {
          hit = false;
          break;
        }
      }
      if (!hit) return;
      c.hitCount = (c.hitCount || 0) + 1;
      c.lastHitNonce = state.nonce;
      c.lastHitMult = c.mult;
      // Gold = you were betting THIS set when it hit (its tiles == your current
      // selection); otherwise it's a watched hit (green). Gold persists, and the
      // per-hit `bet` flag colours that nonce in the history.
      var bet = !!(selKey && keyOf(c.tiles) === selKey);
      if (bet) c.gold = true;
      c._bet = bet;
      c.hits = c.hits || [];
      c.hits.push({ n: state.nonce, mult: c.mult, bet: bet });
      if (c.hits.length > 100) c.hits.splice(0, c.hits.length - 100);
      c._flash = true;
      hits.push(c);
    });
    return hits;
  }

  // ---- config ops ----
  function saveConfig() {
    var sel = selection.slice();
    if (!sel.length) {
      flash("Select tiles on the board first");
      return;
    }
    var m = liveMinesCount();
    if (m == null) m = liveMines != null ? liveMines : 3;
    var key = keyOf(sel);
    // Same tiles at a DIFFERENT mine count is a different bet — allow it; only
    // block an exact tiles+mines duplicate.
    if (state.configs.some(function (c) {
      return keyOf(c.tiles) === key && c.mines === m;
    })) {
      flash("Already tracked at " + m + " mines");
      return;
    }
    state.configs.push({
      id: uid(),
      tiles: sel.sort(numsort),
      mines: m,
      mult: payoutMult(sel.length, m),
      hitCount: 0,
      lastHitNonce: null,
      lastHitMult: null,
      hits: []
    });
    persist();
    refreshLive();
  }
  function deleteConfig(id) {
    state.configs = state.configs.filter(function (c) {
      return c.id !== id;
    });
    persist();
    refreshLive();
  }
  function clearConfigs() {
    if (!state.configs.length) return;
    smConfirm("Remove all tracked configs?", function () {
      state.configs = [];
      persist();
      render();
    });
  }
  function doResetHistory() {
    state.nonce = 0;
    state.processed = [];
    state.recent = []; // new seed → fresh round log so the seed checker's nonces align
    state.configs.forEach(function (c) {
      c.hitCount = 0;
      c.lastHitNonce = null;
      c.lastHitMult = null;
      c.hits = [];
      c.gold = false;
    });
    clearGlow();
    persist();
    render();
  }
  function resetHistory() {
    smConfirm("Reset all round/hit history?", doResetHistory);
  }

  // The player rotated their seed pair (shared across all game modes → the same
  // Stake rotateSeedPair op keno watches). Past rounds belong to the retired
  // seed, so — when the setting is on — wipe the hit history (no confirm; the
  // rotation is itself the deliberate action). mines-net-hook.js forwards the
  // rotate response; we shape-check the new activeServerSeed before acting.
  var pendingReveal = { nonce: 0, rounds: [], ts: 0 };
  function onSeedReset(text) {
    try {
      var d = JSON.parse(text);
      if (!(d && d.data && d.data.rotateSeedPair && d.data.rotateSeedPair.clientSeed)) return; // not a rotation
    } catch (e) {
      return;
    }
    // Snapshot the retiring seed's rounds + count for the seed checker, BEFORE
    // the reset clears them — the serverSeedByHash reveal arrives async, after.
    pendingReveal = { nonce: state.nonce || 0, rounds: recordedRounds(), ts: Date.now() };
    if (S().resetOnSeed !== false) {
      doResetHistory();
      flash("New seed · history reset");
    }
    // With reset off the round log spans seeds, so the checker may not verify —
    // that's fine, it just shows "couldn't verify" (never wrong data).
  }
  function doExport() {
    var data = {
      tag: EXPORT_TAG,
      v: 1,
      configs: state.configs.map(function (c) {
        return { tiles: c.tiles, mines: c.mines, mult: c.mult };
      })
    };
    smPrompt("Copy your configs (JSON)", JSON.stringify(data), true, null);
  }
  function doImport() {
    smPrompt("Paste exported configs (JSON)", "", false, function (txt) {
      var d;
      try {
        d = JSON.parse(txt);
      } catch (e) {
        flash("Invalid JSON");
        return;
      }
      var arr = d && (d.configs || (Array.isArray(d) ? d : null));
      if (!arr || !arr.length) {
        flash("No configs found");
        return;
      }
      var added = 0;
      arr.forEach(function (o) {
        if (!o.tiles || !o.tiles.length) return;
        var m = o.mines != null ? o.mines : 3;
        var key = keyOf(o.tiles);
        if (state.configs.some(function (c) {
          return keyOf(c.tiles) === key && c.mines === m;
        })) return;
        state.configs.push({
          id: uid(),
          tiles: o.tiles.slice().sort(numsort),
          mines: m,
          mult: o.mult || payoutMult(o.tiles.length, m),
          hitCount: 0,
          lastHitNonce: null,
          lastHitMult: null,
          hits: []
        });
        added++;
      });
      persist();
      render();
      flash("Imported " + added + " config(s)");
    });
  }

  function minesBreakdown() {
    var by = {};
    state.configs.forEach(function (c) {
      by[c.mines] = (by[c.mines] || 0) + 1;
    });
    var keys = Object.keys(by).map(Number).sort(function (a, b) {
      return a - b;
    });
    if (!keys.length) return "No configs saved yet";
    return "Tracking:\n" + keys.map(function (k) {
      return "• " + by[k] + " at " + k + " mines";
    }).join("\n");
  }

  // ---- sort ----
  function dryVal(c) {
    if (c.lastHitNonce == null) return 1e15;
    var d = state.nonce - c.lastHitNonce;
    return d < 0 ? 0 : d;
  }
  function viewConfigs() {
    var mode = S().sortMode;
    if (mode !== "hit" && mode !== "mult" && mode !== "dry") return state.configs;
    var mul = S().sortDir === "asc" ? -1 : 1;
    var arr = state.configs.slice();
    if (mode === "hit") arr.sort(function (a, b) {
      return mul * ((b.hitCount || 0) - (a.hitCount || 0));
    });
    else if (mode === "mult") arr.sort(function (a, b) {
      return mul * ((b.mult || 0) - (a.mult || 0));
    });
    else arr.sort(function (a, b) {
      return mul * (dryVal(b) - dryVal(a));
    });
    return arr;
  }

  // ---- rendering ----
  var root = null;
  function buildRoot() {
    root = document.createElement("div");
    root.id = "stake-mines-root";
    root.addEventListener("click", onClick);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("mouseover", onTipIn);
    root.addEventListener("mouseout", onTipOut);
    root.addEventListener("dragstart", onDragStart);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("drop", function (e) {
      e.preventDefault();
    });
    root.addEventListener("dragend", onDragEnd);
    root.addEventListener("dblclick", function (e) {
      if (e.target.closest && e.target.closest(".sm-resize")) {
        S().panelW = null;
        S().panelH = null;
        persist();
        dockLayout();
      }
    });
    document.body.appendChild(root);
    // Persistent toast — a root child so re-renders (which rebuild only the
    // panel) don't wipe it mid-flash.
    var st = document.createElement("div");
    st.id = "sm-status";
    st.className = "sm-status";
    root.appendChild(st);
  }
  var GEM_CELL =
    '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="#37d9a0" stroke="#0c3b2c" ' +
    'stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20" fill="none"/><path d="M8 9l4 12 4-12" fill="none"/></svg>';
  function cell(pick) {
    if (pick && S().gemArt !== false) return '<div class="sm-cell sm-pick sm-gem">' + GEM_CELL + "</div>";
    return '<div class="sm-cell' + (pick ? " sm-pick" : "") + '"></div>';
  }
  function miniBoard(tiles, extra) {
    var set = {};
    (tiles || []).forEach(function (f) {
      set[f] = 1;
    });
    var cells = "";
    for (var i = 0; i < GRID; i++) cells += cell(!!set[i]);
    return '<div class="sm-board ' + (extra || "") + '">' + cells + "</div>";
  }
  function dryText(c) {
    if (c.lastHitNonce == null) return "dry —";
    var d = state.nonce - c.lastHitNonce;
    return "dry " + (d < 0 ? 0 : d);
  }
  function isActive(c) {
    return selKey && keyOf(c.tiles) === selKey;
  }
  function configRow(c) {
    var hits = c.hits || [];
    var lastHit = c.lastHitNonce != null ? c.lastHitNonce : "-";
    var meta = "last hit @ nonce " + esc(lastHit);
    if (c.lastHitNonce != null && c.lastHitMult != null) meta += " · " + round2(c.lastHitMult) + "×";
    var badge = c.hitCount ? '<span class="sm-badge">' + c.hitCount + "</span>" : "";
    var caret = hits.length
      ? '<button class="sm-caret" data-act="toggle" data-id="' + c.id + '" title="Show hits">' + (c._expanded ? "▴" : "▾") + "</button>"
      : "";
    var flashC = c._flash ? " sm-flash" : "";
    var tier = c.gold ? " sm-goldhit" : c.hitCount ? " sm-green" : "";
    var hitsHtml = "";
    if (c._expanded && hits.length) {
      hitsHtml =
        '<div class="sm-hits">' +
        hits.slice().reverse().map(function (h) {
          return '<div class="sm-hit-row' + (h.bet ? " sm-hit-gold" : "") + '"><span class="sm-hit-n">nonce ' + esc(h.n) + '</span><span class="sm-hit-x">' + round2(h.mult) + "×</span></div>";
        }).join("") +
        "</div>";
    }
    return (
      '<div class="sm-config' + tier + (isActive(c) ? " sm-active" : "") + flashC + '" data-id="' + c.id +
      '" draggable="' + (S().sortMode === "manual" ? "true" : "false") + '">' +
      '<div class="sm-config-row">' +
      miniBoard(c.tiles, "sm-board-sm") +
      '<div class="sm-config-main">' +
      '<div class="sm-config-top"><span class="sm-config-mult">' + round2(c.mult) + "×</span>" +
      '<span class="sm-config-dim">' + c.tiles.length + " tiles · " + c.mines + " mines</span></div>" +
      '<div class="sm-config-meta"><span class="sm-meta-txt">' + meta + '</span><span class="sm-dry">' + dryText(c) + "</span></div>" +
      "</div>" +
      '<div class="sm-config-side">' + badge + caret +
      '<button class="sm-x" data-act="del" data-id="' + c.id + '" title="Remove">×</button></div>' +
      "</div>" +
      hitsHtml +
      "</div>"
    );
  }
  function hitFxHtml(ph) {
    return (
      '<div class="sm-hitfx"><div class="sm-hitfx-head">' +
      "<span>Hit" + (ph.items.length > 1 ? "s" : "") + " · nonce " + esc(ph.nonce) + "</span>" +
      '<button class="sm-hitfx-eye" data-act="hitfx-close" title="Dismiss">' + EYE_SVG + "</button></div>" +
      ph.items.map(function (it) {
        return (
          '<div class="sm-hitfx-row" style="border-left-color:' + it.color + '">' +
          '<span class="sm-hitfx-chip" style="background:' + it.color + ";box-shadow:0 0 10px " + it.color + '"></span>' +
          '<span class="sm-hitfx-mult">' + round2(it.mult) + "×</span>" +
          '<span class="sm-hitfx-meta">' + it.tiles + " tiles · " + it.mines + " mines</span></div>"
        );
      }).join("") +
      "</div>"
    );
  }
  function chasingText() {
    for (var i = 0; i < state.configs.length; i++) if (isActive(state.configs[i])) return round2(state.configs[i].mult) + "×";
    var m = liveMines != null ? liveMines : liveMinesCount();
    if (selection.length && m != null) return round2(payoutMult(selection.length, m)) + "×";
    return "—";
  }

  function render() {
    ensureBottomButton();
    if (!onMinesPage() || !S().open) {
      if (root) root.style.display = "none";
      closePop();
      return;
    }
    if (!root) buildRoot();
    root.style.display = "block";
    // Persistent panel child — render updates ONLY its innerHTML, so the popup
    // and confirm (separate children of root) survive re-renders, like keno.
    var panel = root.querySelector("#stake-mines-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "stake-mines-panel";
      root.insertBefore(panel, root.firstChild);
    }
    // Preserve the list scroll across the innerHTML rebuild (like keno's render).
    var prevBody = panel.querySelector(".sm-body");
    var prevScroll = prevBody ? prevBody.scrollTop : 0;

    var collapsed = !!S().collapsed;
    var m = liveMines != null ? liveMines : liveMinesCount();
    // Show only the configs saved at the CURRENT mine count — a 4-mine config
    // can't track an 11-mine round, so hide it while you're on 11 mines.
    var shownConfigs = viewConfigs();
    if (m != null) shownConfigs = shownConfigs.filter(function (c) {
      return c.mines === m;
    });
    var configsHtml = shownConfigs.length
      ? shownConfigs.map(configRow).join("")
      : state.configs.length
        ? '<div class="sm-empty">No configs saved at <b>' + (m != null ? m : "?") + " mines</b>. Select tiles &amp; Save, or change the mine count to see others.</div>"
        : '<div class="sm-empty">No configs yet. Select tiles on the board, then press <b>Save config</b>.</div>';

    var fullHtml =
      '<div class="sm-stats">' +
      '<div><span class="sm-k">Rounds tracked</span><span class="sm-v">' + state.nonce + "</span></div>" +
      '<div class="sm-cfgcard"><span class="sm-k">Configs · ' + (m != null ? m + "m" : "all") +
      ' <span class="sm-info-i" data-tip="' + esc(minesBreakdown()) + '">i</span></span><span class="sm-v">' + shownConfigs.length + "</span></div>" +
      "</div>" +
      '<div class="sm-sel-wrap"><span class="sm-k">Selection · ' + (m != null ? m : "?") +
      ' mines <span class="sm-warn" data-tip="Configs track PER MINE COUNT. A set saved at 4 mines only counts on 4-mine rounds — it won\'t hit while you play 11. Change the mine count to save or see configs for other counts.">!</span></span>' +
      (selection.length ? miniBoard(selection, "") : '<div class="sm-selnote">click tiles on the board</div>') +
      "</div>" +
      '<div class="kt-actions">' +
      '<button class="kt-primary" data-act="save">Save config</button>' +
      '<button data-act="clear">Clear configs</button>' +
      '<button data-act="reset">Reset history</button>' +
      "</div>" +
      '<div class="kt-actions kt-actions-2nd">' +
      '<button data-act="export" title="Export config sets">Export</button>' +
      '<button data-act="import" title="Import config sets">Import</button>' +
      "</div>";

    var chase = chasingText();
    // Shrink the chasing value if it'd be long enough to shove the buttons.
    var chaseSize = chase.length > 6 ? 11 : chase.length > 4 ? 12 : 14;
    var popTitle = S().mode === "float" ? "Dock to board" : "Pop out (drag anywhere)";
    panel.innerHTML =
      '<header class="sm-header">' +
      (S().hideTitle ? "" : '<span class="sm-title">Mines Tracker</span>') +
      '<span class="sm-nonce" id="sm-nn" title="Rounds tracked (current nonce)">#' + state.nonce + "</span>" +
      '<span class="kt-oracle' + (state.seeds && state.seeds[0] ? " kt-oracle-live" : "") + '" title="Seed checker">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 2a8 8 0 0 0-3.2 15.33V19a1 1 0 0 0 1 1h4.4a1 1 0 0 0 1-1v-1.67A8 8 0 0 0 12 2zm-.5 5.5a2.5 2.5 0 0 0-2.5 2.5 1 1 0 1 1-2 0 4.5 4.5 0 0 1 4.5-4.5 1 1 0 0 1 0 2zM10 21.5a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V21h-4z"/>' +
      "</svg></span>" +
      '<span class="sm-chasing" title="Multiplier you\'re chasing"><b style="font-size:' + chaseSize + 'px">' + chase + "</b></span>" +
      '<span class="sm-head-btns">' +
      '<button data-act="settingsmenu" title="Settings">⚙</button>' +
      '<button data-act="sortmenu" title="Sort configs">⇅</button>' +
      '<button data-act="collapse" title="Collapse">' + (collapsed ? "▴" : "▾") + "</button>" +
      '<button data-act="popout" title="' + popTitle + '">⤢</button>' +
      "</span></header>" +
      '<div class="sm-body">' +
      (collapsed ? "" : fullHtml) +
      '<div class="sm-config-list">' + configsHtml + "</div>" +
      "</div>" +
      (pendingHit ? hitFxHtml(pendingHit) : "") +
      '<div class="sm-resize" title="Drag to resize · double-click to reset"></div>';

    var newBody = panel.querySelector(".sm-body");
    if (newBody && prevScroll) newBody.scrollTop = prevScroll;
    state.configs.forEach(function (c) {
      c._flash = false;
    });
    dockLayout();
  }

  // Lightweight in-place update for live (autobet) results — updates the stats
  // + config list + hit card WITHOUT rebuilding the header or re-docking, so it
  // never disturbs the page scroll (keno uses refreshDynamic for the same reason).
  function refreshLive() {
    if (!root || !S().open || !onMinesPage()) return;
    var panel = root.querySelector("#stake-mines-panel");
    if (!panel) {
      render();
      return;
    }
    var m = liveMines != null ? liveMines : liveMinesCount();
    var shown = viewConfigs();
    if (m != null) shown = shown.filter(function (c) {
      return c.mines === m;
    });
    var stats = panel.querySelectorAll(".sm-stats .sm-v");
    if (stats[0]) stats[0].textContent = state.nonce;
    if (stats[1]) stats[1].textContent = shown.length;
    var nn = panel.querySelector("#sm-nn");
    if (nn) nn.textContent = "#" + state.nonce;
    var body = panel.querySelector(".sm-body");
    var scroll = body ? body.scrollTop : 0;
    var list = panel.querySelector(".sm-config-list");
    if (list) {
      list.innerHTML = shown.length
        ? shown.map(configRow).join("")
        : state.configs.length
          ? '<div class="sm-empty">No configs saved at <b>' + (m != null ? m : "?") + " mines</b>. Select tiles &amp; Save, or change the mine count to see others.</div>"
          : '<div class="sm-empty">No configs yet. Select tiles on the board, then press <b>Save config</b>.</div>';
    }
    state.configs.forEach(function (c) {
      c._flash = false;
    });
    if (body) body.scrollTop = scroll;
    var card = panel.querySelector(".sm-hitfx");
    if (pendingHit && S().notify !== false) {
      var html = hitFxHtml(pendingHit);
      if (card) {
        var tmp = document.createElement("div");
        tmp.innerHTML = html;
        card.parentNode.replaceChild(tmp.firstChild, card);
      } else {
        var resize = panel.querySelector(".sm-resize");
        if (resize) resize.insertAdjacentHTML("beforebegin", html);
      }
    } else if (card) {
      card.parentNode.removeChild(card);
    }
  }

  function onClick(e) {
    // Clicking inside the seed pop pins it (so expanding a card doesn't let a
    // stray mouseout close it) — matches keno's hover-then-pin behaviour.
    if (pop && popKind === "seed" && e.target.closest && e.target.closest("#sm-pop")) popPinned = true;
    var el = e.target.closest && e.target.closest("[data-act]");
    if (!el) return;
    switch (el.getAttribute("data-act")) {
      case "save":
        saveConfig();
        break;
      case "clear":
        clearConfigs();
        break;
      case "reset":
        resetHistory();
        break;
      case "export":
        doExport();
        break;
      case "import":
        doImport();
        break;
      case "del":
        deleteConfig(el.getAttribute("data-id"));
        break;
      case "hitfx-close":
        pendingHit = null;
        render();
        break;
      case "toggle": {
        var c = findConfig(el.getAttribute("data-id"));
        if (c) {
          c._expanded = !c._expanded;
          refreshLive();
        }
        break;
      }
      case "collapse":
        S().collapsed = !S().collapsed;
        persist();
        render();
        break;
      case "popout":
        if (S().mode !== "float") {
          // Popping OUT: freeze the current on-screen height so float doesn't
          // balloon to full — the user resizes from here manually.
          var rc = root.getBoundingClientRect();
          if (rc.height) S().panelH = Math.round(rc.height);
        }
        S().mode = S().mode === "float" ? "docked" : "float";
        if (S().mode === "float" && !S().floatPos) {
          S().floatPos = { left: Math.max(20, window.innerWidth - (S().panelW || DOCK_W) - 40), top: 90 };
        }
        persist();
        render();
        break;
      case "settingsmenu":
        openMenu("settings", el);
        break;
      case "sortmenu":
        openMenu("sort", el);
        break;
      case "orc-exp": {
        var oc = findConfig(el.getAttribute("data-id"));
        if (oc) {
          oc._orcExp = !oc._orcExp;
          reflowSeedPop();
        }
        break;
      }
      case "orc-more": {
        var mrec = state.seeds && state.seeds[0];
        if (mrec) {
          try {
            extendMinesOracle(mrec, oracleData(mrec));
          } catch (em) {}
          reflowSeedPop();
        }
        break;
      }
      case "sort":
        S().sortMode = el.getAttribute("data-mode") || "manual";
        persist();
        render();
        if (pop && popKind === "sort") pop.innerHTML = sortHtml();
        break;
      case "sortdir":
        S().sortDir = S().sortDir === "asc" ? "desc" : "asc";
        persist();
        render();
        if (pop && popKind === "sort") pop.innerHTML = sortHtml();
        break;
      case "tog":
        var key = el.getAttribute("data-tog");
        S()[key] = S()[key] === false;
        persist();
        setSwitch(el, S()[key] !== false);
        if (key === "glow" && S().glow === false) clearGlow();
        render();
        break;
    }
  }
  function toggleOpen() {
    S().open = !S().open;
    persist();
    render();
  }

  // ---- drag-to-reorder (manual sort only) — ported from keno ----
  function getDropLine() {
    if (!dropLine) {
      dropLine = document.createElement("div");
      dropLine.className = "sm-drop-line";
    }
    return dropLine;
  }
  function removeDropLine() {
    if (dropLine && dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
  }
  function onDragStart(e) {
    if (S().sortMode !== "manual") return;
    var row = e.target.closest && e.target.closest(".sm-config");
    if (!row) return;
    draggedRow = row;
    dragging = true;
    row.classList.add("sm-dragging");
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.getAttribute("data-id") || "");
    } catch (err) {}
  }
  function onDragOver(e) {
    if (!draggedRow) return;
    var list = root.querySelector(".sm-config-list");
    if (!list || !list.contains(draggedRow)) return;
    e.preventDefault();
    var rows = Array.prototype.slice.call(list.querySelectorAll(".sm-config:not(.sm-dragging)"));
    var after = null, closest = -Infinity;
    for (var i = 0; i < rows.length; i++) {
      var box = rows[i].getBoundingClientRect();
      var off = e.clientY - box.top - box.height / 2;
      if (off < 0 && off > closest) {
        closest = off;
        after = rows[i];
      }
    }
    var line = getDropLine();
    if (after) list.insertBefore(line, after);
    else list.appendChild(line);
  }
  function onDragEnd() {
    if (!draggedRow) return;
    var list = root.querySelector(".sm-config-list");
    if (list && dropLine && dropLine.parentNode === list) list.insertBefore(draggedRow, dropLine);
    removeDropLine();
    draggedRow.classList.remove("sm-dragging");
    draggedRow = null;
    dragging = false;
    if (list) {
      var order = Array.prototype.slice.call(list.querySelectorAll(".sm-config")).map(function (el) {
        return el.getAttribute("data-id");
      });
      state.configs.sort(function (a, b) {
        return order.indexOf(a.id) - order.indexOf(b.id);
      });
      persist();
    }
    refreshLive();
  }

  // ===========================================================================
  // Seed checker — replay the seed you rotated away from and show where each
  // config would have been ALL-SAFE (its tiles dodge every mine). Same honest,
  // self-verified model as the keno tracker (deterministic replay, never a live
  // prediction). Mines uses the same Stake byte→float→splice engine as keno,
  // over 25 tiles, taking the round's mine count. Verified by replaying your
  // recorded rounds; once ANY seed verifies, later ones are trusted.
  // ===========================================================================
  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function rotr(n, x) {
    return (x >>> n) | (x << (32 - n));
  }
  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var bits = l * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    m.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = (m[off + t * 4] << 24) | (m[off + t * 4 + 1] << 16) | (m[off + t * 4 + 2] << 8) | m[off + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var s0 = rotr(7, w[t - 15]) ^ rotr(18, w[t - 15]) ^ (w[t - 15] >>> 3);
        var s1 = rotr(17, w[t - 2]) ^ rotr(19, w[t - 2]) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA_K[t] + w[t]) | 0;
        var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (var i = 0; i < 8; i++) out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    return out;
  }
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else {
        i++;
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return out;
  }
  function hmacSha256(keyStr, msgStr) {
    var key = utf8Bytes(keyStr);
    if (key.length > 64) key = sha256(key);
    while (key.length < 64) key.push(0);
    var oKey = [], iKey = [];
    for (var i = 0; i < 64; i++) {
      oKey.push(key[i] ^ 0x5c);
      iKey.push(key[i] ^ 0x36);
    }
    return sha256(oKey.concat(sha256(iKey.concat(utf8Bytes(msgStr)))));
  }
  // Mine positions for (server, client, nonce, mineCount): the same float stream
  // as keno, splicing from a 25-tile pool. 0-indexed (matches state.mines).
  function minesLayout(server, client, nonce, mineCount) {
    var pool = [];
    for (var i = 0; i < GRID; i++) pool.push(i);
    var res = [], round = 0, buf = [], pos = 0;
    function nb() {
      if (pos >= buf.length) {
        buf = hmacSha256(server, client + ":" + nonce + ":" + round);
        round++;
        pos = 0;
      }
      return buf[pos++];
    }
    function nf() {
      return nb() / 256 + nb() / 65536 + nb() / 16777216 + nb() / 4294967296;
    }
    for (var d = 0; d < mineCount; d++) {
      var idx = Math.floor(nf() * pool.length);
      res.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return res;
  }
  function sortSig(arr) {
    return arr.slice().sort(function (a, b) {
      return a - b;
    }).join(",");
  }
  function recordedRounds() {
    return (state.recent || []).map(function (r) {
      return { nonce: r.n, mc: r.mc, sig: sortSig(r.mines) };
    });
  }
  function calibrateSeed(rec, samples) {
    var use = samples.slice(-24);
    var best = { ok: false, offset: 0, matched: 0, checked: use.length };
    if (!use.length) return best;
    for (var off = -2; off <= 2; off++) {
      var m = 0;
      for (var i = 0; i < use.length; i++) {
        if (sortSig(minesLayout(rec.server, rec.client, use[i].nonce + off, use[i].mc)) === use[i].sig) m++;
      }
      if (m > best.matched) best = { ok: m === use.length && m >= Math.min(4, use.length), offset: off, matched: m, checked: use.length };
    }
    return best;
  }
  function onSeedRevealed(server, client, seedHash) {
    if (!server || !client) return;
    var rec = {
      server: String(server),
      client: String(client),
      stopNonce: pendingReveal.nonce || 0, // round count reached on the retired seed
      ts: Date.now(),
      offset: 0,
      verified: false,
      trusted: false,
      matched: 0,
      checked: 0
    };
    try {
      var cal = calibrateSeed(rec, pendingReveal.rounds || []);
      rec.matched = cal.matched;
      rec.checked = cal.checked;
      rec.offset = cal.offset; // best-guess alignment even when unverified (we show it anyway)
      if (cal.checked > 0) {
        rec.verified = cal.ok;
        if (cal.ok) {
          state.algoOk = true;
          state.algoOffset = cal.offset;
        }
      } else if (state.algoOk) {
        rec.verified = true;
        rec.trusted = true;
        rec.offset = state.algoOffset || 0;
      }
    } catch (e) {}
    if (!state.seeds.length || state.seeds[0].server !== rec.server) {
      state.seeds.unshift(rec);
      if (state.seeds.length > 5) state.seeds.length = 5;
    }
    try {
      oracleData(rec); // prime the scan now (verified or not — we always show it)
    } catch (e) {}
    persist();
    render();
  }
  var oracleCache = null;
  function oracleData(rec) {
    var sig = state.configs
      .map(function (c) {
        return c.id + ":" + c.mines + ":" + (c.tiles || []).join("-");
      })
      .join("|");
    if (oracleCache && oracleCache.ts === rec.ts && oracleCache.sig === sig) return oracleCache.data;
    var data = computeMinesOracle(rec);
    oracleCache = { ts: rec.ts, sig: sig, data: data };
    return data;
  }
  var ORACLE_STEP = 20000; // nonces per pass / per "scan more"
  var ORACLE_CAP = 60; // hit nonces kept per config (shown in the expanded sequence); "scan more" gathers more up to this
  // Scan nonces [from..to] into (already-built) slots. Resumes cleanly — each
  // layout depends only on its nonce — so "scan more" continues from data.reach.
  function scanMinesOracle(rec, slots, reset, from, to) {
    var remaining = 0;
    for (var r = 0; r < slots.length; r++) if (!slots[r].done) remaining++;
    for (var nonce = from; nonce <= to && remaining > 0; nonce++) {
      for (var si = 0; si < slots.length; si++) {
        var s = slots[si];
        if (s.done) continue;
        var mines = minesLayout(rec.server, rec.client, nonce + (rec.offset || 0), s.mines);
        var safe = true;
        for (var i = 0; i < mines.length; i++) {
          if (s.set[mines[i]]) {
            safe = false;
            break;
          }
        }
        if (!safe) continue;
        if (s.nonces.length < ORACLE_CAP) s.nonces.push(nonce);
        if (s.next === null && nonce > reset) s.next = nonce;
        if (s.nonces.length >= ORACLE_CAP && s.next !== null) {
          s.done = true;
          remaining--;
        }
      }
    }
  }
  function computeMinesOracle(rec) {
    var reset = rec.stopNonce || 0;
    var slots = state.configs
      .map(function (c) {
        var set = {};
        (c.tiles || []).forEach(function (t) {
          set[t] = 1;
        });
        return { id: c.id, tiles: (c.tiles || []).slice(), mines: c.mines, mult: c.mult, set: set, nonces: [], next: null, done: false };
      })
      .filter(function (s) {
        return s.tiles.length && s.mines > 0;
      });
    scanMinesOracle(rec, slots, reset, 1, ORACLE_STEP);
    return { reset: reset, reach: ORACLE_STEP, configs: slots };
  }
  function extendMinesOracle(rec, data) {
    scanMinesOracle(rec, data.configs, data.reset, data.reach + 1, data.reach + ORACLE_STEP);
    data.reach += ORACLE_STEP;
    return data;
  }
  function oracleMinesHtml() {
    var rec = state.seeds && state.seeds[0];
    var hdr =
      '<div class="kt-orc-hdr"><span class="kt-orc-title">Seed checker</span>' +
      (rec && rec.verified ? '<span class="kt-orc-reset"><span class="kt-orc-reset-lbl">reset at nonce</span><b>#' + rec.stopNonce + "</b></span>" : "") +
      "</div>";
    if (!rec) {
      return hdr + '<div class="kt-pop-empty">Rotate your seed to reveal it. This then replays that retired seed to show where each saved config would have been all-safe.</div>';
    }
    if (!state.configs.length) {
      return hdr + '<div class="kt-pop-empty">Save a config to check it against this seed.</div>';
    }
    var data = oracleData(rec);
    var sorted = data.configs.slice().sort(function (a, b) {
      return (a.next == null ? Infinity : a.next) - (b.next == null ? Infinity : b.next);
    });
    var body = sorted
      .map(function (slot) {
        var cfg = findConfig(slot.id);
        var exp = !!(cfg && cfg._orcExp);
        var nonceEl, tillEl = "";
        if (slot.next != null) {
          nonceEl = '<b class="kt-orc-tnonce" style="color:#4ef08a">#' + slot.next.toLocaleString() + "</b>";
          tillEl = '<span class="sm-orc-till">' + (slot.next - data.reset).toLocaleString() + " bets till hit</span>";
        } else if (slot.nonces.length) {
          nonceEl = '<b class="kt-orc-tnonce" style="color:#4ef08a">#' + slot.nonces[0].toLocaleString() + "</b>";
        } else {
          nonceEl = '<span class="kt-orc-none">none in ' + data.reach.toLocaleString() + "</span>";
        }
        var seq = exp && slot.nonces.length
          ? '<div class="kt-orc-seq">' +
            slot.nonces
              .map(function (n) {
                return '<span class="kt-orc-chip' + (n <= data.reset ? " kt-orc-chip-past" : "") + '">#' + n.toLocaleString() + "</span>";
              })
              .join("") +
            "</div>"
          : "";
        return (
          '<div class="kt-orc-card' + (exp ? " kt-orc-open" : "") + '" data-act="orc-exp" data-id="' + esc(slot.id) + '">' +
          '<div class="sm-orc-main">' +
          '<div class="sm-orc-board">' + miniBoard(slot.tiles, "sm-board-sm") + "</div>" +
          '<div class="sm-orc-info">' +
          '<div class="sm-orc-line1"><span class="kt-orc-badge" style="color:#4ef08a;background:#4ef08a22">all-safe</span>' +
          (slot.mult != null ? '<span class="kt-orc-mult">' + round2(slot.mult) + "×</span>" : "") +
          "</div>" +
          nonceEl + tillEl +
          "</div>" +
          '<span class="kt-orc-caret">' + (exp ? "▾" : "▸") + "</span>" +
          "</div>" +
          seq +
          "</div>"
        );
      })
      .join("");
    var note = rec.verified ? "" : ' · <span class="kt-orc-unver" title="Not confirmed against your recorded rounds — the nonces are computed from the revealed seed but may be off if other games shared it">unverified</span>';
    var anyMore = data.configs.some(function (c) {
      return !c.done;
    });
    var more = anyMore ? '<button class="kt-orc-more" data-act="orc-more">Scan ' + ORACLE_STEP.toLocaleString() + " more</button>" : "";
    return (
      hdr +
      '<div class="kt-orc-sub">' + data.reach.toLocaleString() + " nonces scanned" + note + "</div>" +
      '<div class="kt-orc-list">' + body + "</div>" +
      more +
      '<div class="kt-pop-foot">Deterministic replay of the seed you rotated away from — not a live prediction.</div>'
    );
  }

  // ---- popups (settings + sort share #sm-pop) ----
  var pop = null, popKind = null, popPinned = false;
  function switchRow(key, label, on) {
    return (
      '<div class="kt-set-row"><span class="kt-set-label">' + label + "</span>" +
      '<button class="kt-switch' + (on ? " kt-switch-on" : "") + '" data-act="tog" data-tog="' + key +
      '" role="switch" aria-checked="' + (on ? "true" : "false") + '"><span class="kt-knob"></span></button></div>'
    );
  }
  function setSwitch(el, on) {
    el.classList.toggle("kt-switch-on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }
  function settingsHtml() {
    return (
      '<div class="kt-pop-title">Settings</div>' +
      switchRow("hideTitle", "Hide title", S().hideTitle === true) +
      switchRow("gemArt", "Gem art", S().gemArt !== false) +
      switchRow("glow", "Board glow", S().glow !== false) +
      switchRow("notify", "Hit notification", S().notify !== false) +
      switchRow("resetOnSeed", "New seed resets history", S().resetOnSeed !== false)
    );
  }
  function sortHtml() {
    var sm = S().sortMode || "manual";
    function chip(mode, label, title) {
      return '<button class="kt-win' + (sm === mode ? " kt-win-on" : "") + '" data-act="sort" data-mode="' + mode + '" title="' + title + '">' + label + "</button>";
    }
    var dir = S().sortDir || "desc";
    return (
      '<div class="kt-pop-title">Sort configs</div>' +
      '<div class="kt-pop-wins">' +
      chip("manual", "Manual", "Saved order") +
      chip("hit", "Hit", "By hit count") +
      chip("mult", "Mult", "By multiplier") +
      chip("dry", "Dry", "By longest dry streak") +
      "</div>" +
      '<div class="kt-pop-wins"><button class="kt-win" data-act="sortdir" title="Flip direction">' +
      (dir === "asc" ? "↑ Ascending" : "↓ Descending") +
      "</button></div>" +
      '<div class="kt-pop-foot">Drag-reorder works in Manual only</div>'
    );
  }
  function closePop() {
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    popKind = null;
    popPinned = false;
  }
  // Re-render the seed pop in place, preserving list scroll (expand / scan-more).
  function reflowSeedPop() {
    if (!(pop && popKind === "seed")) return;
    popPinned = true;
    var list = pop.querySelector(".kt-orc-list");
    var sc = list ? list.scrollTop : 0;
    pop.innerHTML = oracleMinesHtml();
    var nl = pop.querySelector(".kt-orc-list");
    if (nl) nl.scrollTop = sc;
  }
  function openMenu(kind, anchor) {
    if (pop && popKind === kind) {
      closePop();
      return;
    }
    closePop();
    popKind = kind;
    pop = document.createElement("div");
    pop.id = "sm-pop";
    pop.innerHTML = kind === "settings" ? settingsHtml() : kind === "seed" ? oracleMinesHtml() : sortHtml();
    if (kind === "seed") {
      pop.style.width = "344px"; // match keno's seed-checker width (.kt-pop:has(.kt-orc-list))
      pop.style.maxWidth = "344px";
    }
    root.appendChild(pop); // child of root → clicks bubble to onClick, survives render
    // Position within root, right-aligned to the trigger (keno's showPopFor).
    var rr = root.getBoundingClientRect();
    var tr = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var x = tr.right - rr.left - pw;
    var y = tr.bottom - rr.top - 2;
    x = Math.max(6, Math.min(x, rr.width - pw - 6));
    if (y + ph > rr.height - 6) y = tr.top - rr.top - ph + 2;
    y = Math.max(6, y);
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  }
  document.addEventListener("mousedown", function (e) {
    if (!pop) return;
    if (e.target.closest && (e.target.closest("#sm-pop") || e.target.closest('[data-act="settingsmenu"]') || e.target.closest('[data-act="sortmenu"]') || e.target.closest(".kt-oracle"))) return;
    closePop();
  });

  // ---- board glow (Phase 5) — cycling multi-config, ported from keno ----
  // Hit configs are grouped by shared tiles (union-find): configs that DON'T
  // overlap ring STATIC, each in its own colour (different tiles, different
  // colours, all at once). Configs that share tiles form a component and CYCLE
  // (take turns ~1.6s each) so a tile never fights two colours. Gold = bet-hit.
  var GLOW_PHASE_MS = 1600;
  var GLOW_SAFETY_MS = 12000;
  var glowComps = null;
  var glowIdx = 0;
  var glowCycleTimer = null;
  var glowSafetyT = null;
  function glowComponents(items) {
    var n = items.length;
    var parent = [];
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    var owner = {};
    for (var a = 0; a < n; a++) {
      var ts = items[a].tiles || [];
      for (var j = 0; j < ts.length; j++) {
        var k = ts[j];
        if (owner[k] != null) {
          var ra = find(owner[k]), rb = find(a);
          if (ra !== rb) parent[rb] = ra;
        } else {
          owner[k] = a;
        }
      }
    }
    var byRoot = {};
    for (var b = 0; b < n; b++) {
      var r = find(b);
      (byRoot[r] = byRoot[r] || []).push(items[b]);
    }
    var out = [];
    for (var key in byRoot) out.push(byRoot[key]);
    return out;
  }
  function unringAll() {
    var els = document.querySelectorAll("[data-sm-glow]");
    for (var i = 0; i < els.length; i++) {
      els[i].style.boxShadow = "";
      els[i].style.zIndex = "";
      els[i].removeAttribute("data-sm-glow");
    }
  }
  function paintGlowPhase() {
    unringAll();
    if (!glowComps || !glowComps.length) return;
    var colorOf = {};
    for (var c = 0; c < glowComps.length; c++) {
      var comp = glowComps[c];
      var it = comp[glowIdx % comp.length];
      (it.tiles || []).forEach(function (f) {
        colorOf[f] = it.color;
      });
    }
    for (var f in colorOf) {
      var el = tileByField(parseInt(f, 10));
      if (el) {
        el.style.boxShadow = "0 0 0 3px " + colorOf[f] + ", 0 0 16px 3px " + colorOf[f];
        el.style.zIndex = "2";
        el.setAttribute("data-sm-glow", "1");
      }
    }
  }
  function clearGlow() {
    if (glowCycleTimer) {
      clearInterval(glowCycleTimer);
      glowCycleTimer = null;
    }
    if (glowSafetyT) {
      clearTimeout(glowSafetyT);
      glowSafetyT = null;
    }
    glowComps = null;
    unringAll();
  }
  function setHitGlow(items) {
    clearGlow();
    if (S().glow === false || !onMinesPage()) return;
    var live = (items || []).filter(function (it) {
      return it && it.tiles && it.tiles.length;
    });
    if (!live.length) return;
    glowComps = glowComponents(live);
    glowIdx = 0;
    paintGlowPhase();
    var needCycle = false;
    for (var i = 0; i < glowComps.length; i++) if (glowComps[i].length > 1) needCycle = true;
    if (needCycle) {
      glowCycleTimer = setInterval(function () {
        glowIdx++;
        paintGlowPhase();
      }, GLOW_PHASE_MS);
    }
    // Primary clear is bet-start; safety so it can't linger if betting stops.
    glowSafetyT = setTimeout(clearGlow, GLOW_SAFETY_MS);
  }

  // ---------------------------------------------------------------------------
  // Docking + resize + float — ported from the Stake keno adapter.
  // ---------------------------------------------------------------------------
  function effectiveW() {
    return clamp(S().panelW || DOCK_W, MIN_W, MAX_W);
  }
  function effectiveH() {
    return S().panelH ? clamp(S().panelH, MIN_H, window.innerHeight - 24) : 0;
  }
  function rectObj(r) {
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  function stakeGameContentEl() {
    var selectors = [
      ".game-content.stake-original .content",
      ".game-content.stake-original",
      "[data-testid='game-frame'] .game-content .content",
      "[data-testid='game-frame'] .game-content",
      "[data-testid='game-active'] .game-content .content",
      "[data-testid='game-active'] .game-content",
      ".game-wrapper .game-content .content",
      ".game-wrapper .game-content",
      ".game-content"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      var r = el && rectObj(el.getBoundingClientRect());
      if (r && r.width > 300 && r.height > 250) return el;
    }
    return null;
  }
  function stakeGameLayoutEl(contentEl) {
    if (!contentEl || !contentEl.closest) return null;
    var selectors = [".game-layout", "[data-testid='game-active']", ".game-wrapper", "[data-testid='game-frame']"];
    for (var i = 0; i < selectors.length; i++) {
      var el = contentEl.closest(selectors[i]);
      var r = el && rectObj(el.getBoundingClientRect());
      if (r && r.width > 300 && r.height > 250) return el;
    }
    return null;
  }
  function dockLayout() {
    if (!root || !onMinesPage() || !S().open) return;
    var W = effectiveW();
    if (S().mode === "float") {
      if (root.parentElement !== document.body) document.body.appendChild(root);
      var pos = S().floatPos || { left: window.innerWidth - W - 40, top: 90 };
      var ftop = clamp(pos.top, 4, window.innerHeight - 60);
      var H = effectiveH();
      var maxFH = window.innerHeight - ftop - 8;
      if (H && H > maxFH) H = Math.max(MIN_H, maxFH);
      setStyle(root, {
        position: "fixed",
        left: clamp(pos.left, 4, window.innerWidth - W - 4) + "px",
        top: ftop + "px",
        right: "auto",
        width: W + "px",
        height: H ? H + "px" : "auto",
        maxHeight: H ? H + "px" : "82vh"
      });
      return;
    }
    var contentEl = stakeGameContentEl();
    var layoutEl = stakeGameLayoutEl(contentEl);
    if (contentEl && layoutEl) {
      if (root.parentElement !== layoutEl) layoutEl.appendChild(root);
      try {
        if (getComputedStyle(layoutEl).position === "static") layoutEl.style.position = "relative";
      } catch (e) {}
      var contentRect = rectObj(contentEl.getBoundingClientRect());
      var layoutRect = rectObj(layoutEl.getBoundingClientRect());
      if (!contentRect || !layoutRect) return;
      var margin = 8;
      var leftInLayout = contentRect.right - layoutRect.left + 12;
      var maxLeft = window.innerWidth - margin - W - layoutRect.left;
      if (leftInLayout > maxLeft) leftInLayout = maxLeft;
      if (leftInLayout < margin - layoutRect.left) leftInLayout = margin - layoutRect.left;
      var oh = effectiveH();
      var dockH = oh || contentRect.height;
      // Keno's exact clamp: a USER-RESIZED height must keep the bottom on
      // screen (the dock is absolute in the page and scrolls with it). The
      // default (unresized) height tracks the board and scrolls with it.
      if (oh) {
        var maxDockH = window.innerHeight - Math.max(contentRect.top, 8) - 8;
        if (dockH > maxDockH) dockH = Math.max(MIN_H, maxDockH);
      }
      setStyle(root, {
        position: "absolute",
        left: leftInLayout + "px",
        top: contentRect.top - layoutRect.top + "px",
        right: "auto",
        width: W + "px",
        height: dockH + "px",
        maxHeight: dockH + "px"
      });
      return;
    }
    if (root.parentElement !== document.body) document.body.appendChild(root);
    var tiles = tileButtons();
    if (!tiles.length) return;
    var l = 1e9, t = 1e9, rr = -1e9, b = -1e9;
    Array.prototype.forEach.call(tiles, function (el) {
      var q = el.getBoundingClientRect();
      if (!q.width) return;
      l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom);
    });
    if (rr < 0) return;
    var left = rr + 12;
    if (left + W > window.innerWidth - 6) left = l - W - 12;
    if (left < 6) left = 6;
    setStyle(root, {
      position: "fixed",
      left: Math.round(left) + "px",
      top: Math.round(Math.max(6, t)) + "px",
      right: "auto",
      width: W + "px",
      height: (effectiveH() || Math.round(b - t)) + "px",
      maxHeight: (effectiveH() || Math.round(b - t)) + "px"
    });
  }

  var drag = null;
  function onPointerDown(e) {
    if (e.detail >= 2) return; // second click of a double-click → let dblclick reset, don't start a resize
    var rz = e.target.closest && e.target.closest(".sm-resize");
    if (rz) {
      var r = root.getBoundingClientRect();
      drag = { type: "resize", x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      e.preventDefault();
      bindDrag();
      return;
    }
    if (S().mode === "float") {
      var hd = e.target.closest && e.target.closest(".sm-header");
      if (hd && !(e.target.closest && e.target.closest("button"))) {
        var rc = root.getBoundingClientRect();
        drag = { type: "move", x: e.clientX, y: e.clientY, left: rc.left, top: rc.top };
        e.preventDefault();
        bindDrag();
      }
    }
  }
  function onDragMove(e) {
    if (!drag) return;
    if (drag.type === "resize") {
      S().panelW = clamp(Math.round(drag.w + (drag.x - e.clientX)), MIN_W, MAX_W);
      S().panelH = clamp(Math.round(drag.h + (e.clientY - drag.y)), MIN_H, window.innerHeight - 24);
      dockLayout();
    } else {
      S().floatPos = { left: Math.round(drag.left + (e.clientX - drag.x)), top: Math.round(drag.top + (e.clientY - drag.y)) };
      dockLayout();
    }
  }
  function bindDrag() {
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", endDrag);
  }
  function endDrag() {
    if (drag) persist();
    drag = null;
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", endDrag);
  }

  // ---------------------------------------------------------------------------
  // Footer toolbar gem — ported from the Stake keno adapter.
  // ---------------------------------------------------------------------------
  function styleToggle(btn, ref) {
    var color = "var(--ds-color-subtle-on-surface)";
    var radius = "4px", w = 52, h = 46;
    if (ref) {
      var cs = getComputedStyle(ref);
      var r = ref.getBoundingClientRect();
      color = cs.color;
      radius = cs.borderRadius;
      if (r.width) w = Math.round(r.width);
      if (r.height) h = Math.round(r.height);
    }
    btn.className = "";
    btn.style.cssText =
      "box-sizing:border-box;margin:0;padding:0;border:0;outline:none;cursor:pointer;" +
      "background:transparent;display:inline-flex;align-items:center;justify-content:center;" +
      "width:" + w + "px;height:" + h + "px;border-radius:" + radius + ";color:" + color + ";";
    btn.setAttribute("data-rest-color", color);
  }
  function ensureToggleStyle() {
    if (document.getElementById("sm-toggle-style")) return;
    var st = document.createElement("style");
    st.id = "sm-toggle-style";
    st.textContent = "#sm-bottom-toggle:hover{color:var(--ds-color-on-surface)!important}";
    (document.head || document.documentElement).appendChild(st);
  }
  function makeToggleBtn(ref) {
    var btn = document.createElement("button");
    btn.id = "sm-bottom-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Mines Tracker");
    styleToggle(btn, ref);
    btn.innerHTML = TOGGLE_SVG;
    btn.addEventListener("mouseover", function (e) {
      e.stopPropagation();
    });
    btn.addEventListener("mouseout", function (e) {
      e.stopPropagation();
    });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleOpen();
    });
    return btn;
  }
  function footerIconBtn() {
    var btns = document.querySelectorAll(".game-footer button, [data-testid='game-frame'] button");
    var last = null;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === "sm-bottom-toggle") continue;
      if ((b.textContent || "").trim()) continue;
      if (!b.querySelector("svg")) continue;
      var r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 80) last = b;
    }
    return last;
  }
  function measureIconGap(group) {
    var all = group.querySelectorAll("button");
    var icons = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.id === "sm-bottom-toggle") continue;
      if ((b.textContent || "").trim()) continue;
      if (!b.querySelector("svg")) continue;
      icons.push(b);
    }
    if (icons.length < 2) return null;
    var a = icons[icons.length - 2].getBoundingClientRect();
    var c = icons[icons.length - 1].getBoundingClientRect();
    var g = c.left - a.right;
    return g > -20 && g < 80 ? g : null;
  }
  function setToggleActive(btn) {
    var rest = btn.getAttribute("data-rest-color") || "";
    btn.style.color = S().open ? "var(--ds-color-on-surface)" : rest;
  }
  function ensureBottomButton() {
    try {
      var btn = document.getElementById("sm-bottom-toggle");
      if (!onMinesPage()) {
        if (btn) btn.style.display = "none";
        return;
      }
      var ref = footerIconBtn();
      if (ref && ref.parentNode && ref.parentNode.parentNode) {
        var group = ref.parentNode;
        var host = group.parentNode;
        ensureToggleStyle();
        if (!btn || btn.style.position === "fixed") {
          if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          btn = makeToggleBtn(ref);
        }
        setToggleActive(btn);
        btn.style.display = "";
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        if (btn.parentNode !== host) host.appendChild(btn);
        var gap = measureIconGap(group);
        if (gap == null) gap = 0;
        btn.style.position = "absolute";
        btn.style.transform = "";
        btn.style.marginLeft = "";
        btn.style.left = "0px";
        btn.style.top = "0px";
        var rr = ref.getBoundingClientRect();
        var a = btn.getBoundingClientRect();
        btn.style.left = rr.right + gap - a.left + "px";
        btn.style.top = rr.top + (rr.height - a.height) / 2 - a.top + 3 + "px";
        return;
      }
      if (!btn) {
        btn = makeToggleBtn(null);
        btn.style.position = "fixed";
        btn.style.right = "14px";
        btn.style.bottom = "14px";
        btn.style.zIndex = "2147483647";
        btn.style.background = "rgba(15,33,46,0.92)";
        document.body.appendChild(btn);
      }
      setToggleActive(btn);
      btn.style.display = "";
    } catch (e) {}
  }

  // ---- dialogs (markup + classes copied from the keno tracker's ktConfirm) ----
  function smConfirm(msg, onYes) {
    if (!root) return;
    var ov = document.createElement("div");
    ov.className = "sm-confirm";
    ov.innerHTML =
      '<div class="sm-confirm-card"><div class="sm-confirm-msg">' + esc(msg) + "</div>" +
      '<div class="sm-confirm-btns"><button class="sm-confirm-no">Cancel</button>' +
      '<button class="sm-confirm-yes">Confirm</button></div></div>';
    root.appendChild(ov); // overlays the panel (position:absolute), like keno
    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ov.addEventListener("click", function (e) {
      if (e.target.closest(".sm-confirm-yes")) {
        close();
        onYes();
      } else if (e.target.closest(".sm-confirm-no") || e.target === ov) {
        close();
      }
    });
  }
  function smPrompt(title, val, readonly, onSubmit) {
    var ov = document.createElement("div");
    ov.className = "sm-confirm";
    ov.innerHTML =
      '<div class="sm-confirm-card"><div class="sm-confirm-msg">' + esc(title) + "</div>" +
      '<textarea class="sm-confirm-input" spellcheck="false"' + (readonly ? " readonly" : "") +
      ' placeholder="Paste the exported JSON here…">' + esc(val) + "</textarea>" +
      '<div class="sm-confirm-btns"><button class="sm-confirm-no">Close</button>' +
      '<button class="sm-confirm-yes">' + (readonly ? "Copy" : "Import") + "</button></div></div>";
    root.appendChild(ov);
    var ta = ov.querySelector("textarea");
    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ta.focus();
    if (readonly) ta.select();
    ov.addEventListener("click", function (e) {
      if (e.target.closest(".sm-confirm-yes")) {
        if (readonly) {
          try {
            navigator.clipboard.writeText(val);
          } catch (x) {
            ta.select();
            try {
              document.execCommand("copy");
            } catch (y) {}
          }
          flash("Copied");
        } else {
          var v = ta.value;
          close();
          if (onSubmit) onSubmit(v);
        }
      } else if (e.target.closest(".sm-confirm-no") || e.target === ov) {
        close();
      }
    });
  }

  // ---- hover tooltip box (warning / info icons carry data-tip) ----
  var tipEl = null;
  function showTip(anchor) {
    var text = anchor.getAttribute("data-tip");
    if (!text) return;
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "sm-tip";
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.style.display = "block";
    var r = anchor.getBoundingClientRect();
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = r.top - h - 6;
    tipEl.style.left = Math.round(left) + "px";
    tipEl.style.top = Math.round(Math.max(6, top)) + "px";
  }
  function hideTip() {
    if (tipEl) tipEl.style.display = "none";
  }
  function onTipIn(e) {
    // Seed checker opens on HOVER (matches keno).
    var orc = e.target.closest && e.target.closest(".kt-oracle");
    if (orc) {
      if (!(pop && popKind === "seed")) openMenu("seed", orc);
      return;
    }
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (t) showTip(t);
  }
  function onTipOut(e) {
    // Keep the seed pop while the cursor is on the icon or inside the pop
    // (it's interactive — expand chips live there); click-in pins it.
    var from = e.target.closest && e.target.closest(".kt-oracle, #sm-pop");
    if (from && pop && popKind === "seed") {
      var to = e.relatedTarget;
      if (to && to.closest && (to.closest(".kt-oracle") || to.closest("#sm-pop"))) return;
      if (!popPinned) closePop();
      return;
    }
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) return;
    var to2 = e.relatedTarget;
    if (!(to2 && to2.closest && to2.closest("[data-tip]") === t)) hideTip();
  }

  // ---- toast ----
  var statusT = null;
  function flash(msg) {
    var st = root && root.querySelector("#sm-status");
    if (!st) return;
    st.textContent = msg;
    st.classList.add("sm-status-on");
    clearTimeout(statusT);
    statusT = setTimeout(function () {
      st.classList.remove("sm-status-on");
    }, 1800);
  }

  // ---- selection polling ----
  function pollSelection() {
    if (!onMinesPage() || dragging) return;
    var mc = liveMinesCount();
    var minesChanged = mc != null && mc !== liveMines;
    if (mc != null) liveMines = mc;
    var sel = readSelection();
    var k = keyOf(sel);
    var selChanged = k !== selKey;
    if (selChanged) {
      selection = sel;
      selKey = k;
    }
    if ((selChanged || minesChanged) && S().open) render();
  }

  document.addEventListener("__sm_net", function (e) {
    if (!onMinesPage()) return;
    handleNet(e && e.detail);
  });
  document.addEventListener("__sm_seed_reset", function (e) {
    onSeedReset(e && e.detail);
  });
  document.addEventListener("__sm_seed_plain", function (e) {
    try {
      var d = JSON.parse(e && e.detail);
      if (d && d.server && d.client) onSeedRevealed(d.server, d.client, d.seedHash);
    } catch (err) {}
  });
  document.addEventListener("keydown", function (e) {
    if (!onMinesPage()) return;
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (!S().open) {
        S().open = true;
        persist();
        render();
      }
      saveConfig();
    }
  });
  document.addEventListener("__sm_nav", function () {
    setTimeout(render, 80);
  });
  window.addEventListener("scroll", dockLayout, true);
  window.addEventListener("resize", dockLayout);

  function init() {
    load(function () {
      liveMines = liveMinesCount();
      selection = readSelection();
      selKey = keyOf(selection);
      render();
      setInterval(pollSelection, 350);
      setInterval(function () {
        dockLayout();
        ensureBottomButton();
      }, 600);
      log("Phase 4+5 · configs", state.configs.length, "· rounds", state.nonce);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
