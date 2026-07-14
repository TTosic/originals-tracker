/*
 * Keno Tracker — Winna site adapter (loaded BEFORE games/keno/engine.js).
 *
 * Winna's keno board lives in a cross-origin iframe (games.winna.com) that
 * cannot paint outside its own bounds, so this adapter splits into roles:
 *   reader   — runs in the game iframe; reads the board + hotkey and relays
 *              selection / draws / paytable up over a chrome.storage bridge.
 *   panel    — runs in the outer winna.com page; owns the UI/state/storage
 *              and docks next to the visible game card.
 *   combined — board and page in the same frame (no iframe): does both.
 *
 * Draw source: the DOM. Winna reveals draws by adding a `revealed` class per
 * tile; MutationRecords (with oldValue) catch the full reveal even when a paid
 * bet skips the animation and the revealed state lasts under a frame.
 */
(function () {
  "use strict";

  var E = null; // engine API, received in attach()
  var ROLE = "none"; // "reader" | "panel" | "combined" | "none"

  // Reader ↔ panel bridge over chrome.storage. We deliberately avoid
  // window.postMessage: winna's page logs every message it doesn't recognise
  // ("Unknown message type!"). chrome.storage is private to the extension.
  var BRIDGE_KEY = "kenoTrackerBridge";
  var CMD_KEY = "kenoTrackerCmd"; // panel → reader commands (board heat paint)
  var bridge = { sel: [], pt: {}, drawSeq: 0, draws: [], saveSeq: 0, saveSel: [], toggleSeq: 0, ts: 0 };
  var bridgeWriteT = null;

  var lastSelection = []; // selection reported by the reader (panel role)
  var panelContentFrac = null; // where the game content ends, as an iframe fraction

  var domDraw = { lastSig: null }; // board reveal dedupe
  var revealSet = {};
  var revealCount = 0;
  var boardHadReveal = false; // a full reveal is on the board (for bet-start detection)
  var boardObserver = null;
  var lastPtScrape = 0;

  var lastReleaseAt = 0; // when the most recent draw was released to the panel

  // The board clearing after a full reveal = the next bet started. Glow comes
  // off locally; the panel (other frame in reader mode) is told over the
  // bridge so the hit notification drops at the same moment.
  function signalBetStart() {
    E.log("bet-start signal (board clearing), role:", ROLE, "glow active:", !!glowComps);
    if (glowComps) clearGlow();
    if (ROLE === "combined") {
      try {
        E.clearHitFx();
      } catch (e) {}
    } else {
      bridge.betSeq = (bridge.betSeq || 0) + 1;
      writeBridge(true);
    }
  }

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

  // ---------------------------------------------------------------------------
  // Network draws — the authoritative source once seen.
  //
  // keno-net-hook.js (MAIN world) forwards each keno "play" response:
  //   { id, multiplier, status, data: { tiles:[10, 0-indexed],
  //     user_tiles:[picks, 0-indexed], risk }, betUuid }
  // One response == one bet, which gives us the one thing the DOM can't: an
  // immediate bet-start signal (on no-turbo autobet winna's DOM doesn't change
  // until the reveal animation is nearly done). No nonce in the response —
  // synthesised sequentially, deduped on betUuid/id. DOM counting stays
  // primary until the first validated net draw arrives (netSeenEver), so a
  // changed endpoint can't silence the tracker.
  // ---------------------------------------------------------------------------
  var NET_EVT = "__kt_net_payload";
  var INSTANT_RATE_MS = 1100; // bets closer together than this can't be animating
  var netSeenEver = false;
  var lastNetAt = 0;
  var netOffset = null; // 0 or +1: calibrated index shift for network numbers
  var processedNetIds = [];

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
  var remoteRevealSig = ""; // reader-relayed reveal sig (bridge.rs), for frames without the board
  function boardRevealedSig() {
    if (!hasBoardDom()) return remoteRevealSig;
    try {
      var cls = E.classifyTiles();
      return sortedSig(cls.hit.concat(cls.miss));
    } catch (e) {
      return "";
    }
  }
  // A 0 anywhere (tiles or picks) proves 0-indexing — winna's response is
  // 0-indexed (tile 0 exists, board label 1). boardMax proves 1-indexing.
  function calibrateOffset(drawn, selected) {
    if (netOffset != null) return netOffset;
    var bMax = E.state.settings.boardMax || 40;
    if (drawn.indexOf(0) !== -1 || (selected && selected.indexOf(0) !== -1)) return (netOffset = 1);
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
    return null; // undecided — caller assumes 0-indexed (the proven winna shape)
  }
  function shiftNums(drawn, selected) {
    var off = calibrateOffset(drawn, selected);
    if (off == null) off = 1; // winna's confirmed live shape is 0-indexed
    if (!off) return drawn.slice();
    return drawn.map(function (n) {
      return n + off;
    });
  }
  // Walk the response for winna's bet shape: data.tiles + (optionally)
  // data.user_tiles. The plinko hook shares these pages — validDraw below is
  // what keeps non-keno /play traffic out.
  function parseKenoBet(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 6) return null;
    var d = node.data;
    if (d && Array.isArray(d.tiles) && d.tiles.length) {
      return {
        id: node.betUuid || (node.id != null ? String(node.id) : null),
        drawn: d.tiles.slice(),
        selected: Array.isArray(d.user_tiles) ? d.user_tiles.slice() : null
      };
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var r = parseKenoBet(node[k], depth + 1);
      if (r) return r;
    }
    return null;
  }
  // Strict shape check: a real keno draw is drawCount distinct integers on the
  // board (0-indexed allowed). This is what lets the hook forward generously.
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
  // spoils an animated reveal. Winna's tile classes are exact, so the draw's
  // own signature is the primary trigger; cap is a safety net.
  // While a net draw waits on its reveal, this holds the release check so the
  // mutation observer can run it the INSTANT the 10th tile flips. Polling
  // alone misses it: with instant rebet the settled board lives for less than
  // one 50ms tick before the clear starts (proven live — count hit 10 and was
  // wiped between polls on every mid-run bet; only the run's last bet fired).
  var netRevealCheck = null;

  function whenNewReveal(drawn, cap, cb) {
    var newSig = sortedSig(drawn);
    var start = Date.now();
    // EXACT match is the only board trigger, like Stake's primary. Winna's hit
    // tiles ARE readable the moment they visually flip (selected+revealed →
    // classify hit; the DOM-era mutation counter reached 10 incl. hits), and
    // winna appears to reveal misses first / hits last — so every "looser"
    // trigger tried here released ahead of the visuals:
    //   - "10 shown ≠ response-time snapshot" (Stake's backup): matches the
    //     OLD reveal still displayed when the response arrives → early;
    //   - misses-shown (Thrill's primary): fires before the hit tiles flip;
    //   - misses-shown + stillness grace: never fires (hit pulse + immediate
    //     clear leave no still window) → everything lagged a bet;
    //   - misses-shown + timed estimate: cadence guess → early or late.
    // Mid-run the order-flush releases anything exact misses; the cap covers
    // the last bet of a run if board reading breaks.
    var need = E.state.settings.drawCount || 10;
    var check = function () {
      if (cb.done) {
        netRevealCheck = null;
        return true;
      }
      var sig = boardRevealedSig();
      // Classify can't see a HIT tile at all (the win art replaces the tile's
      // number text, and classify skips non-numeric tiles) — but the mutation
      // counter caught its class-add at the visual flip, while the text was
      // still numeric. So mutation-exact = every drawn number flipped and the
      // old reveal fully cleared — THE visual-completion moment for draws
      // with hits.
      var mutExact = hasBoardDom() && revealCount === need;
      if (mutExact) {
        for (var i = 0; i < drawn.length; i++) {
          if (!revealSet[drawn[i]]) {
            mutExact = false;
            break;
          }
        }
      }
      if (sig === newSig || mutExact) {
        E.log("reveal release:", mutExact ? "mut-exact" : "exact", "shown:", sig);
        netRevealCheck = null;
        cb();
        return true;
      }
      if (Date.now() - start >= cap) {
        E.log("reveal release: cap shown:", sig, "want:", newSig);
        netRevealCheck = null;
        cb();
        return true;
      }
      return false;
    };
    netRevealCheck = check; // mutation observer runs this at the 10th flip
    (function poll() {
      if (check()) return;
      setTimeout(poll, 50);
    })();
  }
  var pendingRelease = null; // draw still waiting for its reveal to show
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

    // A new bet just fired — THE signal the DOM can't give us early: the
    // previous nonce's glow + notification come off right now.
    boardHadReveal = false; // the DOM clear-detector needn't re-signal
    signalBetStart();

    // ORDER INVARIANT: this response proves the PREVIOUS bet has fully
    // settled, so a draw still waiting on its reveal triggers is released
    // right now (board is showing it at this very moment). This keeps the
    // tracker in perfect lockstep during autobet even when the reveal
    // triggers below fail — without it, every cap-released draw lagged by
    // cap÷bet-pace bets.
    if (pendingRelease) {
      var pr = pendingRelease;
      pendingRelease = null;
      E.log("reveal release: order-flush (next bet's response arrived)");
      pr();
    }

    var drawn = shiftNums(bet.drawn, bet.selected);
    var sig = sortedSig(drawn);
    var now = Date.now();
    var gap = lastNetAt ? now - lastNetAt : Infinity;
    var rapid = gap < INSTANT_RATE_MS;
    var firstNet = !netSeenEver;

    netSeenEver = true; // from here on the network owns the count
    lastNetAt = now;
    E.log("NET draw", { id: bet.id, drawn: drawn, rapid: rapid });

    var released = false;
    var release = function () {
      if (released) return; // reveal trigger and order-flush can both fire
      released = true;
      release.done = true; // tells whenNewReveal's poll to stop
      if (pendingRelease === release) pendingRelease = null;
      // The DOM counter may have already recorded this very reveal before the
      // first network draw arrived — don't count the handover bet twice.
      if (firstNet && domDraw.lastSig === sig) {
        E.log("net draw already DOM-counted, skipping");
        return;
      }
      domDraw.lastSig = sig; // and the DOM fallback must not recount this one
      lastReleaseAt = Date.now();
      if (ROLE === "combined") {
        E.processDraw({ nonce: E.nextDomNonce(), drawn: drawn, source: "net" });
      } else {
        bridge.drawSeq = (bridge.drawSeq || 0) + 1;
        bridge.draws.push({ seq: bridge.drawSeq, drawn: drawn, src: "net" });
        if (bridge.draws.length > 20) bridge.draws.splice(0, bridge.draws.length - 20);
        writeBridge(true);
      }
    };

    // whenNewReveal's first check is synchronous, so an already-painted board
    // (turbo) releases right here with no delay. Animated bets wait for the
    // board, or for the next bet's response (order-flush) mid-run. The cap is
    // for the LAST bet of a run only, and must outlast winna's no-turbo
    // clear + reveal cycle (~3s + ~3s — a 4s cap fired blind mid-clear).
    if (rapid) {
      E.log("reveal release: rapid (turbo pace)");
      release();
    } else {
      pendingRelease = release;
      whenNewReveal(drawn, 9000, release);
    }
  }
  function onNetEvent(e) {
    try {
      handleNetPayload(e && e.detail);
    } catch (err) {}
  }

  // Bet REQUEST left (devtools "pending") — the user's click, possibly well
  // before the response settles. Clears the GLOW only (reader-local,
  // instant): the notification keeps its response-time clearing, because on
  // autobet the request leaves ~ms after the flip, and a bridge bet-start
  // here reaches the panel right after the card renders and wipes it.
  // HARD gates: only the frame that hosts the board may react (the top frame
  // also matches /keno/ URLs — if it wrote the bridge here, two writers would
  // clobber each other's draw queue), and only once a real net draw has been
  // seen (the request match is broad: any URL containing "keno").
  function onNetReq() {
    try {
      if (!netSeenEver || !hasBoardDom()) return;
      E.log("bet request left (pending) — clearing glow");
      boardHadReveal = false;
      if (glowComps) clearGlow();
    } catch (err) {}
  }

  // Seed rotation (keno-net-hook.js forwards the /unhash response). The engine
  // resets the hit history for the fresh seed (gated on the user's setting) and
  // — the /unhash response also reveals the RETIRED seed's plaintext
  // (old_seed.server_seed), so we hand it to the engine's oracle to replay.
  // Whichever frame's net-hook saw it: the board iframe (reader) relays over the
  // bridge; the panel/combined frame owns the engine and acts directly. The
  // reveal must reach the engine BEFORE the history reset (it verifies the seed
  // against the pre-reset recorded draws).
  function handleSeedReset(seed) {
    E.log("seed rotation detected, role:", ROLE, "seed:", !!seed);
    if (ROLE === "reader") {
      if (seed) bridge.seed = seed;
      bridge.seedSeq = (bridge.seedSeq || 0) + 1;
      writeBridge(true);
    } else if (ROLE === "combined" || ROLE === "panel") {
      if (seed) E.onSeedRevealed(seed.server, seed.client, seed.nonce);
      E.onSeedReset();
    }
  }
  function onSeedResetEvent(e) {
    try {
      var d = JSON.parse(e && e.detail);
      if (!(d && d.response && d.response.new_seed)) return; // not a genuine rotation
      var o = d.response.old_seed;
      var seed =
        o && o.server_seed && o.client_seed
          ? { server: o.server_seed, client: o.client_seed, nonce: o.nonce != null ? o.nonce : null }
          : null;
      handleSeedReset(seed);
    } catch (err) {}
  }

  // ---------------------------------------------------------------------------
  // Draw detection (DOM) — primary until the first net draw, fallback after
  // ---------------------------------------------------------------------------
  // Single place a completed draw is recorded (deduped by the sorted draw
  // signature). Reader → bridge; combined → processDraw locally.
  function commitDraw(arr) {
    if (netOwnsCounting()) return; // the network feed sees every bet 1:1
    var expected = E.state.settings.drawCount || 10;
    if (!arr || arr.length < expected) return;
    arr = arr.slice().sort(function (a, b) {
      return a - b;
    });
    var sig = arr.join(",");
    if (sig === domDraw.lastSig) return;
    domDraw.lastSig = sig;
    lastReleaseAt = Date.now();
    if (ROLE === "combined") {
      E.processDraw({ nonce: E.nextDomNonce(), drawn: arr, source: "dom" });
    } else {
      bridge.drawSeq = (bridge.drawSeq || 0) + 1;
      bridge.draws.push({ seq: bridge.drawSeq, drawn: arr });
      if (bridge.draws.length > 20) bridge.draws.splice(0, bridge.draws.length - 20);
      writeBridge(true);
    }
  }

  // tile element → board number, remembered while the tile's text is numeric
  // (a hit tile's text turns into win art, but the element stays the same).
  var tileNumByEl = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  // Track "revealed" tiles directly from MutationRecords. On paid bets winna
  // skips the reveal animation, so the "all 10 revealed" DOM state can exist
  // for less than a frame — but the class-add mutations still fire, and we
  // process them in order, so we catch the full reveal the instant it happens.
  function onBoardMutations(records) {
    var expected = E.state.settings.drawCount || 10;
    var min = Math.max(3, Math.floor(expected * 0.6));
    var committedInBatch = false; // don't let a trailing old-tile removal wipe a glow committed in this same batch
    for (var i = 0; i < records.length; i++) {
      var m = records[i];
      var el = m.target;
      var cn = el && typeof el.className === "string" ? el.className : "";
      if (cn.indexOf("field-button") === -1) continue;
      // A HIT tile's number text is replaced by win art before this async
      // callback runs, so resolve the number from the element cache (filled
      // by checkDrawFromDOM while the tile was readable) when the text no
      // longer parses — otherwise hit flips never enter revealSet.
      var t = (el.textContent || "").trim();
      var num = null;
      if (/^\d{1,2}$/.test(t)) num = parseInt(t, 10);
      else if (tileNumByEl) {
        var btn = el.closest ? el.closest(".field-button") || el : el;
        var cached = tileNumByEl.get(btn);
        if (cached != null) num = cached;
      }
      if (num == null) continue;
      // A tile counts as flipped on gaining EITHER state class: misses get
      // `revealed`; a hit may flip with only `isHit` (its number text is
      // already win art by now — `num` came from the element cache).
      var hasRev = el.classList.contains("revealed") || el.classList.contains("isHit");
      var old = " " + (m.oldValue || "") + " ";
      var hadRev = old.indexOf(" revealed ") !== -1 || old.indexOf(" isHit ") !== -1;
      if (hasRev && !hadRev) {
        if (!revealSet[num]) {
          revealSet[num] = 1;
          revealCount++;
          E.log("reveal add:", num, "count:", revealCount);
          // Run the net release check NOW, synchronously with the flip — by
          // the next 50ms poll the instant rebet has already begun clearing.
          if (revealCount >= expected && netRevealCheck) netRevealCheck();
        }
      } else if (!hasRev && hadRev) {
        if (revealSet[num]) {
          delete revealSet[num];
          revealCount--;
        }
        E.log("reveal removed:", num, "count:", revealCount, "hadReveal:", boardHadReveal);
        // Reveals are only ever REMOVED when the board moves on to the next
        // bet. Fire on the FIRST removal — on no-turbo autobet the clear and
        // the new draw's first tiles share one mutation batch, so an
        // aggregate "count dropped low" check at the end never triggered.
        // Net mode gets the bet-start from the response instead — and a
        // pulsing win animation could fake a removal here and wipe a fresh
        // glow, so this DOM backup stays out of the net path entirely.
        if (!netOwnsCounting() && boardHadReveal && !committedInBatch) {
          boardHadReveal = false;
          signalBetStart(); // next bet started — glow + notification come off now
        }
      }
      if (revealCount >= expected) {
        boardHadReveal = true;
        committedInBatch = true;
        commitDraw(Object.keys(revealSet).map(Number));
      }
    }
    if (revealCount < min) {
      domDraw.lastSig = null; // board cleared → ready again
      if (!netOwnsCounting() && boardHadReveal) {
        boardHadReveal = false;
        signalBetStart(); // backup: board read empty without removal events
      }
    }
  }

  // Timer fallback: catches a reveal already on the board (e.g. present when
  // the observer attached) and keeps the mutation-tracked set in sync.
  function checkDrawFromDOM() {
    var cls;
    try {
      cls = E.classifyTiles();
    } catch (e) {
      return;
    }
    if (ROLE === "combined" && Date.now() - lastPtScrape >= 1000) {
      lastPtScrape = Date.now();
      E.updatePaytableFromDOM();
    }
    // Remember each tile element's number while it's readable, so the
    // mutation handler can still identify a hit tile whose text has been
    // swapped for win art.
    if (tileNumByEl && cls.tiles && cls.tiles.forEach) {
      cls.tiles.forEach(function (el, n) {
        if (el) tileNumByEl.set(el, n);
      });
    }
    // Drop a lingering glow once the result (revealed tiles) clears — covers a
    // manual Clear Table and any board wipe that isn't a bet. Uses misses,
    // since Winna's hit tiles stop reading once they turn to win art.
    idleClearGlow(cls.hit.length + cls.miss.length);
    // In net mode revealSet is maintained ONLY by the mutation observer: it
    // catches hit tiles at the visual flip (class-add while the number text
    // is still readable), whereas classify can never see them again (the win
    // art replaces the number, so classify skips the tile). Rebuilding from
    // classify here would wipe those hits and break the net reveal-sync's
    // mut-exact trigger.
    if (netOwnsCounting()) return;
    var drawn = cls.hit.concat(cls.miss);
    var expected = E.state.settings.drawCount || 10;
    var min = Math.max(3, Math.floor(expected * 0.6));
    revealSet = {};
    revealCount = drawn.length;
    drawn.forEach(function (n) {
      revealSet[n] = 1;
    });
    if (drawn.length >= expected) {
      boardHadReveal = true;
      commitDraw(drawn);
    } else if (drawn.length < min) {
      domDraw.lastSig = null;
      if (boardHadReveal) {
        boardHadReveal = false;
        signalBetStart(); // board cleared → next bet underway
      }
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
  // Board heat painting — the panel sends hues over the cmd channel; the
  // reader (or combined frame) tints each tile's surface gradient.
  // ---------------------------------------------------------------------------
  var paintHues = null;
  var lastCmdSeq = 0;

  // The visible tile face is the .field-button__surface child — it paints over
  // the <button>, so styles must land on the surface, not the button itself.
  function paintTarget(el) {
    return (el.querySelector && el.querySelector(".field-button__surface")) || el;
  }

  // The tint is applied as a CSS RULE gated on the tile having no game state,
  // with the colour carried in a per-tile custom property. The CSS engine then
  // toggles tint ⇄ game-state colours atomically with the class changes — zero
  // frames in either direction. (Toggling an inline background-image from JS
  // could never keep up: it flickered on turbo and left tiles colourless while
  // a repaint cooldown ran.)
  var HEAT_STYLE_ID = "kt-heat-style";
  function ensureHeatStyle() {
    if (document.getElementById(HEAT_STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = HEAT_STYLE_ID;
    st.textContent =
      ".field-button:not(.selected):not(.revealed):not(.isHit) .field-button__surface[data-kt-heat] {" +
      " background-image: var(--kt-heat) !important; }";
    (document.head || document.documentElement).appendChild(st);
  }
  function applyPaint() {
    var cls;
    try {
      cls = E.classifyTiles();
    } catch (e) {
      return;
    }
    if (!cls.tiles || !cls.tiles.size) return;
    ensureHeatStyle();
    cls.tiles.forEach(function (el, n) {
      var t = paintTarget(el);
      if (paintHues && paintHues[n] != null) {
        var hs = paintHues[n];
        var h = hs[0];
        var s = hs[1] != null ? hs[1] : 85;
        var l = hs[2] != null ? hs[2] : 52;
        // Same shape as the game's own fill (dark top → tinted bottom), with
        // the heat colour in place of its cyan tint. Saturation carries the
        // signal strength: outliers glow, average numbers stay muted.
        t.style.setProperty(
          "--kt-heat",
          "linear-gradient(180deg, rgba(0,0,0,0.72), hsla(" + h + "," + s + "%," + l + "%,0.72))"
        );
        // data-kt-heat both arms the CSS rule and tells every read path
        // (engine tileFill etc.) that this colour is OURS, never game state.
        t.setAttribute("data-kt-heat", "1");
      } else if (t.getAttribute("data-kt-heat")) {
        t.style.removeProperty("--kt-heat");
        t.removeAttribute("data-kt-heat");
      }
    });
  }
  function clearPaint() {
    paintHues = null;
    // Sweep the whole document rather than trusting the current tile map —
    // the game re-renders tiles, and a stale map once left tints stuck on
    // surfaces the map no longer pointed at.
    var els = document.querySelectorAll("[data-kt-heat]");
    for (var i = 0; i < els.length; i++) {
      try {
        els[i].style.removeProperty("--kt-heat");
        els[i].removeAttribute("data-kt-heat");
      } catch (e) {}
    }
  }

  // Hit glow: rings the matched numbers of just-hit configs in each config's
  // banner colour. box-shadow is ADDITIVE (unlike the background tints that
  // fought the reveal styling) and isn't read by any colour classifier.
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
      el.style.boxShadow = "0 0 0 3px " + col + ", 0 0 16px 3px " + col;
      el.setAttribute("data-kt-glow", "1");
    });
  }
  function applyGlow(items) {
    E.log("applyGlow:", (items || []).length, "config(s)");
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

  // The glow rides one nonce and normally clears at the next bet. A manual
  // Clear Table (or any board wipe with no bet behind it) has no next bet, so
  // it would hang. Rule the user wants: glow only while the RESULT is on the
  // board. Revealed tiles (hit ∪ miss) are the reliable signal — Winna's hit
  // tiles turn to win art and stop reading, but the `revealed` MISSES read
  // fine. Once none remain, drop the glow. Debounced so the brief inter-bet
  // board wipe on autobet can't flicker it off (and gated on glowComps so it
  // never acts during a reveal, when the glow is already cleared anyway).
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
      E.log("glow cleared: result tiles gone (board idle)");
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
    if (ROLE === "combined") {
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
  var readerRevSig = "";

  function readerTick() {
    var cls;
    try {
      cls = E.classifyTiles();
    } catch (e) {
      return;
    }
    // Relay the revealed-tiles signature so a frame without the board (top
    // page) can still time net draws to the reveal.
    var revSig = sortedSig(cls.hit.concat(cls.miss));
    if (revSig !== readerRevSig) {
      readerRevSig = revSig;
      bridge.rs = revSig;
      writeBridge(true);
    }
    // Picks = selected + hit (hit tiles are still part of the selection).
    var picks = cls.selected.concat(cls.hit).sort(function (a, b) {
      return a - b;
    });
    var selSig = picks.join(",");
    if (selSig !== readerSelSig) {
      readerSelSig = selSig;
      bridge.sel = picks;
      writeBridge();
    }
    // Keep the heat tint on each tile across the game's own re-renders.
    if (paintHues) applyPaint();
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
    // height, so the panel can align its bottom to the content (the game card
    // is a fixed 16:9 box that's taller than the content).
    var gc =
      document.querySelector(".game-content-keno") ||
      document.querySelector(".game-container") ||
      document.querySelector(".keno-field");
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
        sel = E.boardSelection();
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
  // Panel (outer page): consume the reader's bridge from chrome.storage
  // ---------------------------------------------------------------------------
  var lastDrawSeq = 0;
  var lastSaveSeq = 0;
  var lastToggleSeq = 0;
  var lastBetSeq = 0;
  var lastSeedSeq = 0;

  function handleBridge(b) {
    if (!b) return;
    if (typeof b.rs === "string") remoteRevealSig = b.rs;
    if (b.betSeq && b.betSeq > lastBetSeq) {
      lastBetSeq = b.betSeq;
      E.clearHitFx(); // reader saw a new bet fire — drop the stale notification
    }
    if (b.seedSeq && b.seedSeq > lastSeedSeq) {
      lastSeedSeq = b.seedSeq;
      // Feed the revealed seed to the oracle BEFORE the reset wipes the draws.
      if (b.seed && b.seed.server) E.onSeedRevealed(b.seed.server, b.seed.client, b.seed.nonce);
      E.onSeedReset(); // reader saw a seed rotation — reset for the new seed
    }
    if (typeof b.cf === "number") panelContentFrac = b.cf;
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
            E.processDraw({ nonce: E.nextDomNonce(), drawn: d.drawn, source: d.src || "dom" });
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

  function kenoActive() {
    // URL updates synchronously on winna's SPA navigation, so this flips the
    // instant you leave the keno page (no waiting for the iframe to be removed).
    return /keno/i.test(location.pathname);
  }

  function runPanel() {
    E.buildShell();
    E.getRoot().style.display = "none"; // shown only while the keno game is present
    window.addEventListener("keydown", E.onKeyDown, true);
    window.addEventListener("resize", E.scheduleLayout);
    window.addEventListener("scroll", E.scheduleLayout, true);
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {}
    // Baseline the event counters from any existing bridge so we don't replay
    // the last draw/save/toggle when the page (re)loads.
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
        if (b.pt) E.mergePaytables(b.pt);
        E.updateSelectionDisplay();
      });
    } catch (e2) {}
    setInterval(function () {
      var root = E.getRoot();
      if (!root) return;
      var active = kenoActive();
      root.style.display = active ? "" : "none";
      if (active) ensureBottomButton(); // toolbar lives on the top page → panel docks it
      if (active && E.state.settings.open && E.state.settings.mode === "docked") E.layout();
    }, 200);
    // Re-paint the board if heat-board view was left on (reader may still be
    // booting; a short delay covers the usual iframe load order).
    if (E.state.settings.heatBoard) setTimeout(E.syncBoardHeat, 1500);
    E.log("panel ready");
  }

  // ---------------------------------------------------------------------------
  // Combined (board + page in the same frame)
  // ---------------------------------------------------------------------------
  function runCombined() {
    E.buildShell();
    window.addEventListener("keydown", E.onKeyDown, true);
    window.addEventListener("resize", E.scheduleLayout);
    window.addEventListener("scroll", E.scheduleLayout, true);
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
      ensureBottomButton();
      if (paintHues) applyPaint(); // survive the game's tile re-renders
      if (E.state.settings.open && E.getRoot()) {
        E.updateSelectionDisplay();
        if (E.state.settings.mode === "docked") E.layout();
      }
    }, 700);
    if (E.state.settings.heatBoard) setTimeout(E.syncBoardHeat, 1000);
    E.log("combined ready");
  }

  // ---------------------------------------------------------------------------
  // Docked layout — sit in the empty area to the RIGHT of the visible game box
  // ---------------------------------------------------------------------------
  function gameIframe() {
    return (
      document.querySelector('iframe[src*="games.winna.com"]') ||
      document.querySelector('iframe[src*="/game/"]') ||
      document.querySelector("iframe")
    );
  }

  // The *visible* game box in the outer page. The iframe element is oversized
  // and clipped by its parent, so we measure the parent (the rounded /
  // aspect-video card) to find where the game actually ends on screen.
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
    // Fallback: the iframe rect clamped.
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

  function dockLayout() {
    var root = E.getRoot();
    if (!root) return;
    var s = E.state.settings;
    var DOCK_W = 365;
    var margin = 8;
    var gap = 12;
    var width = DOCK_W;
    var anchor; // rect whose right edge we dock against, plus vertical extent
    if (ROLE === "panel") {
      anchor = gameBoxRect();
      // Trim the bottom to where the game content actually ends (the card is a
      // fixed 16:9 box that's taller than the content).
      if (anchor && panelContentFrac != null && panelContentFrac < 0.999) {
        var b2 = anchor.top + panelContentFrac * anchor.height;
        anchor = { left: anchor.left, top: anchor.top, right: anchor.right, bottom: b2, width: anchor.width, height: b2 - anchor.top };
      }
    } else {
      var content =
        document.querySelector(".game-content-keno") || document.querySelector(".game-content");
      var cr = content && content.getBoundingClientRect();
      var container = document.querySelector(".game-container");
      var gr = (container && container.getBoundingClientRect()) || cr || E.boardRect();
      if (cr && gr && cr.width > 0) {
        anchor = { right: cr.right, top: gr.top, height: gr.height };
      }
    }

    var left, top, height;
    if (anchor) {
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
  // Bottom-toolbar toggle button (diamond, next to the stats/cog/audio icons)
  // ---------------------------------------------------------------------------
  // Faceted-gem outline, drawn in currentColor so it inherits the toolbar
  // button's text colour (and its hover colour). Shared shape across all sites.
  var TOGGLE_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M5 4h14l3 5-10 12L2 9z"/><path d="M2 9h20"/><path d="M8 9l4 12 4-12"/></svg>';
  // FIXED toolbar-icon class (Winna's design-system icon button) so the gem is
  // styled identically every refresh — copying a live sibling's class was
  // inconsistent (sometimes caught a bordered/active state). No tooltip: the
  // gem is self-explanatory and per-site tooltip matching wasn't worth it.
  var TOOLBAR_BTN_CLASS =
    "flex size-6 items-center justify-center rounded-[8px] text-typography-secondary " +
    "hover:bg-body-level-3 hover:text-accent-blue lg:size-8";

  // Make the toggle look native by adopting a sibling toolbar button's classes
  // (hover/size/radius come from those classes; the icon is currentColor so it
  // follows). Fall back to a minimal style only when floating (no toolbar).
  function styleToggle(btn, refClass) {
    if (refClass) {
      btn.className = refClass;
      // copied class controls size/bg/hover; we only force cursor + centering.
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
      if (btns[i].id === "kt-bottom-toggle") continue;
      var r = btns[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return btns[i];
    }
    return null;
  }
  function onToggleClick() {
    // The toggle now lives in the top-page toolbar (panel context), so the
    // panel toggles directly; only the iframe reader relays over the bridge.
    if (ROLE === "reader") {
      bridge.toggleSeq = (bridge.toggleSeq || 0) + 1;
      writeBridge(true);
    } else {
      E.toggleOpen();
    }
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

  // The bottom toolbar = the narrowest flex row of small square icon buttons
  // low on screen (the stats/cog/audio cluster), preferred over wide containers.
  // The game toolbar is on the TOP PAGE on winna (the board iframe ends ABOVE
  // it), so the reader can't see it — the panel docks it. Anchor on the unique
  // "Fairness" button (only the game toolbar has it) and pick its icon-button
  // cluster; fall back to a document-wide scan of small text-typography-
  // secondary buttons. Works in whichever frame actually hosts the toolbar.
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
        if (b.id === "kt-bottom-toggle") continue;
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

  // Active look: the icon goes white while the tracker panel is open, matching
  // how the native tools (e.g. Live Stats) brighten when their panel is open.
  function setToggleActive(btn) {
    if (btn) btn.style.color = E.state.settings.open ? "#fff" : "";
  }
  function ensureBottomButton() {
    try {
      var bar = findToolbar();
      var btn = document.getElementById("kt-bottom-toggle");
      if (bar) {
        // Fixed class (not a copied sibling) → identical look every time.
        if (!btn) btn = makeToggleBtn(TOOLBAR_BTN_CLASS);
        // Append (don't insertBefore firstChild): adding a foreign node at the
        // FRONT of the framework-managed cluster disrupted its reconciliation
        // and dropped the sibling buttons' tooltips. A trailing node is safe.
        if (btn.parentElement !== bar) bar.appendChild(btn);
        setToggleActive(btn);
        return;
      }
      // No toolbar in THIS frame. Only combined (board+chrome on one page)
      // floats a fallback — reader/panel must not, or the reader would float a
      // stray gem in the iframe while the panel docks into the top-page bar.
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

  // ---------------------------------------------------------------------------
  // Role detection + adapter surface
  // ---------------------------------------------------------------------------
  function hasBoardDom() {
    return !!document.querySelector(".keno-field, .field-button");
  }
  function isGameHost() {
    return /(^|\.)games\.winna\.com$/i.test(location.hostname);
  }

  window.__KT_SITE = {
    id: "winna",
    exportTag: "winna-keno-tracker",
    storageKey: "kenoTrackerState", // legacy key — keeps existing winna data
    dockW: 365,
    floatW: 385,
    attach: function (engine) {
      E = engine;
    },
    gameActive: kenoActive,
    readSelection: function () {
      // In panel mode the board lives in another frame; use what the reader sent.
      if (ROLE === "panel") return lastSelection.slice();
      return E.boardSelection();
    },
    dockLayout: dockLayout,
    paintBoard: function (h) {
      sendCmd("paint", h.hues);
    },
    unpaintBoard: function () {
      sendCmd("unpaint");
    },
    glowBoard: function (items, ms) {
      sendCmd("glow", null, { items: items, ms: ms });
    },
    onHistoryReset: function () {
      domDraw = { lastSig: null };
    },
    init: function () {
      // Network feed from keno-net-hook.js (MAIN world): the authoritative
      // bet/draw source. The listener goes in every frame — the play request
      // fires from whichever frame hosts the game (normally the iframe).
      try {
        document.addEventListener(NET_EVT, onNetEvent);
        document.addEventListener("__kt_net_req", onNetReq);
        document.addEventListener("__kt_seed_reset", onSeedResetEvent);
      } catch (e) {}
      var isTop = window === window.top;
      var gameHere = hasBoardDom() || (isGameHost() && /keno/i.test(location.pathname));
      if (gameHere && isTop) {
        ROLE = "combined"; // board directly on the top page (no iframe)
        runCombined();
      } else if (gameHere && !isTop) {
        ROLE = "reader"; // keno board iframe
        runReader();
      } else if (isTop) {
        ROLE = "panel"; // outer winna.com page — panel shows while on keno
        runPanel();
      } else {
        ROLE = "none"; // unrelated subframe
      }
      E.log("role", ROLE);
    }
  };
})();
