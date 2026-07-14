/*
 * Winna Mines Calculator — content script (ISOLATED world). WINNA ONLY.
 *
 * A what-if payout calculator for Winna Mines. Mines is provably-fair with a
 * DETERMINISTIC payout table, so we don't track draws or count nonces — we just
 * compute. Pick grid size, mines, and gems (or let the live board drive them)
 * and it shows the cashout multiplier, win chance, and payout from the bet.
 *
 * Math — verified against Winna's own ladder (25-grid, 3-mines shows
 * 1.1136 / 1.2727 / 1.4636 / 1.6947):
 *     mult(grid, mines, gems) = HOUSE * Π_{i=0..gems-1} (grid - i)/(grid - mines - i)
 *     winChance = HOUSE / mult   (probability of revealing `gems` safe tiles in a row)
 *   HOUSE = 0.98 (a flat 2% house edge — solved from the ladder above).
 *
 * Board sync: the grid's tiles carry classes — idle "mine grey", autoplay pick
 * "mine autoBetPick", manual revealed-safe "mine selected mines-0", a mine
 * "mine mines-1". The reader counts them to drive grid (tile count), gems
 * (picked tiles) and mines (revealed mines), so selecting tiles on the board
 * updates the calculator live.
 *
 * Cross-frame: the game (board + Bet Amount) lives in the games.winna.com
 * iframe (oversized/clipped), so — exactly like keno/plinko here — the panel
 * docks/floats on the TOP page while a reader in the iframe relays bet + board
 * over chrome.storage (never postMessage — winna logs foreign messages). Fully
 * namespaced (guard __minesCalcContentLoaded, root #mines-calc-root, classes
 * mc-*, storage minesCalcState + minesCalcBridge) so it can't collide with the
 * keno/plinko scripts that also run on every winna page.
 */
(function () {
  "use strict";
  if (window.__minesCalcContentLoaded) return;
  window.__minesCalcContentLoaded = true;

  var STORAGE_KEY = "minesCalcState";
  var BRIDGE_KEY = "minesCalcBridge";
  var NET_EVT = "__mc_net"; // mines-net-hook.js (MAIN world) forwards play/turn/finish
  var HOUSE = 0.98; // 2% house edge
  var GRIDS = [25, 36, 49, 64];
  var DOCK_W = 320; // match the keno/plinko panel width

  var DEFAULTS = {
    settings: {
      open: true,
      collapsed: false,
      mode: "docked", // "docked" | "float"
      floatPos: null,
      panelW: null,
      panelH: null
    },
    grid: 25,
    mines: 3,
    gems: 1,
    bet: "", // manual override; "" = follow the page Bet Amount
    showTable: false
  };

  var state = clone(DEFAULTS);
  var ROLE = "none"; // reader | panel | combined | none
  var root = null;
  var pageBet = null; // numeric bet read from the page (combined) or relayed (panel)
  var pageCurrency = "$"; // currency symbol from the page (.currency), relayed
  var panelContentFrac = null; // where the game content ends (for docked height)
  var saveTimer = null;
  var betInput = null; // cached page Bet Amount input (reader/combined)
  // Authoritative config from the network (reader/combined), since the DOM
  // can't reveal the mine count during play. Persists across the round.
  var netMines = null;
  var netGrid = null;
  var netGems = null;
  // Panel-side "follow the board on change" trackers.
  var lastBoardGrid = null;
  var lastBoardGems = null;
  var lastBoardMines = null;
  var lastToggleSeq = 0;

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function load(cb) {
    try {
      chrome.storage.local.get(STORAGE_KEY, function (res) {
        var s = res && res[STORAGE_KEY];
        if (s) {
          state.settings = Object.assign({}, DEFAULTS.settings, s.settings || {});
          if (typeof s.grid === "number") state.grid = s.grid;
          if (typeof s.mines === "number") state.mines = s.mines;
          if (typeof s.gems === "number") state.gems = s.gems;
          if (typeof s.bet === "string") state.bet = s.bet;
          if (typeof s.showTable === "boolean") state.showTable = s.showTable;
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
        var o = {};
        o[STORAGE_KEY] = state;
        chrome.storage.local.set(o);
      } catch (e) {}
    }, 150);
  }

  // ---------------------------------------------------------------------------
  // Math + formatting
  // ---------------------------------------------------------------------------
  function calc(grid, mines, gems) {
    var safe = grid - mines;
    if (mines < 1 || mines > grid - 1) return null;
    if (gems < 1 || gems > safe) return null;
    var p = 1; // probability of revealing `gems` safe tiles consecutively
    for (var i = 0; i < gems; i++) p *= (safe - i) / (grid - i);
    return { mult: HOUSE / p, prob: p };
  }
  function trimZeros(s) {
    if (s.indexOf(".") === -1) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }
  function fmtMult(m) {
    if (!isFinite(m)) return "—";
    if (m < 100) return m.toFixed(4); // matches winna's 4-decimal ladder
    if (m < 100000) return trimZeros(m.toFixed(2));
    return Math.round(m).toLocaleString("en-US");
  }
  function fmtPct(p) {
    var v = p * 100;
    if (v >= 1) return v.toFixed(2) + "%";
    if (v >= 0.01) return v.toFixed(3) + "%";
    if (v > 0) return v.toPrecision(2) + "%";
    return "0%";
  }
  function fmt1inN(p) {
    if (!(p > 0)) return "—";
    return Math.ceil(1 / p).toLocaleString("en-US"); // round up: 1.73 → 2, 3.1 → 4
  }
  function fmtMoney(v) {
    if (!isFinite(v)) return "—";
    if (v === 0) return "0";
    if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (v >= 1) return trimZeros(v.toFixed(4));
    return trimZeros(v.toFixed(8));
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function effectiveBet() {
    if (state.bet !== "" && state.bet != null) {
      var n = parseFloat(state.bet);
      return isFinite(n) ? n : 0;
    }
    return pageBet != null ? pageBet : 0;
  }
  function clampSelection() {
    if (GRIDS.indexOf(state.grid) === -1) state.grid = nearestGrid(state.grid);
    if (state.mines < 1) state.mines = 1;
    if (state.mines > state.grid - 1) state.mines = state.grid - 1;
    var safe = state.grid - state.mines;
    if (state.gems < 1) state.gems = 1;
    if (state.gems > safe) state.gems = safe;
  }
  function nearestGrid(n) {
    var best = GRIDS[0];
    var bd = Infinity;
    for (var i = 0; i < GRIDS.length; i++) {
      var d = Math.abs(GRIDS[i] - n);
      if (d < bd) {
        bd = d;
        best = GRIDS[i];
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Reading the page (reader / combined frame)
  // ---------------------------------------------------------------------------
  function findBetInput() {
    var labels = document.querySelectorAll("label, span, div, p");
    for (var i = 0; i < labels.length; i++) {
      var t = (labels[i].textContent || "").trim();
      if (/^bet amount$/i.test(t) || /^bet$/i.test(t)) {
        var box = labels[i].parentElement;
        for (var up = 0; up < 4 && box; up++) {
          var inp = box.querySelector("input");
          if (inp) return inp;
          box = box.parentElement;
        }
      }
    }
    var inputs = document.querySelectorAll("input");
    for (var j = 0; j < inputs.length; j++) {
      var v = (inputs[j].value || "").trim();
      if (v && /^\$?\s*[\d,]*\.?\d+$/.test(v)) return inputs[j];
    }
    return null;
  }
  function readPageBet() {
    if (!betInput || !document.contains(betInput)) betInput = findBetInput();
    if (!betInput) return null;
    var v = (betInput.value || "").replace(/[$,\s]/g, "");
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  // The page shows the active currency symbol in <span class="currency">; read
  // it so the payout follows the user's currency ($, €, …) instead of a
  // hardcoded $.
  function readCurrency() {
    var el = document.querySelector(".currency");
    if (el) {
      var t = (el.textContent || "").trim();
      if (t) return t;
    }
    return null;
  }

  // The player's gem count = ONLY their own tiles — picks placed
  // (`autoBetPick`) plus safe tiles THEY revealed (`selected`, not a mine).
  // The end-of-round reveal flips EVERY tile (a 25-grid/20-mines bust shows all
  // 5 diamonds + 20 bombs), but those un-picked tiles carry neither
  // `autoBetPick` nor `selected`, so excluding them is what stops the count
  // jumping to gridSize-mines.
  // While you're PICKING (no revealed tiles on the board) the count tracks
  // engaged tiles EXACTLY, so deselecting a pick lowers it (and an empty board
  // is 0). Once a RESULT is on the board we hold the round's PEAK instead, so
  // the full reveal and shed pick-markers / the hit mine can't inflate or drop
  // it through the reveal animation.
  // Tile classes: idle "mine grey", autoplay pick "mine autoBetPick", a
  // revealed-safe tile "mine selected mines-0", a mine "mine mines-1".
  var heldGems = 0;
  function readBoard() {
    var tiles = document.querySelectorAll(".mine");
    if (!tiles.length) return null;
    var engaged = 0; // your tiles: unrevealed picks + safe tiles you revealed
    var revealedAny = 0; // any flipped tile, incl. the un-picked full reveal
    var revealedMines = 0;
    for (var i = 0; i < tiles.length; i++) {
      var cl = tiles[i].classList;
      var isMine = cl.contains("mines-1");
      if (isMine) revealedMines++;
      if (isMine || cl.contains("mines-0")) revealedAny++;
      if (cl.contains("autoBetPick") || (cl.contains("selected") && !isMine)) engaged++;
    }
    if (revealedAny === 0)
      heldGems = engaged; // picking/idle: track exactly (deselect lowers it)
    else heldGems = Math.max(heldGems, engaged); // result showing: hold the peak
    return {
      grid: nearestGrid(tiles.length),
      gems: heldGems,
      mines: revealedMines > 0 ? revealedMines : null // hidden until mines show
    };
  }
  // Pull mines/gridSize/choices out of a play|turn|finish response (the data
  // sits under `data`, but walk just in case). Authoritative mine count.
  function parseMinesResp(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (typeof node.gridSize === "number" && typeof node.mines === "number") {
      return {
        grid: nearestGrid(node.gridSize),
        mines: node.mines,
        gems: Array.isArray(node.choices) ? node.choices.length : null
      };
    }
    for (var k in node) {
      if (node.hasOwnProperty(k) && node[k] && typeof node[k] === "object") {
        var r = parseMinesResp(node[k], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  function onNetEvent(e) {
    try {
      var text = e && e.detail;
      if (typeof text !== "string" || text.length > 2000000) return;
      var r = parseMinesResp(JSON.parse(text));
      if (!r) return; // not a mines response (keno/plinko /play etc.)
      netMines = r.mines;
      netGrid = r.grid;
      netGems = r.gems;
    } catch (err) {}
  }

  // The mine count is set with a range slider (max = gridSize-1, i.e. 24/35/
  // 48/63) — the live source during configuration AND play, before any
  // network response exists. Read it as the primary mines value.
  function readMinesSlider(grid) {
    var sliders = document.querySelectorAll('input[type="range"]');
    for (var i = 0; i < sliders.length; i++) {
      var s = sliders[i];
      var max = parseInt(s.max, 10);
      var val = parseInt(s.value, 10);
      if (!isFinite(max) || !isFinite(val) || val < 1) continue;
      if (max === 24 || max === 35 || max === 48 || max === 63 || (grid && max === grid - 1)) {
        return val;
      }
    }
    return null;
  }

  // Merge the live mine count (slider, then network, then revealed mines) with
  // the live grid (network/DOM tile count) and live gems (DOM picks; the
  // network's choices.length as a fallback). Mines can't be read from the
  // tiles during play (they're hidden), so the slider/network carry it.
  function composeBoard() {
    var b = readBoard(); // {grid, gems, mines:(revealed mines-1 | null)} | null
    // Grid from the LIVE tiles first — they always reflect the CURRENT grid, so
    // changing the real grid after a bet is followed. netGrid is only a fallback
    // for when no tiles are present: it's the last PLAYED grid and goes stale,
    // and used to override the DOM and freeze the calc's grid after the 1st bet.
    var grid = b && b.grid != null ? b.grid : netGrid;
    var slider = readMinesSlider(grid);
    var mines = slider != null ? slider : netMines != null ? netMines : b && b.mines ? b.mines : null;
    var domGems = b ? b.gems : 0;
    var gems = domGems > 0 ? domGems : netGems != null ? netGems : domGems;
    if (grid == null && mines == null && gems === 0) return null;
    return { grid: grid, gems: gems, mines: mines };
  }

  function readContentFrac() {
    var vh = window.innerHeight || 1;
    // Measure the game CONTENT container (like keno/plinko) so the docked panel
    // gets the same height as those panels — not just the tile grid, which is
    // shorter than the game card and left the calculator stubby.
    var gc =
      document.querySelector(".game-content-mines") ||
      document.querySelector(".game-container") ||
      document.querySelector(".game-content");
    if (gc) {
      var gr = gc.getBoundingClientRect();
      if (gr.height > 0) return Math.max(0.3, Math.min(1, gr.bottom / vh));
    }
    var tiles = document.querySelectorAll(".mine");
    if (!tiles.length) return null;
    var maxB = 0;
    for (var i = 0; i < tiles.length; i++) {
      var r = tiles[i].getBoundingClientRect();
      if (r.bottom > maxB) maxB = r.bottom;
    }
    return Math.max(0.3, Math.min(1, (maxB + 14) / vh));
  }

  function hasMinesDom() {
    return !!(
      document.querySelector(".mine") ||
      document.querySelector(".mines-history, .mines-history-container") ||
      (isGameHost() && /mines/i.test(location.pathname + location.search))
    );
  }
  function isGameHost() {
    return /(^|\.)games\.winna\.com$/i.test(location.hostname);
  }
  function minesActive() {
    return /mines/i.test(location.pathname) || hasMinesDom();
  }

  // ---------------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------------
  function buildShell() {
    root = document.createElement("div");
    root.id = "mines-calc-root";
    document.body.appendChild(root);
    root.addEventListener("click", onPanelClick);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("input", onPanelInput);
    root.addEventListener("change", onPanelInput);
    render();
  }

  function chipsHtml() {
    var h = "";
    for (var i = 0; i < GRIDS.length; i++) {
      h +=
        '<button class="mc-chip' +
        (GRIDS[i] === state.grid ? " on" : "") +
        '" data-grid="' +
        GRIDS[i] +
        '">' +
        GRIDS[i] +
        "</button>";
    }
    return h;
  }

  function fullHtml() {
    return (
      '<div class="mc-block"><div class="mc-label">Grid size</div>' +
      '<div class="mc-chips">' +
      chipsHtml() +
      "</div></div>" +
      '<div class="mc-two">' +
      '<div class="mc-fieldcol"><div class="mc-label">Mines</div><div class="mc-step">' +
      '<button class="mc-stepbtn" data-act="mines-">&#8722;</button>' +
      '<input class="mc-num" data-fld="mines" inputmode="numeric" value="' +
      state.mines +
      '">' +
      '<button class="mc-stepbtn" data-act="mines+">+</button></div></div>' +
      '<div class="mc-fieldcol"><div class="mc-label">Gems</div><div class="mc-step">' +
      '<button class="mc-stepbtn" data-act="gems-">&#8722;</button>' +
      '<input class="mc-num" data-fld="gems" inputmode="numeric" value="' +
      state.gems +
      '">' +
      '<button class="mc-stepbtn" data-act="gems+">+</button></div></div>' +
      "</div>" +
      resultHtml(false) +
      '<div class="mc-betblock">' +
      '<div class="mc-bethead"><span class="mc-label">Bet</span><span class="mc-betnote"></span></div>' +
      '<input class="mc-bet" data-fld="bet" placeholder="auto" value="' +
      esc(state.bet) +
      '"></div>' +
      '<button class="mc-tabletoggle" data-act="table"></button>' +
      '<div class="mc-table"></div>'
    );
  }

  function resultHtml(compact) {
    return (
      '<div class="mc-result">' +
      '<div class="mc-multbox"><span class="mc-mult"></span></div>' +
      '<div class="mc-stats">' +
      '<div class="mc-stat"><span>Hit probability</span><b class="mc-chance"></b></div>' +
      (compact ? "" : '<div class="mc-stat"><span>Odds</span><b class="mc-odds"></b></div>') +
      '<div class="mc-stat mc-payrow"><span>Payout</span><b class="mc-pay"></b></div>' +
      "</div></div>"
    );
  }

  function render() {
    if (!root) return;
    var s = state.settings;
    if (!s.open) {
      root.className = "mc-closed";
      root.removeAttribute("style");
      root.innerHTML = "";
      return;
    }
    clampSelection();
    var collapsed = !!s.collapsed;
    root.className =
      (s.mode === "float" ? "mc-open mc-float" : "mc-open mc-docked") + (collapsed ? " mc-collapsed" : "");
    var popTitle = s.mode === "float" ? "Dock to board" : "Pop out (drag anywhere)";
    var collapseTitle = collapsed ? "Expand" : "Collapse";

    root.innerHTML =
      '<div id="mines-calc-panel">' +
      '<header class="mc-header">' +
      '<span class="mc-title">Mines Calculator</span>' +
      '<span class="mc-head-btns">' +
      '<button data-act="collapse" title="' +
      collapseTitle +
      '">' +
      (collapsed ? "&#9652;" : "&#9662;") +
      "</button>" +
      '<button data-act="popout" title="' +
      popTitle +
      '">&#10530;</button>' +
      "</span></header>" +
      '<div class="mc-body">' +
      (collapsed ? resultHtml(true) : fullHtml()) +
      "</div>" +
      '<div class="mc-resize" title="Drag to resize · double-click to reset"></div>' +
      "</div>";

    refresh();
    layout();
  }

  // Update dynamic values without rebuilding inputs (preserves focus/caret).
  function refresh() {
    if (!root || !state.settings.open) return;
    clampSelection();
    // Grid chips
    var chips = root.querySelectorAll(".mc-chip");
    for (var i = 0; i < chips.length; i++) {
      var on = parseInt(chips[i].getAttribute("data-grid"), 10) === state.grid;
      chips[i].classList.toggle("on", on);
    }
    // Steppers (don't clobber a field the user is editing)
    var mi = root.querySelector('[data-fld="mines"]');
    if (mi && document.activeElement !== mi) mi.value = state.mines;
    var gi = root.querySelector('[data-fld="gems"]');
    if (gi && document.activeElement !== gi) gi.value = state.gems;
    var bi = root.querySelector(".mc-bet");
    if (bi) {
      if (document.activeElement !== bi) bi.value = state.bet;
      bi.placeholder = pageBet != null ? fmtMoney(pageBet) : "enter bet";
    }
    var toggle = root.querySelector(".mc-tabletoggle");
    if (toggle)
      toggle.innerHTML =
        (state.showTable ? "Hide" : "Show") + " full ladder " + (state.showTable ? "&#9652;" : "&#9662;");
    renderResult();
    renderTable();
  }

  function renderResult() {
    if (!root) return;
    var r = calc(state.grid, state.mines, state.gems);
    var bet = effectiveBet();
    setText(".mc-mult", r ? fmtMult(r.mult) + "×" : "—");
    setText(".mc-chance", r ? fmtPct(r.prob) : "—");
    setText(".mc-odds", r ? "1 in " + fmt1inN(r.prob) : "—");
    setText(".mc-pay", r && bet > 0 ? pageCurrency + fmtMoney(bet * r.mult) : "—");
    var note = root.querySelector(".mc-betnote");
    if (note) {
      if (state.bet !== "" && state.bet != null) note.textContent = "manual";
      else if (pageBet != null) note.textContent = "from page";
      else note.textContent = "";
    }
  }
  function setText(sel, txt) {
    var el = root.querySelector(sel);
    if (el) el.textContent = txt;
  }

  function renderTable() {
    if (!root) return;
    var wrap = root.querySelector(".mc-table");
    if (!wrap) return;
    if (!state.showTable) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }
    wrap.style.display = "";
    var safe = state.grid - state.mines;
    var bet = effectiveBet();
    var rows =
      '<div class="mc-trow mc-thead"><span>Gems</span><span>Mult</span><span>Chance</span><span>Payout</span></div>';
    for (var g = 1; g <= safe; g++) {
      var r = calc(state.grid, state.mines, g);
      if (!r) continue;
      rows +=
        '<div class="mc-trow' +
        (g === state.gems ? " on" : "") +
        '" data-act="gemrow" data-gems="' +
        g +
        '"><span>' +
        g +
        "</span><span>" +
        fmtMult(r.mult) +
        "×</span><span>" +
        fmtPct(r.prob) +
        "</span><span>" +
        (bet > 0 ? pageCurrency + fmtMoney(bet * r.mult) : "—") +
        "</span></div>";
    }
    wrap.innerHTML = rows;
  }

  function onPanelClick(e) {
    var t = e.target.closest("[data-act], [data-grid]");
    if (!t) return;
    if (t.hasAttribute("data-grid")) {
      state.grid = parseInt(t.getAttribute("data-grid"), 10);
      clampSelection();
      persist();
      refresh();
      return;
    }
    var act = t.getAttribute("data-act");
    if (act === "collapse") {
      state.settings.collapsed = !state.settings.collapsed;
      persist();
      render();
    } else if (act === "popout") {
      state.settings.mode = state.settings.mode === "float" ? "docked" : "float";
      if (state.settings.mode === "float" && !state.settings.floatPos) {
        state.settings.floatPos = { left: window.innerWidth - DOCK_W - 40, top: 120 };
      }
      persist();
      render();
    } else if (act === "mines-") {
      state.mines--;
      clampSelection();
      persist();
      refresh();
    } else if (act === "mines+") {
      state.mines++;
      clampSelection();
      persist();
      refresh();
    } else if (act === "gems-") {
      state.gems--;
      clampSelection();
      persist();
      refresh();
    } else if (act === "gems+") {
      state.gems++;
      clampSelection();
      persist();
      refresh();
    } else if (act === "table") {
      state.showTable = !state.showTable;
      persist();
      refresh();
      scheduleLayout(); // float card auto-height changes with the ladder
    } else if (act === "gemrow") {
      state.gems = parseInt(t.getAttribute("data-gems"), 10);
      clampSelection();
      persist();
      refresh();
    }
  }

  function onPanelInput(e) {
    var fld = e.target.getAttribute && e.target.getAttribute("data-fld");
    if (!fld) return;
    if (fld === "bet") {
      state.bet = e.target.value.trim();
      persist();
      renderResult();
      renderTable();
      return;
    }
    var n = parseInt(e.target.value, 10);
    if (!isFinite(n)) {
      // empty / partial — on blur, snap the field back to the real value
      if (e.type === "change") refresh();
      return;
    }
    if (fld === "mines") state.mines = n;
    else if (fld === "gems") state.gems = n;
    clampSelection();
    persist();
    if (e.type === "change") {
      // blur/enter: sync the field to the clamped value
      refresh();
    } else {
      // typing: don't clobber the focused field's caret; just update results
      renderResult();
      renderTable();
    }
  }

  // ---------------------------------------------------------------------------
  // Layout: dock beside the game, or float + drag (mirrors keno/plinko)
  // ---------------------------------------------------------------------------
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
    return Math.max(240, Math.min(w, window.innerWidth - 16, 640));
  }
  function clampH(h) {
    return Math.max(180, Math.min(h, window.innerHeight - 16));
  }
  function setStyle(el, obj) {
    for (var k in obj) el.style[k] = obj[k];
  }

  function layout() {
    if (!root || !state.settings.open) return;
    var s = state.settings;
    if (s.mode === "float") {
      var fw = s.panelW ? clampW(s.panelW) : DOCK_W;
      var fh = s.panelH ? clampH(s.panelH) : null;
      var p = s.floatPos || { left: window.innerWidth - fw - 20, top: 110 };
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
      var card = root.querySelector("#mines-calc-panel");
      if (card) card.style.maxHeight = fh ? "none" : "";
      return;
    }

    // Docked: sit in the empty area to the RIGHT of the visible game box.
    var margin = 8;
    var gap = 12;
    var anchor = gameBoxRect();
    if (anchor && panelContentFrac != null && panelContentFrac < 0.999) {
      var b2 = anchor.top + panelContentFrac * anchor.height;
      anchor = {
        left: anchor.left,
        top: anchor.top,
        right: anchor.right,
        bottom: b2,
        width: anchor.width,
        height: b2 - anchor.top
      };
    }
    var left, top, height, width;
    if (anchor) {
      var dockLeft = anchor.right + gap;
      var avail = window.innerWidth - margin - dockLeft;
      var defWidth = avail >= 220 ? Math.min(DOCK_W, avail) : DOCK_W;
      var navB = navBottom();
      var defHeight;
      if (anchor.top >= navB) {
        top = anchor.top;
        defHeight = Math.max(Math.min(anchor.bottom, window.innerHeight) - top, 220);
      } else {
        top = navB;
        defHeight = Math.max(Math.min(anchor.height, window.innerHeight - top), 220);
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
    height = Math.max(150, Math.min(height, window.innerHeight - top - margin));
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

  var layoutScheduled = false;
  function scheduleLayout() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(function () {
      layoutScheduled = false;
      layout();
    });
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
    if (e.target.closest && e.target.closest(".mc-resize")) {
      startResize(e);
      return;
    }
    if (state.settings.mode !== "float") return;
    var header = e.target.closest && e.target.closest(".mc-header");
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
    var w = root.getBoundingClientRect().width || DOCK_W;
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

  // ---------------------------------------------------------------------------
  // Cross-frame bridge (reader → panel over chrome.storage)
  // ---------------------------------------------------------------------------
  var bridge = { bet: null, cur: "$", grid: null, gems: null, mines: null, cf: 0, toggleSeq: 0, ts: 0 };
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
    }, 150);
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

  // Apply relayed board reads (panel side), following the board on change so
  // selecting tiles drives the calc but manual edits persist between changes.
  function applyBoard(grid, gems, mines) {
    var changed = false;
    if (typeof grid === "number" && GRIDS.indexOf(grid) !== -1 && grid !== lastBoardGrid) {
      lastBoardGrid = grid;
      if (state.grid !== grid) {
        state.grid = grid;
        changed = true;
      }
    }
    if (typeof gems === "number" && gems !== lastBoardGems) {
      lastBoardGems = gems;
      if (gems >= 1 && state.gems !== gems) {
        state.gems = gems;
        changed = true;
      }
    }
    if (typeof mines === "number" && mines !== lastBoardMines) {
      lastBoardMines = mines;
      if (mines >= 1 && state.mines !== mines) {
        state.mines = mines;
        changed = true;
      }
    }
    if (changed) {
      clampSelection();
      persist();
    }
    return changed;
  }

  function handleBridge(b) {
    if (!b) return;
    if (typeof b.cf === "number") panelContentFrac = b.cf;
    var nb = typeof b.bet === "number" ? b.bet : null;
    var betChanged = nb !== pageBet;
    if (betChanged) pageBet = nb;
    if (typeof b.cur === "string" && b.cur && b.cur !== pageCurrency) {
      pageCurrency = b.cur;
      betChanged = true; // re-render the payout with the new symbol
    }
    var boardChanged = applyBoard(b.grid, b.gems, b.mines);
    if (b.toggleSeq && b.toggleSeq > lastToggleSeq) {
      lastToggleSeq = b.toggleSeq;
      state.settings.open = !state.settings.open;
      persist();
      render();
      return;
    }
    if (betChanged || boardChanged) refresh();
    if (boardChanged) scheduleLayout();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[BRIDGE_KEY]) return;
    handleBridge(changes[BRIDGE_KEY].newValue);
  }

  // ---------------------------------------------------------------------------
  // In-game toolbar toggle (reopen the panel), mirrors keno/plinko
  // ---------------------------------------------------------------------------
  // Gem outline in currentColor; adopts a sibling toolbar button's classes so
  // it matches the site's native icon buttons (shared shape with keno/plinko).
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
      if (btns[i].id === "mc-bottom-toggle") continue;
      var r = btns[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return btns[i];
    }
    return null;
  }
  function makeToggleBtn(refClass) {
    var btn = document.createElement("button");
    btn.id = "mc-bottom-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Mines Calculator");
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
        if (b.id === "mc-bottom-toggle") continue;
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
      var btn = document.getElementById("mc-bottom-toggle");
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
        btn.style.bottom = "56px";
        btn.style.zIndex = "2147483647";
        btn.style.background = "rgba(15,29,51,0.92)";
        document.body.appendChild(btn);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------
  function startPanel() {
    buildShell();
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, true);
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (b) {
          lastToggleSeq = b.toggleSeq || 0;
          if (typeof b.cf === "number") panelContentFrac = b.cf;
          // Only adopt the relayed bet/board when actually on mines — a stale
          // bridge from a past session shouldn't clobber the saved selection.
          if (minesActive()) {
            if (typeof b.bet === "number") pageBet = b.bet;
            if (typeof b.cur === "string" && b.cur) pageCurrency = b.cur;
            applyBoard(b.grid, b.gems, b.mines);
            refresh();
          }
        }
      });
    } catch (e) {}
    setInterval(function () {
      if (!root) return;
      var show = minesActive();
      root.style.display = show ? "" : "none";
      if (show) ensureBottomButton(); // toolbar lives on the top page → panel docks it
      if (show && state.settings.open && state.settings.mode === "docked") layout();
    }, 250);
  }

  var readerSig = "";
  function startReader() {
    document.addEventListener(NET_EVT, onNetEvent);
    var start = function () {
      setInterval(function () {
        if (!hasMinesDom()) return;
        var board = composeBoard();
        var bet = readPageBet();
        var cur = readCurrency();
        var cf = readContentFrac();
        var sig = JSON.stringify([board, bet, cur, Math.round((cf || 0) * 200)]);
        if (sig !== readerSig) {
          readerSig = sig;
          bridge.bet = typeof bet === "number" ? bet : null;
          if (cur) bridge.cur = cur;
          if (board) {
            bridge.grid = board.grid;
            bridge.gems = board.gems;
            bridge.mines = board.mines;
          }
          if (cf != null) bridge.cf = cf;
          writeBridge();
        }
        ensureBottomButton();
      }, 400);
    };
    // Baseline the toggle counter off the stored bridge BEFORE the first write,
    // so the relay can't clobber the panel's toggle sequence.
    try {
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (b && b.toggleSeq) bridge.toggleSeq = b.toggleSeq;
        start();
      });
    } catch (e) {
      start();
    }
  }

  function startCombined() {
    buildShell();
    document.addEventListener(NET_EVT, onNetEvent);
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, true);
    setInterval(function () {
      if (!root) return;
      var show = minesActive();
      root.style.display = show ? "" : "none";
      if (!show) return;
      var board = composeBoard();
      var bet = readPageBet();
      var cur = readCurrency();
      var changed = false;
      if (bet !== pageBet) {
        pageBet = bet;
        changed = true;
      }
      if (cur && cur !== pageCurrency) {
        pageCurrency = cur;
        changed = true;
      }
      if (board && applyBoard(board.grid, board.gems, board.mines)) changed = true;
      if (changed) refresh();
      ensureBottomButton();
      if (state.settings.open && state.settings.mode === "docked") layout();
    }, 350);
  }

  function init() {
    var isTop = window === window.top;
    var gameHere = hasMinesDom();
    if (gameHere && isTop) {
      ROLE = "combined";
      startCombined();
    } else if (gameHere && !isTop) {
      ROLE = "reader";
      startReader();
    } else if (isTop) {
      ROLE = "panel";
      startPanel();
    } else {
      ROLE = "none";
    }
  }

  load(init);
})();
