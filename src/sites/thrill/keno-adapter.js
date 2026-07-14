/*
 * Keno Tracker — Thrill site adapter (loaded BEFORE games/keno/engine.js).
 *
 * Thrill renders keno either directly in the top page or inside an iframe, and
 * much of its UI lives in shadow DOM — so every query here goes through deep
 * (shadow-piercing) helpers. Roles mirror Winna's: reader (board iframe),
 * panel (outer page), combined (board + page in one frame); the reader↔panel
 * bridge rides chrome.storage. A panel can promote itself to combined when SPA
 * navigation mounts the board into the top frame.
 *
 * Draw source: the NETWORK is authoritative once seen. net-hook.js (MAIN
 * world) forwards REST bet responses ({ data: { roundId, result[…] } }); no
 * nonce is carried, so one is synthesised sequentially and deduped on roundId.
 * The DOM counter keeps working until the first network draw arrives, so a
 * changed endpoint can't silence the tracker.
 *
 * Tiles are layered SVGs flagged with data-testid (tile-idle-base /
 * tile-active-overlay / tile-lost); a DRAWN pick swaps to gem art and its
 * number label vanishes, so hits are partly inferred (see classifyTilesThrill).
 */
(function () {
  "use strict";

  var E = null; // engine API, received in attach()
  var ROLE = "none"; // "reader" | "panel" | "combined" | "none"

  var BRIDGE_KEY = "thrillKenoTrackerBridge";
  var CMD_KEY = "thrillKenoTrackerCmd"; // panel → reader commands (board heat paint)
  var bridge = { sel: [], pt: {}, br: null, vw: 0, vh: 0, drawSeq: 0, draws: [], saveSeq: 0, saveSel: [], toggleSeq: 0, ts: 0 };
  var bridgeWriteT = null;

  var NET_EVT = "__kt_net_payload"; // CustomEvent name from net-hook.js (MAIN world)
  var INSTANT_RATE_MS = 1100; // bets closer together than this can't be animating
  var netHookPresent = false; // net-hook.js is installed (set from its DOM marker)
  var netSeenEver = false; // a network draw has been seen this session
  var lastNetAt = 0; // ms timestamp of the last network draw
  var netOffset = null; // 0 or +1: calibrated index shift for network numbers
  var processedNetIds = []; // recent roundIds, capped — dedupes re-deliveries

  var lastSelection = []; // selection reported by the reader (panel role)
  var panelBoardRect = null; // board rect reported by the reader (iframe-local)
  var panelBoardViewport = null; // reader viewport used to project board rect
  var panelContentFrac = null; // where the game content ends, as an iframe fraction
  var stableSelection = []; // last clean board selection; held during reveals
  var selEmptySince = 0; // when the board first read empty (debounces real clears)

  var domDraw = { lastSig: null }; // board reveal dedupe
  var revealSet = {};
  var revealCount = 0;
  var thrillCheckTimer = null;
  var boardObserver = null;
  var observedBoardRoots = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  var lastPtScrape = 0;

  // ---------------------------------------------------------------------------
  // Shadow-DOM-piercing queries (Thrill renders parts of the page in shadow roots)
  // ---------------------------------------------------------------------------
  function deepRoots() {
    var out = [];
    var seen = [];
    function walk(root) {
      if (!root || seen.indexOf(root) !== -1) return;
      seen.push(root);
      out.push(root);
      if (!root.querySelectorAll) return;
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) walk(all[i].shadowRoot);
      }
    }
    walk(document);
    return out;
  }
  function qsaDeep(sel) {
    var roots = deepRoots();
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      try {
        var found = roots[i].querySelectorAll(sel);
        for (var j = 0; j < found.length; j++) out.push(found[j]);
      } catch (e) {}
    }
    return out;
  }
  function qsDeep(sel) {
    var roots = deepRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        var found = roots[i].querySelector(sel);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Board reading — Thrill detector chain (shared markup → SVG layers → colour)
  // ---------------------------------------------------------------------------
  function parseColor(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var parts = m[1].split(",").map(function (s) {
      return parseFloat(s);
    });
    if (parts.length < 3) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function bgColors(cs) {
    var out = [];
    var bc = parseColor(cs.backgroundColor);
    if (bc && bc.a > 0.15) out.push(bc);
    var bi = cs.backgroundImage || "";
    var re = /rgba?\(([^)]+)\)/g;
    var m;
    while ((m = re.exec(bi))) {
      var p = m[1].split(",").map(parseFloat);
      if (p.length >= 3) out.push({ r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 });
    }
    return out;
  }
  function tileContainer(labelEl) {
    if (labelEl.closest) {
      var btn = labelEl.closest('button, [role="button"]');
      if (btn) return btn;
    }
    var el = labelEl.parentElement || labelEl;
    for (var i = 0; i < 6 && el; i++) {
      var r = el.getBoundingClientRect();
      if (r.width >= 45 && r.width <= 180 && r.height >= 30 && r.height <= 180) return el;
      el = el.parentElement;
    }
    return labelEl.parentElement || labelEl;
  }
  function tileFill(labelEl) {
    var container = tileContainer(labelEl);
    var nodes = [container];
    var kids = container.getElementsByTagName("*");
    for (var i = 0; i < kids.length && i < 24; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute("data-kt-heat")) continue;
      nodes.push(kids[i]);
    }
    var best = null;
    var bestScore = -1;
    for (var j = 0; j < nodes.length; j++) {
      var styles = [getComputedStyle(nodes[j])];
      if (nodes[j] === container) {
        styles.push(getComputedStyle(nodes[j], "::before"));
        styles.push(getComputedStyle(nodes[j], "::after"));
      }
      for (var s = 0; s < styles.length; s++) {
        var cols = bgColors(styles[s]);
        for (var c = 0; c < cols.length; c++) {
          var col = cols[c];
          if (col.a < 0.35) continue;
          var bright = Math.max(col.r, col.g, col.b);
          var sat = bright - Math.min(col.r, col.g, col.b);
          if (bright < 70 || sat < 40) continue; // dark/grey = unselected field
          var score = sat + bright * 0.25;
          if (score > bestScore) {
            bestScore = score;
            best = col;
          }
        }
      }
    }
    return best;
  }
  function sortResult(result) {
    var byNum = function (a, b) {
      return a - b;
    };
    result.selected.sort(byNum);
    result.hit.sort(byNum);
    result.miss.sort(byNum);
    return result;
  }

  // Find the number tiles (deep). Stray page numbers are filtered by locating
  // the deepest ancestor that still contains most of the numbers (the grid).
  function findTiles() {
    var bMax = E.state.settings.boardMax;
    var candidates = [];
    var els = qsaDeep("button, div, span, li, a");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest("#keno-tracker-root")) continue; // ignore our panel
      var t = el.textContent ? el.textContent.trim() : "";
      if (!/^\d{1,2}$/.test(t)) continue;
      var n = parseInt(t, 10);
      if (n < 1 || n > bMax) continue;
      var childHolds = false;
      for (var c = 0; c < el.children.length; c++) {
        if (el.children[c].textContent && el.children[c].textContent.trim() === t) {
          childHolds = true;
          break;
        }
      }
      if (childHolds) continue;
      candidates.push({ n: n, el: el });
    }

    var map = new Map();
    if (!candidates.length) return map;

    var ancestorNums = new Map();
    for (var g = 0; g < candidates.length; g++) {
      var a = candidates[g].el;
      var hops = 0;
      while (a && hops < 10) {
        var set = ancestorNums.get(a);
        if (!set) {
          set = new Set();
          ancestorNums.set(a, set);
        }
        set.add(candidates[g].n);
        a = a.parentElement;
        hops++;
      }
    }

    function depthOf(node) {
      var d = 0;
      while (node) {
        node = node.parentElement;
        d++;
      }
      return d;
    }

    var threshold = Math.max(8, Math.floor(bMax * 0.5));
    var container = null;
    var bestDepth = -1;
    ancestorNums.forEach(function (set, node) {
      if (set.size < threshold) return;
      var d = depthOf(node);
      if (d > bestDepth) {
        bestDepth = d;
        container = node;
      }
    });

    for (var i2 = 0; i2 < candidates.length; i2++) {
      var cand = candidates[i2];
      if ((!container || container.contains(cand.el)) && !map.has(cand.n)) {
        map.set(cand.n, cand.el);
      }
    }
    return map;
  }

  // Fallback: classify by tile fill color when the state markers are absent.
  function classifyTilesByColor() {
    var tiles = findTiles();
    var result = { selected: [], hit: [], miss: [], tiles: tiles };
    if (!tiles.size) return result;
    tiles.forEach(function (el, n) {
      var c = tileFill(el);
      if (!c) return; // unselected
      if (c.b >= c.g && c.b - c.r > 15) result.selected.push(n); // cyan / blue
      else if (c.g >= c.r && c.g >= c.b) result.hit.push(n); // green
      else if (c.r > c.g && c.r > c.b) result.miss.push(n); // red
      else result.selected.push(n);
    });
    return sortResult(result);
  }

  // ---- Thrill detector ------------------------------------------------------
  // Each tile is a <button> holding a layered SVG, flagged with data-testid:
  //   tile-idle-base      resting face (its opacity fades out under overlays)
  //   tile-active-overlay your pick (green)
  //   tile-lost           drawn & missed (red number)
  // A pick that gets DRAWN swaps the tile art for a gem graphic and the number
  // label vanishes — so we cache each number's tile container from the frames
  // where the label was readable, and infer a hit when its label is gone while
  // the rest of the board shows a reveal (lost tiles present).
  function layerVisible(box, sel) {
    var g = box.querySelector(sel);
    if (!g) return false;
    var nodes = [g, g.querySelector("path, rect, circle")];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      var cs = getComputedStyle(nodes[i]);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      var o = parseFloat(cs.opacity);
      if (!isNaN(o) && o < 0.35) return false;
    }
    return true;
  }
  var THRILL_GEM_SEL =
    '[data-testid*="gem" i], [data-testid*="diamond" i], [data-testid*="hit" i], ' +
    '[data-testid*="win" i], img';
  function gemVisible(box) {
    var els = box.querySelectorAll(THRILL_GEM_SEL);
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      var cs = getComputedStyle(els[i]);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      var o = parseFloat(cs.opacity);
      if (!isNaN(o) && o < 0.35) continue;
      return true;
    }
    return false;
  }
  var thrillTiles = new Map(); // n -> tile container, survives label-less gem frames
  function classifyTilesThrill() {
    var labels = findTiles();
    labels.forEach(function (el, n) {
      var box = tileContainer(el);
      if (box) thrillTiles.set(n, box);
    });
    var stale = [];
    thrillTiles.forEach(function (el, n) {
      if (!el.isConnected) stale.push(n);
    });
    stale.forEach(function (n) {
      thrillTiles.delete(n);
    });

    var result = { selected: [], hit: [], miss: [], tiles: thrillTiles };
    if (!thrillTiles.size) return result;

    // First pass: raw layer states (lost count gates the missing-label → hit
    // inference so a board re-render can't fake a win on an idle board).
    var states = new Map();
    var lostCount = 0;
    thrillTiles.forEach(function (box, n) {
      var st = {
        lost: layerVisible(box, '[data-testid="tile-lost"]'),
        active: layerVisible(box, '[data-testid="tile-active-overlay"]'),
        gem: gemVisible(box)
      };
      if (st.lost) lostCount++;
      states.set(n, st);
    });
    states.forEach(function (st, n) {
      if (st.gem || (!labels.has(n) && !st.lost && lostCount >= 3)) result.hit.push(n);
      else if (st.lost) result.miss.push(n);
      else if (st.active) result.selected.push(n);
    });
    return sortResult(result);
  }

  // Diagnostic (Alt+D on the keno page): dumps what the detector sees per
  // tile — label present, which SVG layers read visible, the classify result,
  // and the raw data-testids inside a sample tile. For debugging board-read
  // bugs without guessing at Thrill's markup.
  function dumpTiles() {
    try {
      var labels = findTiles();
      classifyTiles(); // refresh the tile cache first
      var out = [];
      thrillTiles.forEach(function (box, n) {
        out.push({
          n: n,
          label: labels.has(n),
          active: layerVisible(box, '[data-testid="tile-active-overlay"]'),
          lost: layerVisible(box, '[data-testid="tile-lost"]'),
          gem: gemVisible(box)
        });
      });
      out.sort(function (a, b) {
        return a.n - b.n;
      });
      console.log("[KenoTracker] THRILL TILE DUMP");
      if (console.table) console.table(out);
      else console.log(JSON.stringify(out));
      var cls = classifyTiles();
      console.log(
        "[KenoTracker] classify → selected:[" + cls.selected.join(",") +
        "] hit:[" + cls.hit.join(",") + "] miss:[" + cls.miss.join(",") + "]"
      );
      var sampleN = cls.selected[0] || 1;
      var sample = thrillTiles.get(sampleN);
      if (sample) {
        var ids = [];
        var els = sample.querySelectorAll("[data-testid]");
        for (var i = 0; i < els.length; i++) ids.push(els[i].getAttribute("data-testid"));
        console.log("[KenoTracker] tile #" + sampleN + " testids: " + ids.join(", "));
        console.log("[KenoTracker] tile #" + sampleN + " html:", sample.outerHTML.slice(0, 1500));
      }
    } catch (e) {
      console.log("[KenoTracker] dump error", e);
    }
  }
  function onDebugKey(e) {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key || "").toLowerCase() === "d") {
      dumpTiles();
    }
  }

  // Primary detector chain: the shared keno game tiles (<button class=
  // "field-button"> with selected/revealed/isHit classes) first, then the
  // Thrill SVG detector, colour as the last resort.
  function classifyTiles() {
    var buttons = qsaDeep(".field-button");
    if (!buttons.length) {
      // Thrill gate: tile CONTAINERS ([data-testid="keno-tile-N"]) exist in
      // every board state. Never gate on tile-idle-base alone — when the pick
      // limit (10) is reached, thrill re-renders all unselected tiles WITHOUT
      // their idle layer, and an idle-base gate collapsed the whole detection
      // exactly at 10 picks (selection froze, then blanked).
      if (
        qsaDeep(
          '[data-testid^="keno-tile-"], [data-testid="tile-idle-base"], ' +
          '[data-testid="tile-active-overlay"], [data-testid="tile-lost"]'
        ).length
      ) {
        return classifyTilesThrill();
      }
      return classifyTilesByColor();
    }
    var result = { selected: [], hit: [], miss: [], tiles: new Map() };
    var bMax = E.state.settings.boardMax;
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var t = (b.textContent || "").trim();
      if (!/^\d{1,2}$/.test(t)) continue;
      var n = parseInt(t, 10);
      if (n < 1 || n > bMax) continue;
      result.tiles.set(n, b);
      var cl = b.classList;
      var sel = cl.contains("selected");
      var rev = cl.contains("revealed");
      if (cl.contains("isHit") || (sel && rev)) result.hit.push(n);
      else if (rev) result.miss.push(n);
      else if (sel) result.selected.push(n);
    }
    return sortResult(result);
  }

  // Read the on-screen paytable row. On Thrill the multipliers are plain "10x"
  // / "2.8x" / "259x" (no forced decimal) and the hit-count labels underneath
  // are bare digits (no "x"), so anything number+x shaped is a multiplier.
  function readPaytable() {
    var els = qsaDeep("div, span, button, p");
    var found = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = (el.textContent || "").trim();
      if (!/^[\d,]+(\.\d+)?k?x$/i.test(t)) continue;
      var childSame = false;
      for (var c = 0; c < el.children.length; c++) {
        if ((el.children[c].textContent || "").trim() === t) {
          childSame = true;
          break;
        }
      }
      if (childSame) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var num = parseFloat(t.replace(/,/g, "").replace(/[kx]/gi, ""));
      if (/k/i.test(t)) num *= 1000;
      found.push({ x: r.left, y: Math.round(r.top / 8) * 8, v: num });
    }
    if (found.length < 2) return null;
    var byY = {};
    found.forEach(function (f) {
      (byY[f.y] = byY[f.y] || []).push(f);
    });
    var best = null;
    Object.keys(byY).forEach(function (k) {
      if (!best || byY[k].length > best.length) best = byY[k];
    });
    if (!best || best.length < 2) return null;
    best.sort(function (a, b) {
      return a.x - b.x;
    });
    return best.map(function (f) {
      return f.v;
    });
  }

  // ---------------------------------------------------------------------------
  // Selection — held steady through Thrill's reveal animations
  // ---------------------------------------------------------------------------
  // The board's raw read flickers during a reveal: hit tiles swap to gem art
  // and the overlay opacity animates, so picks briefly vanish from a naive
  // read. We adopt a read that ADDS a number (the user actively picked) and
  // require an empty board to persist briefly before reporting a real clear.
  function updateStableSelection(picks, drawnShowing) {
    if (picks.length) {
      selEmptySince = 0;
      var grew = picks.some(function (n) {
        return stableSelection.indexOf(n) === -1;
      });
      if (grew || !drawnShowing || picks.length >= stableSelection.length) {
        stableSelection = picks.slice();
      }
      return stableSelection.slice();
    }
    if (drawnShowing) {
      selEmptySince = 0; // mid-reveal empty read → hold the last stable pick
      return stableSelection.slice();
    }
    if (!stableSelection.length) return [];
    if (!selEmptySince) selEmptySince = Date.now();
    // 2s: the end-of-reveal transition on standard speed can leave the board
    // unreadable for over a second — a real Clear Picks takes that long to
    // show "—", which beats the selection flickering away on every draw.
    if (Date.now() - selEmptySince > 2000) {
      stableSelection = []; // sustained empty board → the table was cleared
      return [];
    }
    return stableSelection.slice(); // transient gap → keep the last selection
  }

  function readSelection() {
    // If the board lives in another frame, use what the reader sent. If Thrill
    // renders the board directly in this page, read it locally.
    if ((ROLE === "panel" || ROLE === "combined") && !hasBoardDom()) return lastSelection.slice();
    var cls = classifyTiles();
    var all = cls.selected.concat(cls.hit);
    all.sort(function (a, b) {
      return a - b;
    });
    return updateStableSelection(all, cls.hit.length + cls.miss.length > 0);
  }

  // ---------------------------------------------------------------------------
  // Network draws — the authoritative source once seen
  // ---------------------------------------------------------------------------
  // True when the network owns the count, so the DOM counter must stand down.
  function netOwnsCounting() {
    return netSeenEver;
  }

  function sortedSig(arr) {
    return arr
      .slice()
      .sort(function (a, b) {
        return a - b;
      })
      .join(",");
  }

  // Sorted signature of the tiles currently revealed on the board (hit ∪ miss).
  function boardRevealedSig() {
    try {
      var cls = classifyTiles();
      return sortedSig(cls.hit.concat(cls.miss));
    } catch (e) {
      return "";
    }
  }

  // Decide the 0/1 index shift once, then reuse it for every draw. Thrill's
  // board labels are 1..boardMax, and its API result looks 1-indexed — but we
  // prove it rather than assume: a 0 in a result proves 0-indexing, a boardMax
  // proves 1-indexing, and matching the live board reveal settles the rest.
  function calibrateOffset(drawn) {
    if (netOffset != null) return netOffset;
    var bMax = E.state.settings.boardMax || 40;
    if (drawn.indexOf(0) !== -1) return (netOffset = 1);
    if (drawn.indexOf(bMax) !== -1) return (netOffset = 0);
    var sig = boardRevealedSig();
    if (sig && sig.split(",").length === drawn.length) {
      if (sig === sortedSig(drawn)) return (netOffset = 0);
      if (
        sig ===
        sortedSig(
          drawn.map(function (n) {
            return n + 1;
          })
        )
      )
        return (netOffset = 1);
    }
    return null; // undecided — caller assumes 1-indexed for now
  }

  function shiftNums(drawn) {
    var off = calibrateOffset(drawn);
    if (!off) return drawn.slice();
    return drawn.map(function (n) {
      return n + off;
    });
  }

  // Pull the keno bet result out of the response: an object holding a roundId
  // and a full result array. Walks the object so it works with or without the
  // `data` envelope.
  function parseKenoBet(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 6) return null;
    if (
      typeof node.roundId === "string" &&
      Array.isArray(node.result) &&
      node.result.length
    ) {
      return { id: node.roundId, drawn: node.result.slice() };
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = parseKenoBet(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Strict shape check: a real keno draw is drawCount distinct integers on the
  // board. This is what lets the hook forward generously (any */bet request)
  // without other games ever being counted.
  function validDraw(drawn) {
    var expected = E.state.settings.drawCount || 10;
    var bMax = E.state.settings.boardMax || 40;
    if (drawn.length !== expected) return false;
    var seen = {};
    for (var i = 0; i < drawn.length; i++) {
      var n = drawn[i];
      if (typeof n !== "number" || n !== Math.floor(n)) return false;
      if (n < 0 || n > bMax) return false;
      if (seen[n]) return false;
      seen[n] = 1;
    }
    return true;
  }

  function seenNetId(id) {
    if (!id) return false;
    if (processedNetIds.indexOf(id) !== -1) return true;
    processedNetIds.push(id);
    if (processedNetIds.length > 300) processedNetIds.splice(0, processedNetIds.length - 300);
    return false;
  }

  // Release `cb` once the board shows this bet's result, so the tracker never
  // spoils an animated reveal. Hit tiles are unreliable to read on Thrill (the
  // gem art replaces the tile), so misses are the primary signal: the reveal
  // is done once every drawn-but-unpicked number is painted lost. The exact
  // hit∪miss signature and a full changed reveal stay in as backups, and the
  // cap is a safety net. The first check runs synchronously, so a board that
  // painted before the response (turbo / no animations) releases immediately.
  function whenNewReveal(prevSig, drawn, cap, cb) {
    var need = E.state.settings.drawCount || 10;
    var newSig = sortedSig(drawn);
    var inDraw = {};
    drawn.forEach(function (n) {
      inDraw[n] = 1;
    });
    var picks = stableSelection || [];
    var expectMiss = drawn.filter(function (n) {
      return picks.indexOf(n) === -1;
    }).length;
    var start = Date.now();
    (function poll() {
      var sig = "";
      var misses = [];
      try {
        var cls = classifyTiles();
        misses = cls.miss;
        sig = sortedSig(cls.hit.concat(cls.miss));
      } catch (e) {}
      var shownCount = sig ? sig.split(",").length : 0;
      var missesMatch =
        misses.length >= Math.max(1, expectMiss) &&
        misses.every(function (n) {
          return inDraw[n];
        });
      if (
        sig === newSig ||
        missesMatch ||
        (shownCount >= need && sig !== prevSig) ||
        Date.now() - start >= cap
      ) {
        cb();
        return;
      }
      setTimeout(poll, 50);
    })();
  }

  function handleNetPayload(text) {
    if (typeof text !== "string" || text.length > 2000000) return;
    if (!(hasBoardDom() || kenoActive())) return; // only count bets made from keno
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    var bet = parseKenoBet(data);
    if (!bet || !validDraw(bet.drawn)) return;
    if (seenNetId(bet.id)) return; // duplicate delivery of the same bet

    // A new bet just fired — the previous nonce's hit glow and notification
    // come off NOW (not when this draw finishes revealing). If the board is in
    // an iframe (reader role), the panel is told over the bridge.
    clearGlow();
    if (ROLE === "combined") {
      try {
        E.clearHitFx();
      } catch (eFx) {}
    } else {
      bridge.betSeq = (bridge.betSeq || 0) + 1;
      writeBridge(true);
    }

    var drawn = shiftNums(bet.drawn);
    var sig = sortedSig(drawn);
    var now = Date.now();
    // Rapid bets (autobet / instant) change the board faster than we can poll
    // for the reveal, so release them immediately. Spaced bets wait for the
    // board to show this bet's result.
    var gap = lastNetAt ? now - lastNetAt : Infinity;
    var rapid = gap < INSTANT_RATE_MS;
    var prevSig = boardRevealedSig();
    var firstNet = !netSeenEver;

    netSeenEver = true; // from here on the network owns the count
    lastNetAt = now;
    E.log("NET draw", { id: bet.id, drawn: drawn, rapid: rapid });

    var release = function () {
      // The DOM counter may have already recorded this very reveal before the
      // first network draw arrived — don't count the handover bet twice.
      if (firstNet && domDraw.lastSig === sig) {
        E.log("net draw already DOM-counted, skipping");
        return;
      }
      domDraw.lastSig = sig; // and the DOM fallback must not recount this one
      if (ROLE === "combined") {
        E.processDraw({ nonce: E.nextDomNonce(), drawn: drawn, source: "net" });
      } else {
        bridge.drawSeq = (bridge.drawSeq || 0) + 1;
        bridge.draws.push({ seq: bridge.drawSeq, drawn: drawn });
        if (bridge.draws.length > 20) bridge.draws.splice(0, bridge.draws.length - 20);
        writeBridge(true);
      }
    };

    // whenNewReveal's first check is synchronous, so an already-painted board
    // (instant / no animations) releases right here with no delay.
    if (rapid) release();
    else whenNewReveal(prevSig, drawn, 1500, release);
  }

  function onNetEvent(e) {
    try {
      handleNetPayload(e && e.detail);
    } catch (err) {}
  }

  // Seed rotation (net-hook.js forwards the /rotate response — an array of seed
  // records, the promoted one flagged isActive with nonce 0). The board can be
  // in an iframe (reader relays over the bridge) or the top frame (panel/
  // combined resets the engine directly). Shape-checked before acting.
  function validSeedPayload(text) {
    try {
      var d = JSON.parse(text);
      return !!(
        d &&
        d.data &&
        d.data.length &&
        d.data.some(function (s) {
          return s && s.isActive === true;
        })
      );
    } catch (e) {
      return false;
    }
  }
  function handleSeedReset() {
    E.log("seed rotation detected, role:", ROLE);
    if (ROLE === "reader") {
      bridge.seedSeq = (bridge.seedSeq || 0) + 1;
      writeBridge(true);
    } else if (ROLE === "combined" || ROLE === "panel") {
      E.onSeedReset();
    }
  }
  function onSeedResetEvent(e) {
    try {
      if (validSeedPayload(e && e.detail)) handleSeedReset();
    } catch (err) {}
  }

  // ---------------------------------------------------------------------------
  // DOM draw detection — primary until the first network draw, fallback after
  // ---------------------------------------------------------------------------
  function commitDraw(arr) {
    if (netOwnsCounting()) return;
    var expected = E.state.settings.drawCount || 10;
    if (!arr || arr.length < expected) return;
    arr = arr.slice().sort(function (a, b) {
      return a - b;
    });
    var sig = arr.join(",");
    if (sig === domDraw.lastSig) return;
    domDraw.lastSig = sig;
    if (ROLE === "combined") {
      E.processDraw({ nonce: E.nextDomNonce(), drawn: arr, source: "dom" });
    } else {
      bridge.drawSeq = (bridge.drawSeq || 0) + 1;
      bridge.draws.push({ seq: bridge.drawSeq, drawn: arr });
      if (bridge.draws.length > 20) bridge.draws.splice(0, bridge.draws.length - 20);
      writeBridge(true);
    }
  }

  function onBoardMutations(records) {
    var expected = E.state.settings.drawCount || 10;
    var min = Math.max(3, Math.floor(expected * 0.6));
    var thrillTouched = false;
    for (var i = 0; i < records.length; i++) {
      var m = records[i];
      var el = m.target;
      // Thrill: any churn inside an SVG tile (gem art swapped in, overlay
      // opacity flipped) → re-read the board promptly, debounced per burst.
      if (!thrillTouched && el) {
        var node = el.nodeType === 1 ? el : el.parentElement;
        if (
          node &&
          node.closest &&
          !node.closest("#keno-tracker-root") &&
          node.closest('[data-testid^="tile-"], [id^="keno-clip"]')
        ) {
          thrillTouched = true;
        }
      }
      var cn = el && typeof el.className === "string" ? el.className : "";
      if (cn.indexOf("field-button") === -1) continue;
      var t = (el.textContent || "").trim();
      if (!/^\d{1,2}$/.test(t)) continue;
      var num = parseInt(t, 10);
      var hasRev = el.classList.contains("revealed");
      var hadRev = (" " + (m.oldValue || "") + " ").indexOf(" revealed ") !== -1;
      if (hasRev && !hadRev) {
        if (!revealSet[num]) {
          revealSet[num] = 1;
          revealCount++;
        }
      } else if (!hasRev && hadRev) {
        if (revealSet[num]) {
          delete revealSet[num];
          revealCount--;
        }
      }
      if (revealCount >= expected) commitDraw(Object.keys(revealSet).map(Number));
    }
    if (revealCount < min) domDraw.lastSig = null; // board cleared → ready again
    if (thrillTouched) {
      if (thrillCheckTimer) clearTimeout(thrillCheckTimer);
      thrillCheckTimer = setTimeout(checkDrawFromDOM, 40);
    }
  }

  function checkDrawFromDOM() {
    var cls;
    try {
      cls = classifyTiles();
    } catch (e) {
      return;
    }
    if (ROLE === "combined" && Date.now() - lastPtScrape >= 1000) {
      lastPtScrape = Date.now();
      E.updatePaytableFromDOM();
    }
    var drawn = cls.hit.concat(cls.miss);
    var expected = E.state.settings.drawCount || 10;
    var min = Math.max(3, Math.floor(expected * 0.6));
    idleClearGlow(drawn.length); // drop a lingering glow once the result clears
    revealSet = {};
    revealCount = drawn.length;
    drawn.forEach(function (n) {
      revealSet[n] = 1;
    });
    if (drawn.length >= expected) commitDraw(drawn);
    else if (drawn.length < min) domDraw.lastSig = null;
  }

  function observeBoardMutations() {
    try {
      if (!boardObserver) boardObserver = new MutationObserver(onBoardMutations);
      var roots = deepRoots();
      for (var i = 0; i < roots.length; i++) {
        var target = roots[i] === document ? document.body : roots[i];
        if (!target || (observedBoardRoots && observedBoardRoots.has(target))) continue;
        boardObserver.observe(target, {
          subtree: true,
          childList: true, // Thrill swaps gem art in/out of the tile SVGs
          attributes: true,
          // class = shared-markup state flips; style/opacity/fill = layer fades
          attributeFilter: ["class", "style", "data-testid", "opacity", "fill"],
          attributeOldValue: true
        });
        if (observedBoardRoots) observedBoardRoots.add(target);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Bridge (reader ↔ panel over chrome.storage)
  // ---------------------------------------------------------------------------
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
    if (ROLE === "combined") {
      E.toggleOpen();
    } else {
      bridge.toggleSeq = (bridge.toggleSeq || 0) + 1;
      writeBridge(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Board heat painting — inline tints through the CSSOM (Thrill's page CSP
  // can interfere with injected stylesheets, but never with el.style.*)
  // ---------------------------------------------------------------------------
  var paintHues = null;
  var lastCmdSeq = 0;
  function paintTarget(el) {
    return (el.querySelector && el.querySelector(".field-button__surface")) || el;
  }
  // The stale-colour trap (board⇄ranked keeping tints) is solved by
  // bookkeeping: every painted element is registered, and unpainting walks the
  // REGISTRY — never the classifier's current view, which can miss
  // re-rendered tiles.
  var paintedEls = [];
  function tintEl(t, on, hs) {
    if (on) {
      var h = hs[0];
      var s = hs[1] != null ? hs[1] : 85;
      var l = hs[2] != null ? hs[2] : 52;
      // A soft tint in the heat colour, rounded to the tile shape (a square
      // wash bleeds past Thrill's rounded SVG corners) and light enough that
      // the tile art stays readable underneath.
      t.style.backgroundImage =
        "linear-gradient(180deg, rgba(0,0,0,0.35), hsla(" + h + "," + s + "%," + l + "%,0.5))";
      t.style.borderRadius = "22%";
      if (!t.hasAttribute("data-kt-heat")) {
        t.setAttribute("data-kt-heat", "1");
        paintedEls.push(t);
      }
    } else if (t.hasAttribute("data-kt-heat")) {
      t.style.backgroundImage = "";
      t.style.borderRadius = "";
      t.removeAttribute("data-kt-heat");
    }
  }
  function unpaintAll() {
    for (var i = 0; i < paintedEls.length; i++) {
      try {
        tintEl(paintedEls[i], false);
      } catch (e) {}
    }
    paintedEls = [];
    // Belt and braces: tiles painted before a re-render / script restart.
    var leftovers = qsaDeep("[data-kt-heat]");
    for (var j = 0; j < leftovers.length; j++) tintEl(leftovers[j], false);
  }
  function applyPaint() {
    if (!paintHues) {
      unpaintAll();
      return;
    }
    var cls;
    try {
      cls = classifyTiles();
    } catch (e) {
      return;
    }
    if (!cls.tiles || !cls.tiles.size) return;
    // Mid-reveal the game dims and animates the tiles, and heat tints on top
    // of that look like mud — so the tints step aside for the draw. The
    // post-draw repaint (syncBoardHeat after every processed draw) brings
    // them straight back with the new draw folded into the data.
    var revealed = cls.hit.length + cls.miss.length;
    if (revealed > 0 && revealed < (E.state.settings.drawCount || 10)) {
      unpaintAll();
      return;
    }
    // Leave selected/revealed tiles to the game's own styling so your picks
    // and the draw stay clearly visible through the heat colours. The DOM read
    // can flicker mid-reveal, so the held selection and the last network draw
    // back it up — those tiles are never painted over.
    var busy = {};
    cls.selected.concat(cls.hit, cls.miss).forEach(function (n) {
      busy[n] = 1;
    });
    (stableSelection || []).forEach(function (n) {
      busy[n] = 1;
    });
    (E.state.history.lastDrawn || []).forEach(function (n) {
      busy[n] = 1;
    });
    cls.tiles.forEach(function (el, n) {
      var t = paintTarget(el);
      if (paintHues[n] != null && !busy[n]) tintEl(t, true, paintHues[n]);
      else tintEl(t, false);
    });
  }
  function clearPaint() {
    paintHues = null;
    applyPaint();
  }

  // Hit glow: rings the matched numbers of just-hit configs in each config's
  // banner colour. UNLIKE the removed heat tints (background fills that fought
  // the reveal art), this is an additive box-shadow around the tile — inline
  // CSSOM (CSP-safe), rounded to the SVG tile shape.
  // The glow PERSISTS for the whole nonce — the engine replaces or clears it
  // when the next draw is processed.
  // Multiple configs hit by the same draw CYCLE: each config's numbers show
  // alone in its colour for a phase, then the next config's, looping — one
  // colour on the board at a time (simultaneous multi-colour rings/segments
  // were confusing to read).
  var GLOW_PHASE_MS = 1600;
  var glowComps = null; // hit configs grouped into overlap components
  var glowIdx = 0;
  var glowCycleTimer = null;
  // Group hit configs by shared numbers (union-find): configs with NO number
  // clashes sit alone in their component and render STATIC; only configs that
  // overlap cycle, taking turns within their component.
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
      var nums = items[a].nums || [];
      for (var j = 0; j < nums.length; j++) {
        var k = nums[j];
        if (owner[k] != null) {
          var ra = find(owner[k]);
          var rb = find(a);
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
  function paintGlowPhase() {
    unringAll();
    if (!glowComps || !glowComps.length) return;
    var cls;
    try {
      cls = classifyTiles();
    } catch (e) {
      return;
    }
    if (!cls.tiles || !cls.tiles.size) return;
    // One config per component per phase: static comps always show their only
    // member; overlap comps rotate through theirs.
    var colorOf = {};
    for (var c = 0; c < glowComps.length; c++) {
      var comp = glowComps[c];
      var it = comp[glowIdx % comp.length];
      (it.nums || []).forEach(function (n2) {
        colorOf[n2] = it.color;
      });
    }
    cls.tiles.forEach(function (el, n) {
      var col = colorOf[n];
      if (!col) return;
      el.style.boxShadow = "0 0 0 3px " + col + ", 0 0 16px 3px " + col;
      if (!el.style.borderRadius) el.style.borderRadius = "22%"; // follow the tile art's corners
      el.setAttribute("data-kt-glow", "1");
    });
  }
  function applyGlow(items) {
    clearGlow();
    var live = (items || []).filter(function (it) {
      return it && it.nums && it.nums.length;
    });
    if (!live.length) return;
    glowComps = glowComponents(live);
    glowIdx = 0;
    paintGlowPhase();
    var needCycle = false;
    for (var i = 0; i < glowComps.length; i++) {
      if (glowComps[i].length > 1) needCycle = true;
    }
    if (needCycle) {
      glowCycleTimer = setInterval(function () {
        glowIdx++;
        paintGlowPhase();
      }, GLOW_PHASE_MS);
    }
  }
  function unringAll() {
    var els = qsaDeep("[data-kt-glow]");
    for (var i = 0; i < els.length; i++) {
      els[i].style.boxShadow = "";
      els[i].style.borderRadius = "";
      if (els[i].getAttribute("data-kt-glow-pos")) {
        els[i].style.position = "";
        els[i].removeAttribute("data-kt-glow-pos");
      }
      els[i].removeAttribute("data-kt-glow");
    }
    var rings = qsaDeep(".kt-glow-ring, .kt-glow-dot");
    for (var j = 0; j < rings.length; j++) {
      if (rings[j].parentNode) rings[j].parentNode.removeChild(rings[j]);
    }
  }
  function clearGlow() {
    if (glowCycleTimer) {
      clearInterval(glowCycleTimer);
      glowCycleTimer = null;
    }
    glowComps = null;
    unringAll();
  }

  // The glow rides one nonce and normally clears at the next bet. A manual
  // Clear Picks (or a board wipe with no bet behind it) has no next bet, so it
  // would hang. Rule the user wants: glow only while the RESULT is on the
  // board. Revealed tiles (hit ∪ miss) are the reliable cross-site signal —
  // misses (Thrill `tile-lost`, Winna `revealed`, Stake `is-revealed`) read
  // even when the gem-art hit tiles don't. Once none remain, drop the glow.
  // Debounced so a transient re-render read of 0 can't flicker it off.
  var GLOW_IDLE_MS = 400;
  var glowIdleSince = 0;
  function idleClearGlow(revealedCount) {
    if (!glowComps || revealedCount > 0) {
      glowIdleSince = 0;
      return;
    }
    if (!glowIdleSince) {
      glowIdleSince = Date.now();
      return;
    }
    if (Date.now() - glowIdleSince > GLOW_IDLE_MS) {
      glowIdleSince = 0;
      clearGlow();
    }
  }

  function handleCmd(cmd) {
    if (!cmd || !cmd.seq || cmd.seq === lastCmdSeq) return;
    lastCmdSeq = cmd.seq;
    if (cmd.type === "paint" && cmd.hues) {
      paintHues = cmd.hues;
      applyPaint();
    } else if (cmd.type === "unpaint") {
      clearPaint();
    } else if (cmd.type === "glow" && cmd.glow) {
      applyGlow(cmd.glow.items || [], cmd.glow.ms);
    }
  }
  function sendCmd(type, hues, glow) {
    var cmd = { seq: Date.now() + Math.random(), type: type, hues: hues || null, glow: glow || null };
    if (ROLE === "combined" && hasBoardDom()) {
      handleCmd(cmd);
      return;
    }
    try {
      var o = {};
      o[CMD_KEY] = cmd;
      chrome.storage.local.set(o);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Reader (game iframe)
  // ---------------------------------------------------------------------------
  var readerSelSig = "";
  var readerPtSig = "";
  var readerRectSig = "";

  function tilesRect(cls) {
    if (!cls || !cls.tiles || !cls.tiles.size) return null;
    var minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    cls.tiles.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    });
    if (!isFinite(maxR)) return null;
    return { left: minL, top: minT, right: maxR, bottom: maxB, width: maxR - minL, height: maxB - minT };
  }

  function readerTick() {
    var cls;
    try {
      cls = classifyTiles();
    } catch (e) {
      return;
    }
    // Picks = selected + hit (hit tiles are still part of the selection),
    // stabilised so the reveal can't blank the relayed selection.
    var picks = cls.selected.concat(cls.hit).sort(function (a, b) {
      return a - b;
    });
    picks = updateStableSelection(picks, cls.hit.length + cls.miss.length > 0);
    var selSig = picks.join(",");
    if (selSig !== readerSelSig) {
      readerSelSig = selSig;
      bridge.sel = picks;
      writeBridge();
    }
    // Keep the heat tint on each tile across the game's own re-renders.
    if (paintHues) applyPaint();
    // Relay the board rect (+ our viewport, for projection) so the panel can
    // dock against the board's real on-screen position in the outer page.
    var br = tilesRect(cls);
    if (br) {
      var rectSig = [
        Math.round(br.left),
        Math.round(br.top),
        Math.round(br.right),
        Math.round(br.bottom),
        window.innerWidth,
        window.innerHeight
      ].join(",");
      if (rectSig !== readerRectSig) {
        readerRectSig = rectSig;
        bridge.br = {
          left: br.left,
          top: br.top,
          right: br.right,
          bottom: br.bottom,
          width: br.width,
          height: br.height
        };
        bridge.vw = window.innerWidth || 0;
        bridge.vh = window.innerHeight || 0;
        writeBridge();
      }
    }
    // Relay the paytable so the panel knows which match counts pay out.
    // Scraping it walks every element in the frame, so at most once a second.
    var now = Date.now();
    if (now - lastPtScrape >= 1000) {
      lastPtScrape = now;
      E.updatePaytableFromDOM();
      var ptSig = JSON.stringify(E.getPaytables());
      if (ptSig !== readerPtSig) {
        readerPtSig = ptSig;
        bridge.pt = E.getPaytables();
        writeBridge();
      }
    }
    // Report where the actual game content ends, as a fraction of the iframe's
    // height, so the panel can align its bottom to the content.
    var gc =
      qsDeep('[data-testid="game-container"]') ||
      qsDeep(".game-content-keno") ||
      qsDeep(".game-container") ||
      qsDeep(".keno-field");
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
    checkDrawFromDOM();
  }

  function onReaderKey(e) {
    if (E.hotkeyMatches(e)) {
      e.preventDefault();
      e.stopPropagation();
      var sel = [];
      try {
        sel = readSelection();
      } catch (err) {}
      bridge.saveSeq = (bridge.saveSeq || 0) + 1;
      bridge.saveSel = sel;
      writeBridge(true);
    }
  }

  function runReader() {
    window.addEventListener("keydown", onReaderKey, true);
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "local" && changes[CMD_KEY]) handleCmd(changes[CMD_KEY].newValue);
      });
      // Baseline so a stale stored command isn't replayed on page load.
      chrome.storage.local.get(CMD_KEY, function (res) {
        var c = res && res[CMD_KEY];
        if (c && c.seq) lastCmdSeq = c.seq;
      });
    } catch (e) {}
    // Continue the event counters from any stored bridge so the panel (which
    // baselines off the same stored value) doesn't ignore our new events.
    var start = function () {
      observeBoardMutations();
      setInterval(readerTick, 250);
      E.log("reader ready");
    };
    try {
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (b) {
          bridge.drawSeq = b.drawSeq || 0;
          bridge.saveSeq = b.saveSeq || 0;
          bridge.toggleSeq = b.toggleSeq || 0;
          bridge.betSeq = b.betSeq || 0;
        }
        start();
      });
    } catch (e) {
      start();
    }
  }

  // ---------------------------------------------------------------------------
  // Panel / combined: consume the reader's bridge
  // ---------------------------------------------------------------------------
  var lastDrawSeq = 0;
  var lastSaveSeq = 0;
  var lastToggleSeq = 0;
  var lastBetSeq = 0;
  var lastSeedSeq = 0;

  function handleBridge(b) {
    if (!b) return;
    if (b.betSeq && b.betSeq > lastBetSeq) {
      lastBetSeq = b.betSeq;
      E.clearHitFx(); // reader saw a new bet fire — drop the stale notification
    }
    if (b.seedSeq && b.seedSeq > lastSeedSeq) {
      lastSeedSeq = b.seedSeq;
      E.onSeedReset(); // reader saw a seed rotation — reset for the new seed
    }
    if (typeof b.cf === "number") panelContentFrac = b.cf;
    if (b.br && typeof b.br.right === "number") {
      panelBoardRect = b.br;
      panelBoardViewport = { w: b.vw || 0, h: b.vh || 0 };
    }
    if (Array.isArray(b.sel) && b.sel.join(",") !== lastSelection.join(",")) {
      lastSelection = b.sel;
      E.updateSelectionDisplay();
    }
    if (b.pt) E.mergePaytables(b.pt);
    if (Array.isArray(b.draws)) {
      b.draws.forEach(function (d) {
        if (d && d.seq > lastDrawSeq) {
          lastDrawSeq = d.seq;
          if (Array.isArray(d.drawn)) {
            E.processDraw({ nonce: E.nextDomNonce(), drawn: d.drawn, source: "dom" });
          }
        }
      });
    }
    if (b.saveSeq && b.saveSeq > lastSaveSeq) {
      lastSaveSeq = b.saveSeq;
      if (Array.isArray(b.saveSel)) lastSelection = b.saveSel;
      E.saveCurrentSelection();
    }
    if (b.toggleSeq && b.toggleSeq > lastToggleSeq) {
      lastToggleSeq = b.toggleSeq;
      E.toggleOpen();
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[BRIDGE_KEY]) return;
    handleBridge(changes[BRIDGE_KEY].newValue);
  }

  function startBridgeConsumer() {
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {}
    try {
      chrome.storage.local.get(BRIDGE_KEY, function (res) {
        var b = res && res[BRIDGE_KEY];
        if (!b) return;
        lastDrawSeq = b.drawSeq || 0;
        lastSaveSeq = b.saveSeq || 0;
        lastToggleSeq = b.toggleSeq || 0;
        lastBetSeq = b.betSeq || 0;
        lastSeedSeq = b.seedSeq || 0;
        if (Array.isArray(b.sel)) lastSelection = b.sel;
        if (b.br && typeof b.br.right === "number") {
          panelBoardRect = b.br;
          panelBoardViewport = { w: b.vw || 0, h: b.vh || 0 };
        }
        if (b.pt) E.mergePaytables(b.pt);
        E.updateSelectionDisplay();
      });
    } catch (e2) {}
  }

  // ---------------------------------------------------------------------------
  // Docked layout
  // ---------------------------------------------------------------------------
  var DOCK_W = 365;

  function boardRect() {
    var field = qsDeep(".keno-field");
    if (field) {
      var fr = field.getBoundingClientRect();
      if (fr.width > 0) return fr;
    }
    var cls = classifyTiles();
    return tilesRect(cls);
  }

  function gameContainerRect() {
    var el =
      qsDeep('[data-testid="game-container"]') ||
      qsDeep(".game-container") ||
      qsDeep(".game-content-keno") ||
      qsDeep(".game-content");
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function boardDockAnchor() {
    var board = boardRect();
    if (!board) return null;
    var box = gameContainerRect();
    if (box && board.left >= box.left - 4 && board.right <= box.right + 4) {
      return {
        left: board.left,
        right: Math.max(board.right, box.right),
        top: box.top,
        bottom: box.bottom,
        width: board.width,
        height: box.height
      };
    }
    return board;
  }

  function gameIframe() {
    var frames = qsaDeep("iframe");
    var best = null;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var r = f.getBoundingClientRect();
      if (r.width < 300 || r.height < 220) continue;
      var src = (f.getAttribute("src") || "").toLowerCase();
      var score = 0;
      if (src.indexOf("keno") !== -1) score += 5;
      if (src.indexOf("thrill") !== -1) score += 3;
      if (src.indexOf("/game") !== -1 || src.indexOf("casino") !== -1) score += 2;
      if (!score && /keno/i.test(location.href)) score = 1;
      if (score && (!best || score > best.score || r.width * r.height > best.area)) {
        best = { el: f, score: score, area: r.width * r.height };
      }
    }
    return best ? best.el : null;
  }

  // The *visible* game box in the outer page (the card around the iframe).
  function gameBoxRect() {
    var container = gameContainerRect();
    if (container) return container;
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

  // Project the reader's board rect (iframe-local) into the outer page through
  // the visible game box, so the panel docks against the board's true edge.
  function readerBoardAnchor() {
    if (!panelBoardRect || !panelBoardViewport) return null;
    var iframe = gameIframe();
    if (!iframe) return null;
    var box = gameBoxRect() || iframe.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    var sx = panelBoardViewport.w ? box.width / panelBoardViewport.w : 1;
    var sy = panelBoardViewport.h ? box.height / panelBoardViewport.h : 1;
    var left = box.left + panelBoardRect.left * sx;
    var top = box.top + panelBoardRect.top * sy;
    var right = box.left + panelBoardRect.right * sx;
    var bottom = box.top + panelBoardRect.bottom * sy;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function dockLayout() {
    var root = E.getRoot();
    if (!root) return;
    var s = E.state.settings;
    var margin = 8;
    var gap = 12;
    var width = DOCK_W;
    var anchor; // rect whose right edge we dock against, plus vertical extent
    if (ROLE === "panel") {
      anchor = readerBoardAnchor() || gameBoxRect();
      // Trim the bottom to where the game content actually ends (the card is a
      // fixed 16:9 box that's taller than the content).
      if (!panelBoardRect && anchor && panelContentFrac != null && panelContentFrac < 0.999) {
        var b2 = anchor.top + panelContentFrac * anchor.height;
        anchor = { left: anchor.left, top: anchor.top, right: anchor.right, bottom: b2, width: anchor.width, height: b2 - anchor.top };
      }
    } else {
      anchor = boardDockAnchor();
      if (!anchor) {
        var content =
          qsDeep(".game-content-keno") || qsDeep(".game-content") || qsDeep('[data-testid="game-container"]');
        var cr = content && content.getBoundingClientRect();
        var container = qsDeep(".game-container") || qsDeep('[data-testid="game-container"]');
        var gr = (container && container.getBoundingClientRect()) || cr;
        if (cr && gr && cr.width > 0) {
          anchor = { left: cr.left, right: cr.right, top: gr.top, bottom: gr.bottom, width: cr.width, height: gr.height };
        }
      }
    }

    var left, top, height;
    if (anchor) {
      if (anchor.bottom == null && anchor.height != null) anchor.bottom = anchor.top + anchor.height;
      var dockLeft = anchor.right + gap; // sits just to the right of the board
      var avail = window.innerWidth - margin - dockLeft;
      var defWidth = avail >= 220 ? Math.min(DOCK_W, avail) : DOCK_W;
      var navB = E.navBottom();
      var defHeight;
      if (anchor.top >= navB) {
        // Not scrolled: line the panel's top and bottom up with the game card.
        top = anchor.top;
        defHeight = Math.max(Math.min(anchor.bottom, window.innerHeight) - top, 260);
      } else {
        // Scrolled under the nav: pin below it, keep a constant height.
        top = navB;
        defHeight = Math.max(Math.min(anchor.height, window.innerHeight - top), 260);
      }
      width = s.panelW ? E.clampW(s.panelW) : defWidth;
      height = s.panelH ? E.clampH(s.panelH) : defHeight;
      // Anchor the left edge to the board and grow into the empty space on the
      // RIGHT first; only push left (over the board) once the right runs out.
      left = dockLeft;
      if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - margin - width;
      }
    } else {
      width = s.panelW ? E.clampW(s.panelW) : DOCK_W;
      top = 70;
      height = s.panelH ? E.clampH(s.panelH) : window.innerHeight - top - margin;
      left = window.innerWidth - margin - width;
    }

    // Keep everything inside the viewport (handles browser zoom / small windows).
    width = Math.min(width, window.innerWidth - 2 * margin);
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(4, Math.min(top, window.innerHeight - 80));
    height = Math.max(160, Math.min(height, window.innerHeight - top - margin));

    E.setStyle(root, {
      position: "fixed",
      left: left + "px",
      top: top + "px",
      right: "auto",
      width: width + "px",
      height: height + "px", // fixed height; the list scrolls inside
      maxHeight: height + "px"
    });
  }

  // ---------------------------------------------------------------------------
  // Bottom toggle button (next to Thrill's favourite heart on the game toolbar)
  // ---------------------------------------------------------------------------
  // Gem outline in currentColor; adopts the favourite (heart) button's classes
  // so it matches Thrill's toolbar buttons (shared shape with the other sites).
  var TOGGLE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20"/><path d="M8 9l4 12 4-12"/></svg>';
  // No tooltip (removed — the gem is self-explanatory).
  function styleToggle(btn, refClass) {
    if (refClass) {
      btn.className = refClass;
      // Copied class's text colour is dark; Thrill's other toolbar icons are
      // white, so force white + centering (the button itself is only `relative`).
      btn.style.cssText =
        "cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:#fff";
    } else {
      btn.className = "";
      btn.style.cssText =
        "all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;" +
        "width:42px;height:42px;min-width:42px;min-height:42px;flex:0 0 42px;margin:0;" +
        "border-radius:999px;color:#dde3f0;background:#262e42;border:1px solid #39435f;line-height:0;";
    }
  }
  // Reflect the open state like the native tools: open → "selected" green
  // surface + green icon; closed → the heart's default surface + white icon.
  function setToggleActive(btn, refClass) {
    if (!btn || !refClass) return;
    var open = E.state.settings.open;
    var cls = open ? refClass.replace(/bg-button-secondary/g, "bg-surface-selected-secondary") : refClass;
    if (btn.className !== cls) btn.className = cls;
    btn.style.cssText =
      "cursor:pointer;display:inline-flex;align-items:center;justify-content:center;color:" +
      (open ? "#3ecf8e" : "#fff");
  }
  function makeToggleBtn(refClass) {
    var btn = document.createElement("button");
    btn.id = "kt-bottom-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Keno Tracker");
    styleToggle(btn, refClass);
    btn.innerHTML = TOGGLE_SVG;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      onToggleClick();
    });
    return btn;
  }

  function findFavoriteButton() {
    var buttons = qsaDeep("button");
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute("aria-label") || "").toLowerCase();
      if (label.indexOf("favorite") !== -1) return buttons[i];
    }
    return null;
  }

  function removeBottomButton() {
    var btn = qsDeep("#kt-bottom-toggle") || document.getElementById("kt-bottom-toggle");
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }
  function ensureBottomButton() {
    try {
      // Keno page only. The favorite-button heuristic matches the heart on
      // every Originals game toolbar — and even the homepage card hover — so
      // without this gate the diamond followed the user around the casino.
      if (!kenoActive()) {
        removeBottomButton();
        return;
      }
      var btn = qsDeep("#kt-bottom-toggle") || document.getElementById("kt-bottom-toggle");
      var fav = findFavoriteButton();
      if (fav && fav.parentNode) {
        // Copy the heart's classes so the toggle is styled identically to it.
        var refClass = typeof fav.className === "string" ? fav.className : null;
        if (!btn) btn = makeToggleBtn(refClass);
        // Active look: while the panel is open, switch to the "selected" surface
        // (green bg, like the other tools when active) + a green icon.
        setToggleActive(btn, refClass);
        if (btn.parentNode !== fav.parentNode || btn.nextSibling !== fav) {
          fav.parentNode.insertBefore(btn, fav);
        }
        return;
      }
      // Favourite button not found yet — float near the game box as a fallback.
      if (!btn) {
        btn = makeToggleBtn(null);
        document.body.appendChild(btn);
      }
      if (btn.parentNode !== document.body) document.body.appendChild(btn);
      var box = gameContainerRect();
      var size = 40;
      var pad = 16;
      var left = window.innerWidth - size - pad;
      var top = 92;
      if (box) {
        left = Math.min(box.right - size - pad, window.innerWidth - size - pad);
        top = box.bottom - size - pad;
      }
      left = Math.max(8, left);
      top = Math.max(8, Math.min(top, window.innerHeight - size - 8));
      btn.style.position = "fixed";
      btn.style.left = left + "px";
      btn.style.top = top + "px";
      btn.style.right = "auto";
      btn.style.bottom = "auto";
      btn.style.zIndex = "2147483645";
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Roles + visibility
  // ---------------------------------------------------------------------------
  function kenoActive() {
    // URL updates synchronously on Thrill's SPA navigation, so this flips the
    // instant you leave the keno page (no waiting for the iframe to be removed).
    return /keno/i.test(location.href);
  }

  function hasBoardDom() {
    if (qsDeep(".keno-field, .field-button")) return true;
    try {
      return findTiles().size >= Math.max(20, Math.floor((E.state.settings.boardMax || 40) * 0.7));
    } catch (e) {
      return false;
    }
  }
  function isGameHost() {
    return /(^|\.)(games?|play|originals)\.thrill\.com$/i.test(location.hostname);
  }

  function runPanel() {
    E.buildShell();
    E.getRoot().style.display = "none"; // shown only while keno is active
    window.addEventListener("keydown", E.onKeyDown, true);
    window.addEventListener("resize", E.scheduleLayout);
    window.addEventListener("scroll", E.scheduleLayout, true);
    startBridgeConsumer();
    setInterval(function () {
      var root = E.getRoot();
      if (!root) return;
      var active = kenoActive();
      root.style.display = active ? "" : "none";
      ensureBottomButton(); // injects on keno, removes itself elsewhere
      if (active && hasBoardDom()) {
        // The user SPA-navigated here and the board lives in this same frame —
        // that's the combined setup, so take the combined code paths (draws
        // process locally instead of round-tripping the storage bridge).
        if (ROLE === "panel") {
          ROLE = "combined";
          E.log("promoted panel → combined (board appeared after SPA nav)");
        }
        observeBoardMutations();
        checkDrawFromDOM();
        if (paintHues) applyPaint();
        E.updateSelectionDisplay();
      }
      if (active && E.state.settings.open && E.state.settings.mode === "docked") E.layout();
    }, 200);
    // Hide/show instantly on SPA route changes (net-hook forwards History API
    // calls as __kt_nav; popstate covers back/forward).
    var onNav = function () {
      var root = E.getRoot();
      if (root) root.style.display = kenoActive() ? "" : "none";
      ensureBottomButton();
    };
    document.addEventListener("__kt_nav", onNav);
    window.addEventListener("popstate", onNav);
    // Re-paint the board if heat-board view was left on (reader may still be
    // booting; a short delay covers the usual iframe load order).
    if (E.state.settings.heatBoard) setTimeout(E.syncBoardHeat, 1500);
    E.log("panel ready");
  }

  function runCombined() {
    E.buildShell();
    window.addEventListener("keydown", E.onKeyDown, true);
    window.addEventListener("resize", E.scheduleLayout);
    window.addEventListener("scroll", E.scheduleLayout, true);
    startBridgeConsumer();
    document.addEventListener(
      "click",
      function (e) {
        if (e.target.closest && e.target.closest("#keno-tracker-root")) return;
        setTimeout(E.updateSelectionDisplay, 70);
        setTimeout(E.updateSelectionDisplay, 320);
      },
      true
    );
    observeBoardMutations();
    setInterval(checkDrawFromDOM, 250);
    setInterval(function () {
      observeBoardMutations(); // new shadow roots appear as the SPA renders
      ensureBottomButton(); // injects on keno, removes itself elsewhere
      var active = kenoActive();
      var root = E.getRoot();
      if (root) root.style.display = active ? "" : "none";
      if (paintHues) applyPaint(); // survive the game's tile re-renders
      if (active && E.state.settings.open && root) {
        E.updateSelectionDisplay();
        if (E.state.settings.mode === "docked") E.layout();
      }
    }, 700);
    var onNav = function () {
      var root = E.getRoot();
      if (root) root.style.display = kenoActive() ? "" : "none";
      ensureBottomButton();
    };
    document.addEventListener("__kt_nav", onNav);
    window.addEventListener("popstate", onNav);
    if (E.state.settings.heatBoard) setTimeout(E.syncBoardHeat, 1000);
    E.log("combined ready");
  }

  // ---------------------------------------------------------------------------
  // Adapter surface
  // ---------------------------------------------------------------------------
  window.__KT_SITE = {
    id: "thrill",
    exportTag: "thrill-keno-tracker",
    storageKey: "thrillKenoTrackerState",
    dockW: 365,
    floatW: 385,
    attach: function (engine) {
      E = engine;
    },
    gameActive: kenoActive,
    classifyTiles: classifyTiles, // engine-wide override (shadow DOM + SVG tiles)
    readPaytable: readPaytable, // engine-wide override (plain "10x" multipliers)
    readSelection: readSelection,
    dockLayout: dockLayout,
    // On-board heat painting is deliberately DISABLED on Thrill (user
    // decision: the tints fought the game's own tile styling during reveals).
    // The hot/cold popup's Board toggle is layout-only here; paint requests
    // broadcast an unpaint instead so any stale tint always clears.
    paintBoard: function () {
      sendCmd("unpaint");
    },
    unpaintBoard: function () {
      sendCmd("unpaint");
    },
    // Glow IS enabled on Thrill (unlike heat paint): additive ring, not a
    // background fill — if it looks scuffed live, neuter this one function.
    glowBoard: function (items, ms) {
      sendCmd("glow", null, { items: items, ms: ms });
    },
    onHistoryReset: function () {
      domDraw = { lastSig: null };
    },
    init: function () {
      // Network feed from net-hook.js (MAIN world): the authoritative bet/draw
      // source. The listener goes in every frame — the bet request fires from
      // whichever frame hosts the game.
      try {
        netHookPresent = document.documentElement.getAttribute("data-kt-nethook") === "1";
        document.addEventListener(NET_EVT, onNetEvent);
        document.addEventListener("__kt_seed_reset", onSeedResetEvent);
        window.addEventListener("keydown", onDebugKey, true); // Alt+D tile dump
      } catch (e) {}
      var isTop = window === window.top;
      var onKenoPage = /keno/i.test(location.href);
      var gameHere = hasBoardDom() || (isGameHost() && onKenoPage) || (!isTop && onKenoPage);
      if ((gameHere || onKenoPage) && isTop) {
        ROLE = "combined"; // top page owns the UI and may also own the board
        runCombined();
      } else if (gameHere && !isTop) {
        ROLE = "reader"; // keno board iframe
        runReader();
      } else if (isTop) {
        ROLE = "panel"; // outer Thrill page: panel shows when keno is active
        runPanel();
      } else {
        ROLE = "none"; // unrelated subframe
      }
      E.log("role", ROLE, "netHook", netHookPresent);
    }
  };
})();
