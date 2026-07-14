/*
 * Keno Tracker — Stake site adapter (loaded BEFORE games/keno/engine.js).
 *
 * Stake renders keno directly in the top frame (no iframe), so the top frame
 * does everything ("combined"); subframes stay inert.
 *
 * Draw source: the NETWORK is authoritative. net-hook.js (MAIN world) wraps
 * fetch/XHR, gates on keno bet requests, and forwards each response via a
 * `__kt_net_payload` CustomEvent — one response == exactly one bet, which is
 * what fixes the missed/double-counted instant + autobets that DOM polling
 * suffers from. Stake's response carries no nonce (we synthesise a sequential
 * one, deduped on the unique bet id) and its numbers are 0-indexed (shifted
 * into 1..40 board labels). DOM counting remains only as a fallback when the
 * hook isn't installed.
 */
(function () {
  "use strict";

  var E = null; // engine API, received in attach()
  var ROLE = "none"; // "combined" (top frame) | "none"

  var STAKE_HOST_RE = /(^|\.)((stake\.(com|ac|games|bet|pet|mba|jp|bz|ceo|krd))|staketr\.com|stake10(01|02|03|17|22|39)\.com)$/i;
  var DOM_DRAW_SETTLE_MS = 1200;
  var NET_EVT = "__kt_net_payload"; // CustomEvent name from net-hook.js (MAIN world)
  var NET_GATE_MS = 8000; // while the network is feeding draws, ignore DOM-counted ones
  var INSTANT_RATE_MS = 1100; // bets closer together than this can't be animating

  var networkActive = false; // a real (networked) draw source is working
  var lastNetAt = 0; // ms timestamp of the last authoritative network draw
  var netOffset = null; // 0 or +1: calibrated index shift for network numbers
  var netHookPresent = false; // net-hook.js is installed (DOM marker)
  var selEmptySince = 0; // when the board first read empty (debounces real clears)
  var stableSelection = []; // last non-reveal selection; steady through reveals
  var domDraw = { lastSig: null, pendingSig: null, pendingSince: 0, pendingTimer: null };
  var processedNetIds = []; // recent bet ids, capped — dedupes duplicate deliveries
  var pendingRelease = null; // a draw waiting on its reveal; flushed by the next bet (order-flush)

  // True when the network owns the count, so the DOM counter must stand down.
  // When net-hook is installed it is the ONLY counter (it sees every bet 1:1),
  // which is what prevents the first/instant bet being counted twice.
  function netOwnsCounting() {
    if (netHookPresent) return true;
    if (networkActive && Date.now() - lastNetAt < NET_GATE_MS) return true;
    return false;
  }

  function sortedSig(arr) {
    return arr
      .slice()
      .sort(function (a, b) { return a - b; })
      .join(",");
  }

  // ---------------------------------------------------------------------------
  // Network draws — the authoritative source
  // ---------------------------------------------------------------------------
  // Decide the 0/1 index shift. Stake is 0-indexed, which selectedNumbers makes
  // self-evident (it contains a 0, or +1 lines it up with the live board pick).
  // Calibrate once, then reuse for every draw so all numbers shift consistently.
  function calibrateOffset(selectedNet) {
    if (netOffset != null) return netOffset;
    if (selectedNet && selectedNet.length) {
      // A 0 in the picks proves 0-indexing (the board has no tile 0).
      if (selectedNet.indexOf(0) !== -1) {
        netOffset = 1;
        return netOffset;
      }
      // Otherwise match the picks against the board selection (1-indexed).
      var live = stableSelection || [];
      if (live.length === selectedNet.length) {
        var board = sortedSig(live);
        if (sortedSig(selectedNet) === board) netOffset = 0;
        else if (sortedSig(selectedNet.map(function (n) { return n + 1; })) === board) netOffset = 1;
        if (netOffset != null) return netOffset;
      }
    }
    return null; // undecided — caller falls back per-draw
  }

  function shiftNums(nums, selectedNet) {
    var off = calibrateOffset(selectedNet);
    if (off == null) off = nums.indexOf(0) !== -1 ? 1 : 0; // fallback until calibrated
    if (!off) return nums.slice();
    return nums.map(function (n) { return n + off; });
  }

  // Pull the keno bet result out of the response. Returns { id, drawn, selected }
  // or null. Walks the object so it works whether or not Stake wraps it in a
  // `data` envelope.
  function parseKenoBet(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 8) return null;
    var st = node.state;
    var drawn =
      (st && Array.isArray(st.drawnNumbers) && st.drawnNumbers) ||
      (Array.isArray(node.drawnNumbers) && node.drawnNumbers) ||
      null;
    if (drawn && drawn.length) {
      var sel =
        (st && Array.isArray(st.selectedNumbers) && st.selectedNumbers) ||
        (Array.isArray(node.selectedNumbers) && node.selectedNumbers) ||
        null;
      return {
        id: typeof node.id === "string" ? node.id : null,
        drawn: drawn.slice(),
        selected: sel ? sel.slice() : null
      };
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = parseKenoBet(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }

  function seenNetId(id) {
    if (!id) return false;
    if (processedNetIds.indexOf(id) !== -1) return true;
    processedNetIds.push(id);
    if (processedNetIds.length > 300) processedNetIds.splice(0, processedNetIds.length - 300);
    return false;
  }

  // Sorted signature of the tiles currently revealed on the board (hit ∪ miss).
  function boardRevealedSig() {
    try {
      var cls = E.classifyTiles();
      return cls.hit.concat(cls.miss).sort(function (a, b) { return a - b; }).join(",");
    } catch (e) {
      return "";
    }
  }

  // Release `cb` once the board shows this bet's result. Two triggers:
  //   1. The reveal matches the draw's own numbers (`newSig`) — exact, fires
  //      the moment the last tile lands;
  //   2. A full set of drawCount tiles whose signature differs from `prevSig`
  //      (what was on the board when the bet settled) — offset-independent
  //      backup in case the network↔board label mapping is ever off.
  // The cap is just a safety net if the board read fails entirely. The previous
  // result still sitting on the board (same as prevSig, different from newSig)
  // does NOT release early — that was the spoiler we were avoiding.
  function whenNewReveal(prevSig, newSig, cap, cb) {
    var need = E.state.settings.drawCount || 10;
    var start = Date.now();
    (function poll() {
      var sig = boardRevealedSig();
      var shownCount = sig ? sig.split(",").length : 0;
      if (
        sig === newSig ||
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
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    var bet = parseKenoBet(data);
    if (!bet || !bet.drawn.length) {
      E.log("net payload had no keno draw");
      return;
    }
    if (seenNetId(bet.id)) return; // duplicate delivery of the same bet

    // ORDER-FLUSH: a previous bet's release still waiting on its reveal? This
    // new response proves that bet settled (its result was on the board until
    // now), so flush it FIRST. Without this, instant bets coming faster than
    // the 50ms reveal poll left releases pending; each then fired LATE on a
    // newer bet's board via whenNewReveal's "full board ≠ prev" trigger —
    // counting several bets behind and painting a stale glow on the wrong
    // board, which "caught up" a bet at a time (the exact reported symptom).
    if (pendingRelease) {
      var pr = pendingRelease;
      pendingRelease = null;
      pr();
    }

    // A new bet just fired — the previous nonce's hit glow and notification
    // come off NOW (not when this draw finishes revealing).
    clearGlow();
    try {
      E.clearHitFx();
    } catch (eFx) {}

    var drawn = shiftNums(bet.drawn, bet.selected);
    var now = Date.now();
    // Rapid bets (autobet / fast instant) change the board faster than we can
    // poll for the reveal, so release them immediately. Spaced bets wait for
    // the board to show this bet's result — covering manual-instant + animated.
    var gap = lastNetAt ? now - lastNetAt : Infinity;
    var rapid = gap < INSTANT_RATE_MS;
    // What's on the board right now vs this draw's own signature. On INSTANT
    // bets the board paints the result before this response handler runs, so
    // the "current" board already IS the new draw — comparing the two detects
    // instant mode deterministically, and we show the result immediately
    // instead of waiting for a board change that will never come.
    var prevSig = boardRevealedSig();
    var newSig = drawn.slice().sort(function (a, b) { return a - b; }).join(",");

    networkActive = true;
    lastNetAt = now;
    // From this response until the reveal has fully landed, selection reads
    // are in "result phase" EVEN IF no tile reads as revealed yet — in that
    // pre-reveal window drawn tiles can already carry bogus "selected" flags
    // while their status still says hidden, which a naive read would adopt.
    revealPhaseUntil = now + (E.state.settings.revealDelayMs || 2000) + 800;
    // The response's selectedNumbers are the player's ACTUAL picks for this
    // bet, straight from Stake's server — sync the held selection from them
    // (DOM flags lie during results; this never does). Shifted like drawn.
    if (bet.selected && bet.selected.length) {
      stableSelection = shiftNums(bet.selected, bet.selected).sort(function (a, b) {
        return a - b;
      });
      E.updateSelectionDisplay();
    }
    var instant = prevSig === newSig;
    E.log("NET draw", { id: bet.id, drawn: drawn, rapid: rapid, instant: instant });

    var released = false;
    var release = function () {
      if (released) return; // order-flush and the reveal poll can both fire
      released = true;
      if (pendingRelease === release) pendingRelease = null;
      E.processDraw({ nonce: E.nextDomNonce(), drawn: drawn, source: "net" });
    };

    // Rapid bets and already-revealed (instant) bets shouldn't wait.
    if (rapid || instant) {
      release();
    } else {
      pendingRelease = release;
      whenNewReveal(prevSig, newSig, E.state.settings.revealDelayMs || 2000, release);
    }
  }

  function onNetEvent(e) {
    try {
      handleNetPayload(e && e.detail);
    } catch (err) {}
  }

  // Seed rotation (net-hook.js forwards the rotateSeedPair response). Stake keno
  // is always combined (top frame), so the engine resets directly. Shape-check
  // the new activeServerSeed before acting so a stray forward can't wipe stats.
  var pendingRevealNonce = { nonce: null, ts: 0 };
  function onSeedResetEvent(e) {
    try {
      var d = JSON.parse(e && e.detail);
      var rot = d && d.data && d.data.rotateSeedPair;
      if (rot && rot.clientSeed) {
        // Snapshot the nonce reached on the seed we're retiring, BEFORE the reset
        // wipes it — the oracle scans "next hit" forward from here. The net-hook
        // then fetches the retired seed's plaintext (serverSeedByHash) and fires
        // __kt_seed_plain, handled below. Fully hands-free — no bet/iid/panel.
        pendingRevealNonce = { nonce: (E.state.history && E.state.history.lastNonce) || 0, ts: Date.now() };
        E.onSeedReset();
      }
    } catch (err) {}
  }

  // Zero-click reveal from the net-hook (serverSeedByHash → the just-retired
  // seed's plaintext). Verified in-engine by SHA256(seed)===seedHash.
  function onSeedPlainEvent(e) {
    try {
      var d = JSON.parse(e && e.detail);
      if (!d || !d.server || !d.client) return;
      var nonce = Date.now() - pendingRevealNonce.ts < 20000 ? pendingRevealNonce.nonce : null;
      E.onSeedRevealed(d.server, d.client, nonce, d.seedHash);
    } catch (err) {}
  }

  // Seed REVEAL — net-hook.js forwards any GraphQL carrying a plaintext server
  // seed; the bet-detail query (data.bet.bet) exposes a rotated-away seed when
  // the user opens a past keno bet. Feed it to the oracle (verified in-engine by
  // SHA256(seed) === seedHash). The bet's nonce is the anchor to scan forward
  // from — opening your LAST bet on the seed makes "next hit" mean exactly that.
  function onSeedRevealEvent(e) {
    try {
      var d = JSON.parse(e && e.detail);
      var b = d && d.data && d.data.bet;
      if (b && b.bet) b = b.bet;
      if (!b || (b.game && String(b.game).toLowerCase() !== "keno")) return;
      var ss = b.serverSeed, cs = b.clientSeed;
      if (!ss || !cs || !ss.seed || !cs.seed) return;
      if (!/^[0-9a-f]{32,}$/i.test(ss.seed) || ss.seed === ss.seedHash) return; // needs the revealed plaintext, not just the hash
      E.onSeedRevealed(ss.seed, cs.seed, b.nonce != null ? b.nonce : null, ss.seedHash);
    } catch (err) {}
  }

  // ---------------------------------------------------------------------------
  // Selection: hold a steady view of the player's picks through the reveal
  // ---------------------------------------------------------------------------
  // While a result is on screen Stake briefly drops the selected marker from
  // picks that weren't drawn, so a naive read makes the selection flicker or
  // vanish from the panel (and the "currently playing" highlight with it). We
  // only adopt a new selection from a clean frame (no result showing) and
  // require an empty board to persist briefly before reporting a genuine clear.
  var revealPhaseUntil = 0; // a reveal is in flight (set when the bet response lands)
  function readSelection() {
    var cls = E.classifyTiles();
    var revealed = cls.hit.concat(cls.miss);
    // Result phase covers visible reveals AND the pre-reveal window after a
    // bet response, when tiles already carry bogus flags but read unrevealed.
    var resultPhase = revealed.length > 0 || Date.now() < revealPhaseUntil;
    var picks = cls.selected.concat(cls.hit).sort(function (a, b) {
      return a - b;
    });
    return updateStableSelection(picks, resultPhase);
  }
  // While ANY result is on screen, the board's selection flags are simply not
  // trustworthy on Stake (drawn-but-unpicked tiles can carry data-selected,
  // masquerading as picks or even hits) — so we never read them then. We hold
  // the last known selection instead, and that held value is synced from the
  // bet response's own selectedNumbers (the server's truth) on every bet — see
  // handleNetPayload. Clean frames (board fully cleared) read normally.
  function updateStableSelection(picks, resultPhase) {
    if (resultPhase) {
      selEmptySince = 0; // a result is showing → hold the last stable pick
      return stableSelection.length ? stableSelection.slice() : picks.slice();
    }
    if (picks.length) {
      selEmptySince = 0;
      stableSelection = picks.slice();
      return stableSelection.slice();
    }
    // No picks and no result on screen.
    if (!stableSelection.length) return [];
    if (!selEmptySince) selEmptySince = Date.now();
    if (Date.now() - selEmptySince > 700) {
      stableSelection = []; // sustained empty board → the table was cleared
      return [];
    }
    return stableSelection.slice(); // transient gap → keep the last selection
  }

  // ---------------------------------------------------------------------------
  // DOM draw detection — fallback only (the network feed is the normal counter)
  // ---------------------------------------------------------------------------
  function commitDraw(arr, force) {
    // When the network feed owns the count (real bet events, no races), stand
    // the DOM counter down so a bet isn't recorded twice.
    if (netOwnsCounting()) return;
    var expected = E.state.settings.drawCount || 10;
    if (!arr || arr.length !== expected) return;
    arr = arr.slice().sort(function (a, b) {
      return a - b;
    });
    var sig = arr.join(",");
    if (sig === domDraw.lastSig) return;
    if (sig !== domDraw.pendingSig) {
      domDraw.pendingSig = sig;
      domDraw.pendingSince = Date.now();
      clearTimeout(domDraw.pendingTimer);
      domDraw.pendingTimer = null;
    }
    if (!force && Date.now() - domDraw.pendingSince < DOM_DRAW_SETTLE_MS) {
      clearTimeout(domDraw.pendingTimer);
      domDraw.pendingTimer = setTimeout(function () {
        commitDraw(arr);
      }, DOM_DRAW_SETTLE_MS + 50);
      return;
    }
    clearTimeout(domDraw.pendingTimer);
    domDraw.pendingTimer = null;
    domDraw.lastSig = sig;
    domDraw.pendingSig = null;
    E.processDraw({ nonce: E.nextDomNonce(), drawn: arr, source: "dom" });
  }

  // Track "revealed" tiles directly from MutationRecords (catches reveals whose
  // DOM state lasts under a frame). Reset after every commit and whenever the
  // board clears, otherwise the previous draw's numbers linger and get merged
  // into the next one — instant bet has no empty-board gap between bets.
  var REVEAL_RE = /\b(revealed|is-revealed|drawn|hit|is-hit|isHit|match|is-match|miss|win|lose|result)\b/i;
  var revealSet = {};
  var revealCount = 0;
  var boardObserver = null;
  function resetRevealTracking() {
    revealSet = {};
    revealCount = 0;
  }
  function onBoardMutations(records) {
    // The observer is attached to document.body; ignore mutations when we're
    // not on the keno page (combined mode runs everywhere on Stake).
    if (ROLE === "combined" && !kenoActive()) return;
    var expected = E.state.settings.drawCount || 10;
    for (var i = 0; i < records.length; i++) {
      var m = records[i];
      var el = m.target;
      var cn = el && typeof el.className === "string" ? el.className : "";
      var t = (el.textContent || "").trim();
      if (!/^\d{1,2}$/.test(t)) continue;
      var num = parseInt(t, 10);
      if (num < 1 || num > E.state.settings.boardMax) continue;
      var hasRev = REVEAL_RE.test(cn);
      var hadRev = REVEAL_RE.test(m.oldValue || "");
      if (hasRev && !hadRev) {
        // A tile just became revealed → part of the current draw.
        if (!revealSet[num]) {
          revealSet[num] = 1;
          revealCount++;
        }
      } else if (!hasRev && hadRev) {
        // A tile lost its reveal class → the board is clearing for the next
        // draw. Drop the stale set so the incoming reveal accumulates clean.
        resetRevealTracking();
      }
      if (revealCount >= expected) {
        commitDraw(Object.keys(revealSet).map(Number), true);
        resetRevealTracking();
      }
    }
  }

  // Timer fallback: catches a reveal already on the board and keeps the
  // mutation-tracked set in sync with the DOM.
  function checkDrawFromDOM() {
    var cls;
    try {
      cls = E.classifyTiles();
    } catch (e) {
      return;
    }
    if (ROLE === "combined") E.updatePaytableFromDOM();
    var drawn = cls.hit.concat(cls.miss);
    var expected = E.state.settings.drawCount || 10;
    idleClearGlow(drawn.length); // drop a lingering glow once the result clears

    // A complete draw is on the board right now → commit it directly from this
    // snapshot. commitDraw dedupes by the sorted draw signature, so re-reading
    // the same draw across polls is harmless, while a new instant-bet draw (a
    // different signature) still commits even though the board never showed an
    // empty state between the two bets.
    if (drawn.length === expected) {
      commitDraw(drawn, true);
      resetRevealTracking();
      return;
    }

    // Board cleared (no revealed tiles) → drop any partial set so the next
    // reveal accumulates clean.
    if (drawn.length === 0) {
      resetRevealTracking();
      return;
    }

    // Partial reveal in progress (animated): accumulate so we still catch the
    // full set even if no single poll happens to see all `expected` at once.
    drawn.forEach(function (n) {
      if (!revealSet[n]) {
        revealSet[n] = 1;
        revealCount++;
      }
    });
    if (revealCount >= expected) {
      commitDraw(Object.keys(revealSet).map(Number), true);
      resetRevealTracking();
      domDraw.pendingSig = null;
      clearTimeout(domDraw.pendingTimer);
      domDraw.pendingTimer = null;
    }
  }

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

  // ---------------------------------------------------------------------------
  // Real-board heat painting (Board view)
  // ---------------------------------------------------------------------------
  // We must NOT restyle Stake's own tile elements: the tile's `.cover` face is
  // what Stake recolours for hover/selected (opaque purple) and it carries its
  // own copy of the number — overriding its background broke the selected look
  // and exposed a duplicate number. Instead each tile gets a tiny overlay div
  // of ours (pointer-events:none) tinted with that number's heat colour; CSS
  // hides it while the tile is hovered/selected/revealed so Stake's states
  // always show through untouched. Unpaint = remove the overlays.
  function unpaintBoardHeat() {
    // Query the page rather than keeping refs — svelte recreates tile nodes.
    var ovs = document.querySelectorAll(".kt-heat-overlay");
    for (var i = 0; i < ovs.length; i++) {
      try {
        ovs[i].parentNode.removeChild(ovs[i]);
      } catch (e) {}
    }
  }
  function paintBoardHeat(h) {
    if (!h) return;
    var cls;
    try {
      cls = E.classifyTiles();
    } catch (e) {
      return;
    }
    if (!cls.tiles || !cls.tiles.size) return;
    cls.tiles.forEach(function (el, n) {
      var hs = h.hues[n];
      var btn = (el.closest && el.closest('button, [role="button"]')) || el;
      if (!btn || !btn.querySelector) return;
      var ov = btn.querySelector(".kt-heat-overlay");
      // Statistically-normal numbers get NO tint — only real outliers light up,
      // so the board stays clean instead of getting a muddy wash everywhere.
      var sat = hs ? hs[1] : 0;
      if (!hs || sat < 8) {
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        return;
      }
      if (!ov) {
        ov = document.createElement("div");
        ov.className = "kt-heat-overlay";
        try {
          if (getComputedStyle(btn).position === "static") btn.style.position = "relative";
        } catch (e2) {}
        btn.appendChild(ov); // appended last → paints above the cover by DOM order
      }
      // Tint strength tracks significance: faint near neutral, bold at ±2.5σ.
      var alpha = 0.1 + (sat / 100) * 0.25;
      ov.style.background = "hsla(" + hs[0] + "," + hs[1] + "%,50%," + alpha.toFixed(2) + ")";
    });
  }

  // Hit glow: rings the matched numbers of just-hit configs in each config's
  // banner colour. box-shadow on the tile button is ADDITIVE — it can't break
  // the cover face the way background overrides did, and no read path looks
  // at shadows.
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
      cls = E.classifyTiles();
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
      var btn = (el.closest && el.closest('button, [role="button"]')) || el;
      btn.style.boxShadow = "0 0 0 3px " + col + ", 0 0 16px 3px " + col;
      btn.setAttribute("data-kt-glow", "1");
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
    var els = document.querySelectorAll("[data-kt-glow]");
    for (var i = 0; i < els.length; i++) {
      els[i].style.boxShadow = "";
      els[i].removeAttribute("data-kt-glow");
    }
    var rings = document.querySelectorAll(".kt-glow-ring, .kt-glow-dot");
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

  // The glow rides one nonce and normally clears at the next bet. But a manual
  // board clear (Clear Table / a manual<->auto switch) has no next bet, so the
  // glow would hang. Rule the user wants: glow visible only while the RESULT is
  // on the board. The reliable cross-site "result showing" signal is the
  // revealed tiles (hit ∪ miss) — misses (Stake `is-revealed`, Winna
  // `revealed`, Thrill `tile-lost`) read even when the hit tiles don't. Once
  // none remain (board cleared), drop the glow. Debounced so a transient
  // re-render read of 0 can't flicker it off mid-result.
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

  // ---------------------------------------------------------------------------
  // Bottom-toolbar toggle (diamond, docked next to Stake's Fairness button)
  // ---------------------------------------------------------------------------
  // Gem outline in currentColor; adopts a native footer icon button's classes
  // so it matches Stake's own toolbar buttons (shared shape with the others).
  var TOGGLE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20"/><path d="M8 9l4 12 4-12"/></svg>';
  // No tooltip (removed — the gem is self-explanatory). We still swallow the
  // gem's mouseover/out so Stake's DELEGATED footer tooltip doesn't pop a
  // neighbour's label on our hover (see makeToggleBtn).
  // We deliberately do NOT copy the native button's className onto the gem
  // (Stake's class-based hover lit up the real popout when the gem carried it).
  // Mirror the native icon's look with a SHORT explicit reset (NOT `all:unset`,
  // which serialises into a monstrous inline style of every longhand) — match
  // Stake's footer icon: transparent bg, subtle-on-surface colour, rounded-sm,
  // its real footprint. Stake's icons have NO hover background (the native btn
  // is `hover:bg-transparent`) — only the colour changes (ensureToggleStyle).
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
  // Hover/open colour for the gem, owned by us (we no longer carry Stake's
  // class). Colour only — no background — to match Stake's `hover:bg-transparent`
  // icons. !important so it beats the inline rest-colour setToggleActive holds.
  function ensureToggleStyle() {
    if (document.getElementById("kt-toggle-style")) return;
    var st = document.createElement("style");
    st.id = "kt-toggle-style";
    st.textContent = "#kt-bottom-toggle:hover{color:var(--ds-color-on-surface)!important}";
    (document.head || document.documentElement).appendChild(st);
  }
  function makeToggleBtn(ref) {
    var btn = document.createElement("button");
    btn.id = "kt-bottom-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Keno Tracker");
    styleToggle(btn, ref);
    btn.innerHTML = TOGGLE_SVG;
    // Belt-and-braces: swallow the gem's mouseover/out so Stake's delegated
    // footer tooltip handler can't pick a neighbour up on our hover (the real
    // fix is dropping the shared class in styleToggle).
    btn.addEventListener("mouseover", function (e) {
      e.stopPropagation();
    });
    btn.addEventListener("mouseout", function (e) {
      e.stopPropagation();
    });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      E.toggleOpen();
    });
    return btn;
  }

  // A footer ICON button (svg, no text, small) to dock beside + copy styling
  // from. Broader than the old data-icon-only match, which stopped resolving
  // and left the gem floating bottom-right. We dock at the END of its row.
  function footerIconBtn() {
    var btns = document.querySelectorAll(".game-footer button, [data-testid='game-frame'] button");
    var last = null;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === "kt-bottom-toggle") continue;
      if ((b.textContent || "").trim()) continue; // skip text buttons (Fairness, board tiles)
      if (!b.querySelector("svg")) continue; // must be an icon button
      var r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 80) last = b;
    }
    return last;
  }

  // Real box-to-box gap between adjacent native icons, measured off the last
  // two icon buttons. Searches DESCENDANTS (Stake wraps each icon, so a
  // direct-child scan finds nothing) and reflects however the row spaces them
  // (gap/margins/flush), so we don't guess.
  function measureIconGap(group, ref) {
    var all = group.querySelectorAll("button");
    var icons = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.id === "kt-bottom-toggle") continue;
      if ((b.textContent || "").trim()) continue;
      if (!b.querySelector("svg")) continue;
      icons.push(b);
    }
    if (icons.length < 2) return null;
    var a = icons[icons.length - 2].getBoundingClientRect();
    var c = icons[icons.length - 1].getBoundingClientRect();
    var g = c.left - a.right;
    return (g > -20 && g < 80) ? g : null;
  }

  // Active look: while the panel is open, hold the icon at the "on-surface"
  // (white) colour Stake uses on hover; otherwise the captured rest colour.
  // Driven inline now (no class to toggle) — :hover white comes from
  // ensureToggleStyle's !important rule, which still wins over this.
  function setToggleActive(btn) {
    var rest = btn.getAttribute("data-rest-color") || "";
    btn.style.color = E.state.settings.open ? "var(--ds-color-on-surface)" : rest;
  }
  function ensureBottomButton() {
    try {
      var btn = document.getElementById("kt-bottom-toggle");
      if (!kenoActive()) {
        if (btn) btn.style.display = "none";
        return;
      }
      var ref = footerIconBtn();
      if (ref && ref.parentNode && ref.parentNode.parentNode) {
        var group = ref.parentNode; // Stake's icon-button cluster
        var host = group.parentNode; // the footer row that holds it
        ensureToggleStyle();
        // (Re)create if missing OR if it was a float (position:fixed) — moving
        // a floated gem into the row would otherwise leak its float styles.
        if (!btn || btn.style.position === "fixed") {
          if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          btn = makeToggleBtn(ref);
        }
        setToggleActive(btn);
        btn.style.display = "";
        // Dock just RIGHT of Stake's icon group, parented to the group's HOST
        // and positioned ABSOLUTELY. Two reasons it must be OUTSIDE the group,
        // not inside it:
        //  (1) tooltip keep-alive — Stake keeps a tooltip visible while you
        //      hover ANYTHING inside the icon group, so a gem that's a child of
        //      the group showed the neighbouring "Open Mini Player" even with no
        //      shared class. Outside the group, hovering the gem reads as "left
        //      the group" and the tooltip hides.
        //  (2) geometry — an in-flow gem widened the group's box, which Stake's
        //      tooltip popper clamps to, shifting every native tooltip right.
        //      Out-of-flow (absolute) keeps the group's box byte-for-byte what
        //      Stake measures with no gem.
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        if (btn.parentNode !== host) host.appendChild(btn);
        // MEASURE-THEN-CORRECT: drop the gem at the host origin, read where it
        // actually renders, then offset to exactly {left = popout right + gap,
        // vertical centre = popout centre}. Doing the box-model math by hand
        // (border/padding/containing-block) kept landing it a few px off; this
        // sidesteps all of it. gap = the real box-to-box rhythm of the row.
        var gap = measureIconGap(group, ref);
        if (gap == null) gap = 0;
        btn.style.position = "absolute";
        btn.style.transform = "";
        btn.style.marginLeft = "";
        btn.style.left = "0px";
        btn.style.top = "0px";
        var rr = ref.getBoundingClientRect();
        var a = btn.getBoundingClientRect();
        btn.style.left = (rr.right + gap - a.left) + "px";
        // +3px: the gem glyph sits a touch high vs the native icons' optical
        // baseline (its art is top-heavy), so nudge it down to match the row.
        btn.style.top = (rr.top + (rr.height - a.height) / 2 - a.top + 3) + "px";
        return;
      }
      // Footer not found yet — float a small button bottom-right as a fallback.
      if (!btn) {
        btn = makeToggleBtn(null);
        btn.style.position = "fixed";
        btn.style.right = "14px";
        btn.style.bottom = "14px";
        btn.style.zIndex = "2147483647";
        btn.style.background = "rgba(15,33,46,0.92)";
        document.body.appendChild(btn);
      }
      btn.style.display = "";
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Docked layout — Stake's game layout element hosts the panel directly
  // ---------------------------------------------------------------------------
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
      ".game-content-keno",
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
    var selectors = [
      ".game-layout",
      "[data-testid='game-active']",
      ".game-wrapper",
      "[data-testid='game-frame']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = contentEl.closest(selectors[i]);
      var r = el && rectObj(el.getBoundingClientRect());
      if (r && r.width > 300 && r.height > 250) return el;
    }
    return null;
  }

  function dockLayout() {
    var root = E.getRoot();
    if (!root) return;

    var contentEl = stakeGameContentEl();
    var layoutEl = stakeGameLayoutEl(contentEl);
    if (contentEl && layoutEl) {
      if (root.parentElement !== layoutEl) layoutEl.appendChild(root);
      try {
        var cs = getComputedStyle(layoutEl);
        if (cs.position === "static") layoutEl.style.position = "relative";
      } catch (e) {}
      var contentRect = rectObj(contentEl.getBoundingClientRect());
      var layoutRect = rectObj(layoutEl.getBoundingClientRect());
      if (!contentRect || !layoutRect) return;
      var dockW = E.effectiveW();
      var dockMargin = 8;
      // Position to the right of the game content, but clamp so the panel's
      // right edge never runs past the viewport (zoom / narrow windows push the
      // content edge off-screen). When there's no room it pins to the viewport
      // edge, overlapping the board.
      var leftInLayout = contentRect.right - layoutRect.left + 12;
      var maxLeftInLayout = window.innerWidth - dockMargin - dockW - layoutRect.left;
      if (leftInLayout > maxLeftInLayout) leftInLayout = maxLeftInLayout;
      if (leftInLayout < dockMargin - layoutRect.left) leftInLayout = dockMargin - layoutRect.left;
      var overrideH = E.effectiveH();
      var dockH = overrideH || contentRect.height;
      // A user-resized height must keep the panel's bottom on screen: the dock
      // is absolutely positioned in the page (scrolls with it), so an over-tall
      // panel would grow past the fold / under the scrollbar.
      if (overrideH) {
        var maxDockH = window.innerHeight - Math.max(contentRect.top, 8) - 8;
        if (dockH > maxDockH) dockH = Math.max(220, maxDockH);
      }
      E.setStyle(root, {
        position: "absolute",
        left: leftInLayout + "px",
        top: contentRect.top - layoutRect.top + "px",
        right: "auto",
        width: dockW + "px",
        height: dockH + "px",
        maxHeight: dockH + "px"
      });
      return;
    }

    if (root.parentElement !== document.body) document.body.appendChild(root);

    // Docked fallback: sit in the empty area to the RIGHT of the board.
    var margin = 8;
    var gap = 12;
    var width = E.effectiveW();
    var anchor; // rect whose right edge we dock against, plus vertical extent
    var content =
      document.querySelector(".game-content-keno") || document.querySelector(".game-content");
    var cr = content && content.getBoundingClientRect();
    var container = document.querySelector(".game-container");
    var gr = (container && container.getBoundingClientRect()) || cr || E.boardRect();
    if (cr && gr && cr.width > 0) {
      anchor = { right: cr.right, top: gr.top, height: gr.height };
    }

    var left, top, height;
    var overrideH = E.effectiveH();
    if (anchor) {
      left = anchor.right + gap;
      if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - margin - width; // pin to the viewport's right
      }
      var navB = E.navBottom();
      if (anchor.top >= navB) {
        top = anchor.top;
        var bottom = Math.min(anchor.bottom, window.innerHeight);
        height = Math.max(bottom - top, 260);
      } else {
        top = navB;
        height = Math.max(Math.min(anchor.height, window.innerHeight - top), 260);
      }
    } else {
      left = window.innerWidth - margin - width;
      top = 70;
      height = window.innerHeight - top - margin;
    }
    if (overrideH) height = overrideH;

    E.setStyle(root, {
      position: "fixed",
      left: Math.max(margin, left) + "px",
      top: top + "px",
      right: "auto",
      width: width + "px",
      height: height + "px", // fixed height; the list scrolls inside
      maxHeight: height + "px"
    });
  }

  // ---------------------------------------------------------------------------
  // Visibility + combined wiring
  // ---------------------------------------------------------------------------
  function kenoActive() {
    return STAKE_HOST_RE.test(location.hostname) && /^\/casino\/games\/keno\/?$/i.test(location.pathname);
  }

  // Show the tracker only on the keno page; hide it the instant we navigate
  // away. Called on SPA route changes (via the __kt_nav event from net-hook)
  // as well as the polling fallbacks.
  var ktWasVisible = false;
  function updateVisibility() {
    var active = kenoActive();
    var root = E.getRoot();
    if (root) {
      root.style.display = active ? "" : "none";
      if (active && E.state.settings.open && E.state.settings.mode === "docked") {
        E.layout();
        // Entering keno from another page: the board mounts asynchronously, so
        // re-position a couple of times until it's there.
        if (!ktWasVisible) {
          setTimeout(E.layout, 150);
          setTimeout(E.layout, 450);
        }
      }
    }
    if (ROLE === "combined") ensureBottomButton();
    ktWasVisible = active;
  }

  function runCombined() {
    E.buildShell();
    window.addEventListener("keydown", E.onKeyDown, true);
    window.addEventListener("resize", E.scheduleLayout);
    window.addEventListener("scroll", E.scheduleLayout, true);
    document.addEventListener(
      "click",
      function (e) {
        if (!kenoActive()) return;
        if (e.target.closest && e.target.closest("#keno-tracker-root")) return;
        setTimeout(E.updateSelectionDisplay, 70);
        setTimeout(E.updateSelectionDisplay, 320);
      },
      true
    );
    observeBoardMutations();
    setInterval(function () {
      if (kenoActive()) checkDrawFromDOM();
    }, 75);
    updateVisibility();
    setInterval(function () {
      updateVisibility(); // hide when off the keno page (fallback for missed navs)
      E.syncBoardHeat(); // re-tint tiles svelte re-created; unpaints when off keno
      if (kenoActive() && E.state.settings.open && E.getRoot()) {
        E.updateSelectionDisplay();
        if (E.state.settings.mode === "docked") E.layout();
      }
    }, 700);
    E.log("combined ready");
  }

  // ---------------------------------------------------------------------------
  // Adapter surface
  // ---------------------------------------------------------------------------
  window.__KT_SITE = {
    id: "stake",
    exportTag: "stake-keno-tracker",
    storageKey: "stakeKenoTrackerState",
    dockW: 365,
    floatW: 385,
    attach: function (engine) {
      E = engine;
    },
    gameActive: kenoActive,
    readSelection: readSelection,
    dockLayout: dockLayout,
    paintBoard: paintBoardHeat,
    unpaintBoard: unpaintBoardHeat,
    glowBoard: applyGlow,
    onHistoryReset: function () {
      clearTimeout(domDraw.pendingTimer);
      domDraw = { lastSig: null, pendingSig: null, pendingSince: 0, pendingTimer: null };
      resetRevealTracking();
    },
    init: function () {
      // Stake renders keno directly in the top frame (no game iframe), so the
      // top frame does everything. We start combined immediately even when the
      // board isn't present yet — navigating into keno from another Stake page
      // then works without a reload (board work stays idle off-keno).
      if (window === window.top) {
        ROLE = "combined";
        runCombined();
      } else {
        ROLE = "none"; // subframes never hold the game on Stake
      }
      // Listen for authoritative keno results forwarded by net-hook.js, and
      // hide the panel instantly on SPA route changes.
      if (ROLE !== "none") {
        try {
          netHookPresent =
            document.documentElement.getAttribute("data-kt-nethook") === "1";
          document.addEventListener(NET_EVT, onNetEvent);
          document.addEventListener("__kt_seed_reset", onSeedResetEvent);
          document.addEventListener("__kt_seed_reveal", onSeedRevealEvent);
          document.addEventListener("__kt_seed_plain", onSeedPlainEvent);
          document.addEventListener("__kt_nav", updateVisibility);
          window.addEventListener("popstate", updateVisibility);
          window.addEventListener("hashchange", updateVisibility);
        } catch (e) {}
      }
      E.log("role", ROLE, "netHook", netHookPresent);
    }
  };
})();
