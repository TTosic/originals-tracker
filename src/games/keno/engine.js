/*
 * Keno Tracker — shared game engine (ISOLATED world).
 *
 * This file is casino-agnostic. Everything site-specific (how to read the
 * board, how draws are detected, where to dock, how to paint heat onto the
 * real tiles) lives in a site adapter that the manifest loads BEFORE this
 * file. The adapter publishes itself as `window.__KT_SITE`; the engine hands
 * it an API object via SITE.attach(E) and calls SITE.init() once state is
 * loaded.
 *
 * Adapter contract (see docs/ARCHITECTURE.md for the full description):
 *   SITE.id            "winna" | "stake" | …
 *   SITE.exportTag     app tag written into export payloads
 *   SITE.storageKey    chrome.storage.local key for this site's state
 *   SITE.dockW         default docked width (px)
 *   SITE.floatW        default floating width (px)
 *   SITE.attach(E)     receives the engine API (called before init)
 *   SITE.init()        wire roles, draw sources, intervals, visibility
 *   SITE.gameActive()  true while the user is on this site's keno page
 *   SITE.readSelection()        current picks (board labels, sorted)
 *   SITE.dockLayout()           position the panel when docked
 *   SITE.paintBoard(heatData)   tint the real board (heatData = heatHues())
 *   SITE.unpaintBoard()         remove all tinting
 *   SITE.onHistoryReset()       optional: clear adapter draw-tracking state
 */
(function () {
  "use strict";
  if (window.__kenoTrackerContentLoaded) return;
  window.__kenoTrackerContentLoaded = true;

  var SITE = window.__KT_SITE;
  if (!SITE) return; // no adapter for this page — engine stays inert

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  var STORAGE_KEY = SITE.storageKey;

  var DEFAULTS = {
    settings: {
      saveHotkey: "Alt+S",
      highlightWithin: 1, // highlight a config when best matches >= size - this
      boardMax: 40,
      drawCount: 10, // keno reveals this many numbers per draw
      startNonce: 1, // first nonce assigned when counting draws ourselves
      open: true,
      collapsed: false, // show only the configs list when true
      mode: "docked", // "docked" | "float"
      floatPos: null, // { left, top } when floating
      panelW: null, // user-resized width (px); null = default
      panelH: null, // user-resized height (px); null = auto
      heatWindow: 100, // hot/cold lookback (draws): 50/100/250/500/1000
      heatBoard: false, // hot/cold view: false = ranked list, true = board layout
      sortMode: "manual", // config list order: "manual" (drag) | "hit" | "size" | "due"
      sortDir: "desc", // "desc" | "asc" — flips the hit/size sort direction
      dryCountSmall: false, // dry streak: false = only coloured tier hits reset it; true = any paying win (incl sub-tier "small X" like a 3/4 10x) resets it too
      hitBanner: true, // toast banner when a tracked config hits
      hitGlow: true, // board glow on a tracked config's numbers when it hits
      hideTitle: false, // hide the "Keno Tracker" title text in the header
      backfill: true, // a new config replays the stored draws (last 1000) to prefill its hit data
      resetOnSeed: true, // rotating the seed pair (new server seed) wipes the hit history
      revealDelayMs: 2000, // max wait for the board reveal before showing a draw
      oracleHorizon: 20000, // how many nonces ahead the "next hit" oracle scans a revealed seed
      debug: false
    },
    configs: [], // see saveCurrentSelection for shape
    history: {
      noncesTracked: 0,
      lastNonce: null,
      lastDrawn: [],
      processed: [], // recent nonces, capped — for dedupe
      recent: [] // last 1000 draws (arrays of drawn numbers) — hot/cold data
    },
    seeds: [], // revealed (rotated-away) seed records for the oracle: {server, client, stopNonce, ts, offset, verified, matched, checked}
    algoOk: false, // set once a revealed seed replays our recorded draws exactly — the site's keno maths is confirmed (per-site, one time)
    algoOffset: 0 // the nonce offset from that confirmation, reused to trust later 0-draw reveals
  };

  var state = clone(DEFAULTS);
  var saveTimer = null;
  var activeKey = ""; // sorted CSV of the current board selection (the live bet)
  var paytables = {}; // pickCount -> [multiplier per match count], read from the board
  var currentRisk = null; // last risk whose table the board scrape uniquely matched

  // Learned risk profiles — the site's REAL tables, learned row by row from the
  // board and persisted (separate storage key: the winna reader writes these
  // from its frame and must never touch configs/history, which the panel owns).
  // Each profile = one risk level: { rows: { pickCount: [multipliers] } }.
  // A fresh scrape identifies its profile by row fingerprint, so switching to
  // an already-learned risk refills EVERY size instantly with site truth —
  // no dependence on the built-in tables being accurate.
  var LEARNED_KEY = STORAGE_KEY + "Learned";
  var learned = []; // risk profiles
  var sessionProfile = null; // profile the board is currently showing
  function persistLearned() {
    try {
      var o = {};
      o[LEARNED_KEY] = learned;
      chrome.storage.local.set(o);
    } catch (e) {}
  }
  function rowSig(a) {
    return a.join(",");
  }
  // Find the unique learned profile whose row for this size matches; null when
  // none or several match (a shared row must not mis-fill other sizes).
  function findLearned(picks, pt) {
    var sig = rowSig(pt);
    var hit = null;
    for (var i = 0; i < learned.length; i++) {
      var r = learned[i].rows && learned[i].rows[picks];
      if (r && rowSig(r) === sig) {
        if (hit) return null;
        hit = learned[i];
      }
    }
    return hit;
  }

  // Known keno paytables (multiplier per match count, index 0..picks).
  // Used to fill in sizes you aren't currently betting, and to correct partial
  // reads. High is live-validated on Winna + Stake + Thrill; Classic/Low/
  // Medium are believed-Stake values, NOT yet verified against a live board.
  // That's safe: matchRisk only fills other sizes when the on-screen scrape
  // matches a known table EXACTLY, and the scrape always wins for the size
  // actually on screen — a wrong entry here simply never matches.
  var KENO_PAYTABLES = {
    Classic: {
      1: [0, 3.96],
      2: [0, 1.9, 4.5],
      3: [0, 1, 3.1, 10.4],
      4: [0, 0.8, 1.8, 5, 22.5],
      5: [0, 0.25, 1.4, 4.1, 16.5, 36],
      6: [0, 0, 1, 3.68, 7, 16.5, 40],
      7: [0, 0, 0.47, 3, 4.5, 14, 31, 60],
      8: [0, 0, 0, 2.2, 4, 13, 22, 55, 70],
      9: [0, 0, 0, 1.55, 3, 8, 15, 44, 60, 85],
      10: [0, 0, 0, 1.4, 2.25, 4.5, 8, 17, 50, 80, 100]
    },
    Low: {
      1: [0.7, 1.85],
      2: [0, 2, 3.8],
      3: [0, 1.1, 1.38, 26],
      4: [0, 0, 2.2, 7.9, 90],
      5: [0, 0, 1.5, 4.2, 13, 300],
      6: [0, 0, 1.1, 2, 6.2, 100, 700],
      7: [0, 0, 1.1, 1.6, 3.5, 15, 225, 700],
      8: [0, 0, 1.1, 1.5, 2, 5.5, 39, 100, 800],
      9: [0, 0, 1.1, 1.3, 1.7, 2.5, 7.5, 50, 250, 1000],
      10: [0, 0, 1.1, 1.2, 1.3, 1.8, 3.5, 13, 50, 250, 1000]
    },
    Medium: {
      1: [0.4, 2.75],
      2: [0, 1.8, 5.1],
      3: [0, 0, 2.8, 50],
      4: [0, 0, 1.7, 10, 100],
      5: [0, 0, 1.4, 4, 14, 390],
      6: [0, 0, 0, 3, 9, 180, 710],
      7: [0, 0, 0, 2, 7, 30, 400, 800],
      8: [0, 0, 0, 2, 4, 11, 67, 400, 900],
      9: [0, 0, 0, 2, 2.5, 5, 15, 100, 500, 1000],
      10: [0, 0, 0, 1.6, 2, 4, 7, 26, 100, 500, 1000]
    },
    High: {
      1: [0, 3.96],
      2: [0, 0, 17.1],
      3: [0, 0, 0, 81.5],
      4: [0, 0, 0, 10, 259],
      5: [0, 0, 0, 4.5, 48, 450],
      6: [0, 0, 0, 0, 11, 350, 710],
      7: [0, 0, 0, 0, 7, 90, 400, 800],
      8: [0, 0, 0, 0, 5, 20, 270, 600, 900],
      9: [0, 0, 0, 0, 4, 11, 56, 500, 800, 1000],
      10: [0, 0, 0, 0, 3.5, 8, 13, 63, 500, 800, 1000]
    }
  };

  // If a freshly read paytable matches exactly one known risk's table for that
  // pick size, return the risk name (so we can fill every size for that risk).
  // Some sizes are shared between risks (Classic and High pay 1-pick the same),
  // and an ambiguous match must not fill the other sizes with the wrong risk.
  function matchRisk(picks, pt) {
    var hit = null;
    for (var risk in KENO_PAYTABLES) {
      var ref = KENO_PAYTABLES[risk][picks];
      if (!ref || ref.length !== pt.length) continue;
      var ok = true;
      for (var i = 0; i < ref.length; i++) {
        if (Math.abs(ref[i] - pt[i]) > Math.max(0.05, ref[i] * 0.02)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if (hit) return null; // ambiguous — matches more than one risk
        hit = risk;
      }
    }
    return hit;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function load(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY, LEARNED_KEY], function (res) {
        if (res && Array.isArray(res[LEARNED_KEY])) learned = res[LEARNED_KEY];
        var saved = res && res[STORAGE_KEY];
        if (saved) {
          state.settings = Object.assign({}, DEFAULTS.settings, saved.settings || {});
          state.configs = Array.isArray(saved.configs) ? saved.configs : [];
          state.history = Object.assign({}, DEFAULTS.history, saved.history || {});
          state.seeds = Array.isArray(saved.seeds) ? saved.seeds : [];
          state.algoOk = saved.algoOk === true; // per-site "maths confirmed" flag survives reloads
          state.algoOffset = typeof saved.algoOffset === "number" ? saved.algoOffset : 0;
        }
        // One-time reset of a stuck floated position so it docks beside the
        // board. Versioned key so it re-applies with this build.
        if (!state.settings._posMigrated2) {
          state.settings.mode = "docked";
          state.settings.floatPos = null;
          state.settings._posMigrated2 = true;
        }
        // Seed a hit entry from the best result so existing tiered configs are
        // coloured + expandable right after an upgrade.
        state.configs.forEach(function (c) {
          var tier = hitTier(c.size, c.bestMatches || 0);
          if (tier && (!c.hits || !c.hits.length) && c.bestNonce != null) {
            c.hits = [{ n: c.bestNonce, m: c.bestMatches, x: c.lastHitMult, t: tier }];
            if (!c.hitCount) c.hitCount = 1;
          }
        });
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
          configs: state.configs,
          history: state.history,
          seeds: state.seeds,
          algoOk: state.algoOk,
          algoOffset: state.algoOffset
        };
        chrome.storage.local.set(payload);
      } catch (e) {}
    }, 150);
  }

  function log() {
    if (state.settings.debug) {
      try {
        console.log.apply(console, ["[KenoTracker]"].concat([].slice.call(arguments)));
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Math + draw processing
  // ---------------------------------------------------------------------------
  // Exact hypergeometric odds: drawing `drawCount` of `boardMax` numbers, the
  // chance that exactly m of your s picks are drawn. This is the real math of
  // the game — every nonce is an independent sample of this distribution.
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  }
  function pMatches(s, m) {
    var N = state.settings.boardMax || 40;
    var D = state.settings.drawCount || 10;
    return (comb(s, m) * comb(N - s, D - m)) / comb(N, D);
  }
  // Return-to-player of a paytable (multiplier per match count) as a percent.
  function rtpOf(size, pt) {
    if (!pt) return null;
    var ev = 0;
    for (var m = 0; m < pt.length; m++) ev += (pt[m] || 0) * pMatches(size, m);
    return ev * 100;
  }

  // Heat tier for a result, by how many short of a full hit:
  //   green  = full hit (any size)
  //   orange = 1 off, for configs of 6+ numbers
  //   red    = 2 off, for configs of 7+ numbers
  // (Near misses only matter on bigger picks, where they pay a lot.)
  function hitTier(size, matches) {
    if (size <= 0) return null;
    var off = size - matches;
    if (off <= 0) return "green";
    if (off === 1 && size >= 6) return "orange";
    if (off === 2 && size >= 7) return "red";
    return null;
  }

  // The exact match counts that colour a config of this size, newest-first by
  // rarity (green = all, orange = one off, red = two off). Mirrors hitTier.
  function coloredTiers(size) {
    var out = [{ m: size, tier: "green" }];
    if (size >= 6) out.push({ m: size - 1, tier: "orange" });
    if (size >= 7) out.push({ m: size - 2, tier: "red" });
    return out.filter(function (t) {
      return t.m >= 1;
    });
  }

  // ===========================================================================
  // Provably-fair seed replay (the "next hit" oracle)
  //
  // A game's result for (server seed, client seed, nonce) is a deterministic
  // HMAC-SHA256 draw. The ACTIVE server seed is secret (only its hash is known)
  // — nobody can compute upcoming draws, that's the whole point of provably
  // fair. But once you ROTATE, the retired seed's plaintext is revealed, so we
  // can replay it: recompute every past nonce (and verify it reproduces the
  // draws we actually recorded) and scan forward to find where each config
  // WOULD have hit next had you kept betting that seed. Retrospective, honest,
  // self-verified — never predictive of the live seed.
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
    var l = bytes.length;
    var m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    var bits = l * 8;
    var hi = Math.floor(bits / 0x100000000);
    var lo = bits >>> 0;
    m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    m.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = (m[off + t * 4] << 24) | (m[off + t * 4 + 1] << 16) | (m[off + t * 4 + 2] << 8) | m[off + t * 4 + 3];
      }
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
  function hexOf(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
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

  // Default keno draw (the Stake-family algorithm the clones share): an HMAC
  // byte stream → floats in [0,1) → pick from a SHRINKING pool by splicing out
  // the chosen index (NOT a Fisher-Yates swap). Verified byte-exact against a
  // live Stake draw: server 9cbca1eb83799cc4…, client "yqsPmhaIh5", nonce 3 →
  // 4,18,19,22,23,28,32,33,34,35. A site whose board maps differently can still
  // override via SITE.kenoDraw(server, client, nonce, count, boardMax).
  function kenoDrawDefault(server, client, nonce, count, boardMax) {
    var pool = [];
    for (var i = 0; i < boardMax; i++) pool.push(i + 1); // board labels 1..boardMax
    var res = [];
    var round = 0, buf = [], pos = 0;
    function nextByte() {
      if (pos >= buf.length) {
        buf = hmacSha256(server, client + ":" + nonce + ":" + round);
        round++;
        pos = 0;
      }
      return buf[pos++];
    }
    function nextFloat() {
      return nextByte() / 256 + nextByte() / 65536 + nextByte() / 16777216 + nextByte() / 4294967296;
    }
    for (var d = 0; d < count; d++) {
      var idx = Math.floor(nextFloat() * pool.length);
      res.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return res.sort(function (a, b) {
      return a - b;
    });
  }
  function computeDraw(rec, serverNonce) {
    var fn = (SITE && SITE.kenoDraw) || kenoDrawDefault;
    return fn(rec.server, rec.client, serverNonce, state.settings.drawCount || 10, state.settings.boardMax || 40);
  }
  function drawAt(rec, ourNonce) {
    return computeDraw(rec, ourNonce + (rec.offset || 0));
  }

  // Pull the recorded draws with their nonces (so we can prove the replay).
  function recordedDraws() {
    var rec = state.history.recent || [];
    var last = state.history.lastNonce;
    if (!rec.length || last == null) return [];
    var base = last - (rec.length - 1);
    var out = [];
    for (var i = 0; i < rec.length; i++) {
      out.push({ nonce: base + i, sig: rec[i].slice().sort(function (a, b) { return a - b; }).join(",") });
    }
    return out;
  }

  // Align our local nonce numbering with the server's (players may count from 0
  // or 1) and prove the algorithm reproduces reality. Verified only if EVERY
  // sampled draw matches at some single offset.
  function calibrateSeed(rec, samples) {
    var use = samples.slice(-24);
    var best = { ok: false, offset: 0, matched: 0, checked: use.length };
    if (!use.length) return best;
    for (var off = -2; off <= 2; off++) {
      var matched = 0;
      for (var i = 0; i < use.length; i++) {
        if (computeDraw(rec, use[i].nonce + off).join(",") === use[i].sig) matched++;
      }
      if (matched > best.matched) {
        best = { ok: matched === use.length && matched >= Math.min(4, use.length), offset: off, matched: matched, checked: use.length };
      }
    }
    return best;
  }

  // Scan forward from where the seed was retired, recording the first (and next
  // few) nonces at which each config would hit each of its coloured tiers.
  var ORACLE_STEP = 20000; // nonces scanned per pass / per "scan more"
  var ORACLE_CAP = 60; // hit nonces kept per tier (shown in the expanded sequence); "scan more" gathers more up to this
  // Scan nonces [from..to], filling the (already-built) slots. Each draw depends
  // only on its nonce, so this resumes cleanly — "scan more" continues from
  // data.reach with no re-scan of what's already covered.
  function scanKenoOracle(rec, slots, reset, from, to) {
    var remaining = 0;
    for (var i = 0; i < slots.length; i++) for (var j = 0; j < slots[i].tiers.length; j++) if (!slots[i].tiers[j].done) remaining++;
    for (var nonce = from; nonce <= to && remaining > 0; nonce++) {
      var draw = drawAt(rec, nonce);
      for (var si = 0; si < slots.length; si++) {
        var s = slots[si];
        var matches = 0;
        for (var di = 0; di < draw.length; di++) if (s.set[draw[di]]) matches++;
        if (!matches) continue;
        for (var ti = 0; ti < s.tiers.length; ti++) {
          var tr = s.tiers[ti];
          if (matches !== tr.m || tr.done) continue;
          if (tr.nonces.length < ORACLE_CAP) tr.nonces.push(nonce);
          if (tr.next === null && nonce > reset) tr.next = nonce;
          if (tr.nonces.length >= ORACLE_CAP && tr.next !== null) {
            tr.done = true;
            remaining--;
          }
        }
      }
    }
  }
  function computeOracle(rec) {
    var reset = rec.stopNonce || 0;
    var slots = state.configs.map(function (c) {
      var set = {};
      c.numbers.forEach(function (n) {
        set[n] = 1;
      });
      var pt =
        paytables[c.size] ||
        (currentRisk && KENO_PAYTABLES[currentRisk] && KENO_PAYTABLES[currentRisk][c.size]) ||
        c.paytable ||
        (KENO_PAYTABLES.High && KENO_PAYTABLES.High[c.size]);
      return {
        id: c.id,
        size: c.size,
        numbers: c.numbers.slice(),
        set: set,
        tiers: coloredTiers(c.size).map(function (t) {
          return { m: t.m, tier: t.tier, mult: pt && pt[t.m] != null ? pt[t.m] : null, nonces: [], next: null, done: false };
        })
      };
    });
    scanKenoOracle(rec, slots, reset, 1, ORACLE_STEP);
    return { reset: reset, reach: ORACLE_STEP, configs: slots };
  }
  // Extend an existing (cached) result by another step — incremental, so the
  // range can grow indefinitely without re-scanning what's already done.
  function extendOracle(rec, data) {
    scanKenoOracle(rec, data.configs, data.reset, data.reach + 1, data.reach + ORACLE_STEP);
    data.reach += ORACLE_STEP;
    return data;
  }

  // Called by adapters the moment a rotation reveals the retired seed's
  // plaintext — BEFORE the history reset, so the recorded draws are still around
  // to verify against. Stores the seed (+ verification) for the oracle popup.
  function onSeedRevealed(server, client, stopNonce, seedHash) {
    if (!server || !client) return;
    var rec = {
      server: String(server),
      client: String(client),
      stopNonce: stopNonce != null ? stopNonce : state.history.lastNonce || 0,
      ts: Date.now(),
      offset: 0,
      verified: false,
      byHash: false,
      trusted: false,
      matched: 0,
      checked: 0
    };
    try {
      if (seedHash) {
        // Cryptographic proof: the revealed plaintext must hash to the seed's
        // committed hash. Authenticates the seed WITHOUT needing the recorded
        // draws — used where the reveal arrives detached from live history (e.g.
        // Stake, opening a past bet after already rotating). The site's own
        // nonce is authoritative, so no offset search.
        rec.byHash = true;
        rec.verified = hexOf(sha256(utf8Bytes(rec.server))) === String(seedHash).toLowerCase();
        rec.matched = rec.verified ? 1 : 0;
        rec.checked = 1;
      } else {
        // Replay-verify against the recorded draws (Winna: the reveal arrives at
        // rotation, so history is still the retired seed's). Whether our maths
        // matches the SITE is a one-time property, not per-seed — so once ANY
        // seed verifies we remember it (state.algoOk/algoOffset) and TRUST later
        // reveals even when there are no draws to replay (a 0-bet seed, or a
        // second rotation whose history was already reset). The plaintext itself
        // is authentic — it comes straight from the site's own rotate response.
        var cal = calibrateSeed(rec, recordedDraws());
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
      }
    } catch (e) {}
    if (!state.seeds) state.seeds = [];
    // De-dupe: the same reveal can arrive twice (response + backup).
    if (!state.seeds.length || state.seeds[0].server !== rec.server) {
      state.seeds.unshift(rec);
      if (state.seeds.length > 5) state.seeds.length = 5;
    }
    log("seed revealed", { verified: rec.verified, matched: rec.matched + "/" + rec.checked, offset: rec.offset });
    // Prime the forward scan now (during the deliberate rotate, not on hover) so
    // opening the popup is instant — verified or not (we always show it).
    try {
      oracleData(rec);
    } catch (e) {}
    persist();
    scheduleRender();
  }

  function processDraw(draw) {
    if (!draw || draw.nonce == null || !draw.drawn || !draw.drawn.length) return;
    var nonce = draw.nonce;
    draw.drawn = draw.drawn.slice().sort(function (a, b) {
      return a - b;
    });
    var drawSig = draw.drawn.join(",");
    // DOM-sourced draws are deduped by their numbers (the same reveal is read
    // across many polls). Network draws carry a per-bet identity, so they
    // dedupe by nonce only — two distinct bets may draw the same numbers.
    if (draw.source !== "net" && drawSig === state.history.lastDrawn.join(",")) return;

    var processed = state.history.processed;
    if (processed.indexOf(nonce) !== -1) return; // already counted
    processed.push(nonce);
    if (processed.length > 500) processed.splice(0, processed.length - 500);

    state.history.noncesTracked++;
    state.history.lastNonce = nonce;
    state.history.lastDrawn = draw.drawn.slice();
    // Rolling draw log for the hot/cold view (capped at the largest window).
    if (!state.history.recent) state.history.recent = [];
    state.history.recent.push(draw.drawn.slice());
    if (state.history.recent.length > 1000) {
      state.history.recent.splice(0, state.history.recent.length - 1000);
    }

    var drawnSet = {};
    for (var i = 0; i < draw.drawn.length; i++) drawnSet[draw.drawn[i]] = 1;

    var hitsNow = []; // tier hits landed by THIS draw — feeds the banner + board glow
    for (var c = 0; c < state.configs.length; c++) {
      var cfg = state.configs[c];
      var matches = 0;
      var matchedNums = [];
      for (var j = 0; j < cfg.numbers.length; j++) {
        if (drawnSet[cfg.numbers[j]]) {
          matches++;
          matchedNums.push(cfg.numbers[j]);
        }
      }
      cfg.lastMatches = matches;
      cfg.lastEvalNonce = nonce;
      if (matches > (cfg.bestMatches || 0)) {
        cfg.bestMatches = matches;
        cfg.bestNonce = nonce;
      }

      // Multiplier for "last hit @ nonce": the LIVE paytable first (it follows
      // the risk level currently selected on the board — switching risk
      // re-fills the cache within ~1s via the scrape + matchRisk), then the
      // identified risk's known table, then the at-save snapshot, then High.
      var pt =
        paytables[cfg.size] ||
        (currentRisk && KENO_PAYTABLES[currentRisk] && KENO_PAYTABLES[currentRisk][cfg.size]) ||
        cfg.paytable ||
        (KENO_PAYTABLES.High && KENO_PAYTABLES.High[cfg.size]);
      var mult = pt && matches < pt.length ? pt[matches] : null;
      var tier = hitTier(cfg.size, matches);
      // "last hit @ nonce" records only a *paying* result — one whose match
      // count has a multiplier above 0x in the paytable.
      if (mult != null && mult > 0) {
        cfg.lastHitNonce = nonce;
        cfg.lastHitMult = mult;
        cfg.maxHitMult = Math.max(cfg.maxHitMult || 0, mult);
      }

      // Heat tier by how close to full: green = full, orange = 1 off (size 6+),
      // red = 2 off (size 7+). Only these are coloured / badged / listed.
      if (tier) {
        cfg.hitCount = (cfg.hitCount || 0) + 1;
        if (!cfg.hits) cfg.hits = [];
        // `bet` = was this set on the board when it hit (a real win vs a watch).
        var betHit = isActiveConfig(cfg);
        cfg.hits.push({
          n: nonce,
          m: matches,
          x: mult,
          t: tier,
          hit: matchedNums,
          drawn: draw.drawn.slice(),
          bet: betHit
        });
        if (cfg.hits.length > 100) cfg.hits.splice(0, cfg.hits.length - 100);
        cfg._flash = true;
        if (betHit) cfg.gold = true; // the row goes gold once you win it betting it
        hitsNow.push({
          numbers: cfg.numbers.slice(),
          matched: matchedNums.slice(),
          m: matches,
          size: cfg.size,
          mult: mult,
          bet: betHit
        });
      }
    }

    if (hitsNow.length) {
      // Bet-hits first, then biggest multiplier — that order assigns colours
      // (gold leads) and decides ring stacking order on shared tiles.
      hitsNow.sort(function (a, b) {
        return (b.bet ? 1 : 0) - (a.bet ? 1 : 0) || (b.mult || 0) - (a.mult || 0);
      });
      hitsNow.forEach(function (it, idx) {
        it.color = GLOW_PALETTE[idx % GLOW_PALETTE.length];
      });
      showHitFx(hitsNow, nonce);
    } else {
      removeHitFx(); // this nonce hit nothing — the previous card is stale now
    }
    // The glow belongs to exactly THIS nonce: it persists until the NEXT bet
    // (adapters also clear it the moment a new bet fires), and every processed
    // draw replaces it (with new rings, or with nothing).
    if (SITE.glowBoard && siteActive()) {
      var glowOff = state.settings.hitGlow === false;
      if ((glowOff && glowShown) || (!glowOff && (hitsNow.length || glowShown))) {
        try {
          SITE.glowBoard(
            glowOff
              ? []
              : hitsNow.map(function (it) {
                  return { nums: it.matched, color: it.color };
                })
          );
        } catch (e) {}
        glowShown = !glowOff && hitsNow.length > 0;
      }
    }

    log("draw processed", { nonce: nonce, drawn: draw.drawn, source: draw.source });
    persist();
    if (state.settings.heatBoard) syncBoardHeat(); // keep the painted board fresh
    scheduleRender(); // throttle so rapid autobet draws don't thrash the list
  }

  function nextDomNonce() {
    if (state.history.lastNonce == null) return state.settings.startNonce || 1;
    return state.history.lastNonce + 1;
  }

  // ---------------------------------------------------------------------------
  // Board reading (generic, self-calibrating; works on Winna + Stake markup)
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

  // Colors painted as a *fill* (solid background + gradient stops). We
  // deliberately ignore borders/shadows: tiles may share a coloured border,
  // and a border color must not be mistaken for a selected fill.
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

  // The clickable tile box that owns the number (a button, or the nearest
  // tile-sized ancestor). The selected/hit fill lives somewhere in its subtree,
  // not necessarily on an ancestor of the number label.
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

  // The strongest "active fill" color anywhere in the tile (subtree + pseudo
  // elements). Returns null for a plain/unselected tile (dark, low saturation).
  // Skips our own heat overlays — their saturated tints would read as game
  // state (red tint = "miss", blue tint = "selected") and corrupt everything
  // built on this: selection display, reveal signatures, instant detection.
  function tileFill(labelEl) {
    var container = tileContainer(labelEl);
    var nodes = [container];
    var kids = container.getElementsByTagName("*");
    for (var i = 0; i < kids.length && i < 24; i++) {
      if (kids[i].classList && kids[i].classList.contains("kt-heat-overlay")) continue;
      // Elements we tinted inline (winna heat paint) are marked data-kt-heat;
      // their colours are ours, not the game's.
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

  function tileTextColor(labelEl) {
    var container = tileContainer(labelEl);
    var nodes = [labelEl, container];
    var kids = container.getElementsByTagName("*");
    for (var i = 0; i < kids.length && i < 24; i++) {
      if (kids[i].classList && kids[i].classList.contains("kt-heat-overlay")) continue;
      if (kids[i].getAttribute && kids[i].getAttribute("data-kt-heat")) continue;
      nodes.push(kids[i]);
    }
    var best = null;
    var bestScore = -1;
    for (var j = 0; j < nodes.length; j++) {
      var c = parseColor(getComputedStyle(nodes[j]).color);
      if (!c || c.a < 0.35) continue;
      var bright = Math.max(c.r, c.g, c.b);
      var sat = bright - Math.min(c.r, c.g, c.b);
      var score = sat + bright * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = c;
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

  // Primary detector. Tries, in order:
  //   1. Stake's data attributes — <button class="tile" data-selected="true|false"
  //      data-game-tile-status="hidden|…">: exact and always present on Stake.
  //   2. State classes — Winna's `selected`/`revealed`/`isHit` (plus Stake's
  //      older is-selected/is-revealed/is-match): exact on Winna.
  //   3. Colour classification — last resort; can be fooled by saturated tints.
  function classifyTiles() {
    // A site adapter may replace board reading wholesale (e.g. Thrill's
    // layered SVG tiles inside shadow DOM need a site-specific detector chain).
    if (SITE.classifyTiles) return SITE.classifyTiles();
    var buttons = document.querySelectorAll(
      ".field-button, .tile, [class*='tile'], [data-testid*='keno'] button, [class*='keno'] button"
    );
    if (!buttons.length) return classifyTilesByColor();

    var result = { selected: [], hit: [], miss: [], tiles: new Map() };
    var bMax = state.settings.boardMax;
    var sawState = false; // a tile is currently selected/revealed
    var sawExact = false; // the markup is a known exact dialect (attrs or .field-button)
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var t = (b.textContent || "").trim();
      if (!/^\d{1,2}$/.test(t)) continue;
      var n = parseInt(t, 10);
      if (n < 1 || n > bMax) continue;
      result.tiles.set(n, b);
      var ds = b.getAttribute("data-selected");
      var st = b.getAttribute("data-game-tile-status");
      if (ds != null || st != null) {
        sawState = true;
        sawExact = true;
        var attrSel = ds === "true";
        var attrRev = st != null && st !== "hidden";
        if (attrRev && attrSel) result.hit.push(n);
        else if (attrRev) result.miss.push(n);
        else if (attrSel) result.selected.push(n);
        continue;
      }
      var cl = b.classList;
      // Winna's tiles are always .field-button — an idle board legitimately has
      // ZERO state classes, so the markup itself proves the class dialect and
      // we must NOT fall through to colour reading (it would read our own heat
      // tints as game state: blue tint = "selected", red = "miss").
      if (cl.contains("field-button")) sawExact = true;
      var stakeSel = cl.contains("is-selected");
      var stakeRev = cl.contains("is-revealed");
      var stakeMatch = cl.contains("is-match");
      var sel = cl.contains("selected") || stakeSel;
      var rev = cl.contains("revealed") || stakeRev;
      var match = cl.contains("isHit") || stakeMatch;
      if (sel || rev || match) sawState = true;
      if (stakeSel || stakeRev || stakeMatch) {
        if (stakeMatch) result.hit.push(n);
        else if (stakeRev) result.miss.push(n);
        else if (stakeSel) result.selected.push(n);
      } else if (match || (sel && rev)) result.hit.push(n);
      else if (rev) result.miss.push(n);
      else if (sel) result.selected.push(n);
    }
    // Colour classification is the LAST resort: only when the matched elements
    // carry neither live state nor a recognised state dialect.
    if (!sawState && !sawExact) return classifyTilesByColor();
    return sortResult(result);
  }

  // Read the on-screen paytable row (e.g. 0.00x 0.00x 0.00x 0.00x 11.00x …) —
  // the multiplier for each match count, for the current pick size.
  function readPaytable() {
    // Site override: paytable markup differs per casino (e.g. Thrill writes
    // plain "10x" with no decimal and renders inside shadow DOM).
    if (SITE.readPaytable) return SITE.readPaytable();
    var els = document.querySelectorAll("div, span, button, p");
    var found = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = (el.textContent || "").trim();
      // Multipliers carry a decimal ("11.00x"), a "k" ("1kx" = 1000x), or a
      // thousands comma (Stake's "1,000×" has NO decimal — rejecting it left
      // the 10-pick row one short and aborted every scrape). The bare
      // "0x 1x 2x …" hit-count labels have none of the three, so they're
      // still excluded. × and x both accepted.
      if (!/^[\d,]+(\.\d+)?k?[x×]$/i.test(t) || !/[.,k]/i.test(t)) continue;
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
      var num = parseFloat(t.replace(/,/g, "").replace(/[kx×]/gi, ""));
      if (/k/i.test(t)) num *= 1000;
      found.push({ x: r.left, y: Math.round(r.top / 8) * 8, v: num });
    }
    if (found.length < 2) return null;
    // Take the dominant horizontal row (the paytable is laid out left to right).
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

  // Cache the paytable keyed by the actual pick count (picked = selected tiles
  // plus any that already revealed as hits). We only store it when the paytable
  // length matches that pick count + 1, so reads never get mis-filed under the
  // wrong size.
  function updatePaytableFromDOM() {
    try {
      // Pick count from the HELD selection (site adapter), never raw tile
      // flags: on Stake the flags lie whenever a result is on screen (which is
      // nearly always between bets), inflating the count and silently failing
      // the row-length check below — the live cache then never updated and the
      // ⓘ cards stayed stuck on the at-save snapshot.
      var picks = readSelection().length;
      if (picks < 1) return;
      var pt = readPaytable();
      if (!pt || pt.length !== picks + 1) return;
      // Risk-switch detection: if the row for THIS size changed, every other
      // cached size belongs to the OLD risk — drop them all, otherwise configs
      // of other sizes keep showing the previous risk's pays indefinitely.
      var prev = paytables[picks];
      if (prev && rowSig(prev) !== rowSig(pt)) {
        paytables = {};
        currentRisk = null;
        sessionProfile = null;
      }
      // Identify (or start) the learned profile for the risk now on screen,
      // and record this row into it — the profile accumulates the site's REAL
      // table one size at a time, persisted across sessions.
      if (!sessionProfile) sessionProfile = findLearned(picks, pt);
      if (!sessionProfile) {
        sessionProfile = { rows: {} };
        learned.push(sessionProfile);
        if (learned.length > 8) learned.splice(0, learned.length - 8);
      }
      if (!sessionProfile.rows[picks] || rowSig(sessionProfile.rows[picks]) !== rowSig(pt)) {
        sessionProfile.rows[picks] = pt.slice();
        persistLearned();
      }
      paytables[picks] = pt;
      // Fill every size this risk has ever shown us — learned site truth
      // beats the built-in tables.
      for (var s in sessionProfile.rows) {
        if (!paytables[s]) paytables[s] = sessionProfile.rows[s];
      }
      // Built-in tables as a secondary fill for sizes not yet learned (only
      // when the scrape matches exactly one known risk).
      var risk = matchRisk(picks, pt);
      if (risk) {
        currentRisk = risk;
        for (var s2 in KENO_PAYTABLES[risk]) {
          if (!paytables[s2]) paytables[s2] = KENO_PAYTABLES[risk][s2];
        }
      }
    } catch (e) {}
  }

  // Fallback: classify by tile fill color when the state markers are absent.
  function classifyTilesByColor() {
    var tiles = findTiles();
    var result = { selected: [], hit: [], miss: [], tiles: tiles };
    if (!tiles.size) return result;

    tiles.forEach(function (el, n) {
      var c = tileFill(el);
      var tc = tileTextColor(el);
      if (c) {
        if (c.g >= c.r && c.g >= c.b) result.hit.push(n); // green hit
        else if (c.r > c.g + 20 && c.r > c.b + 20) result.miss.push(n); // red fill miss
        else if (c.b >= c.g && c.b - c.r > 15) result.selected.push(n); // blue/cyan selected
        else result.selected.push(n);
        return;
      }
      // Some sites mark misses as red text on a dark tile, not a red fill.
      if (tc && tc.r > tc.g + 20 && tc.r > tc.b + 20) result.miss.push(n);
    });
    return sortResult(result);
  }

  // Current picks straight off the board: selected ∪ hit (hit tiles are still
  // part of your selection during the result reveal). Adapters build their
  // site-specific readSelection on top of this.
  function boardSelection() {
    var cls = classifyTiles();
    return cls.selected.concat(cls.hit).sort(function (a, b) {
      return a - b;
    });
  }

  // The selection shown in the panel / saved by the hotkey — adapter-defined
  // (e.g. Stake holds the last stable pick through the reveal flicker; Winna's
  // panel frame reads what the iframe reader relayed).
  function readSelection() {
    try {
      return SITE.readSelection() || [];
    } catch (e) {
      return [];
    }
  }

  // Find the number tiles generically. Stray page numbers are filtered by
  // locating the deepest ancestor that still contains most of the numbers.
  function findTiles() {
    var bMax = state.settings.boardMax;
    var candidates = [];
    var els = document.querySelectorAll("button, div, span, li, a");
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

  // ---------------------------------------------------------------------------
  // Config actions
  // ---------------------------------------------------------------------------
  function saveCurrentSelection() {
    var nums = readSelection();
    if (!nums.length) {
      flashStatus("No numbers selected on the board.");
      return;
    }
    var key = nums.join(",");
    var dup = state.configs.some(function (c) {
      return c.numbers.join(",") === key;
    });
    if (dup) {
      flashStatus("That set is already tracked.");
      return;
    }
    // Snapshot the pays at the risk being bet right now — without this, a set
    // saved on Medium would later show whatever risk the board scrape saw last.
    // (Harmless in frames without the board: the scrape just finds nothing.)
    updatePaytableFromDOM();
    var cfg = newConfig(nums);
    if (state.settings.backfill !== false) backfillConfig(cfg);
    state.configs.unshift(cfg);
    flashStatus("Saved: " + key + (cfg.hitCount ? " · " + cfg.hitCount + " past hit" + (cfg.hitCount > 1 ? "s" : "") : ""));
    persist();
    render();
  }

  // Fresh config record for a set of numbers (used by save and import).
  function newConfig(nums) {
    return {
      id: "cfg_" + Date.now() + "_" + Math.floor(Math.random() * 1e4),
      numbers: nums,
      size: nums.length,
      // Snapshot the paytable for this pick size when we have it.
      paytable: paytables[nums.length] ? paytables[nums.length].slice() : null,
      hitCount: 0,
      bestMatches: 0,
      bestNonce: null,
      lastMatches: 0,
      lastEvalNonce: null,
      lastHitNonce: null,
      lastHitMult: null,
      maxHitMult: 0,
      gold: false,
      hits: [],
      createdAt: Date.now()
    };
  }

  // Prefill a fresh config's hit data by replaying the stored draw history
  // (state.history.recent — the last ~1000 draws). Same match/tier logic as
  // processDraw, but every backfilled hit is bet:false (you weren't betting it
  // then) and the multiplier uses the currently-resolved paytable.
  function backfillConfig(cfg) {
    var recent = state.history.recent || [];
    var lastNonce = state.history.lastNonce;
    if (!recent.length || lastNonce == null) return;
    var pt =
      paytables[cfg.size] ||
      (currentRisk && KENO_PAYTABLES[currentRisk] && KENO_PAYTABLES[currentRisk][cfg.size]) ||
      cfg.paytable ||
      (KENO_PAYTABLES.High && KENO_PAYTABLES.High[cfg.size]);
    var numSet = {};
    cfg.numbers.forEach(function (n) {
      numSet[n] = 1;
    });
    var base = lastNonce - (recent.length - 1); // nonce of recent[0]
    for (var i = 0; i < recent.length; i++) {
      var drawn = recent[i];
      if (!drawn || !drawn.length) continue;
      var nonce = base + i;
      var matched = [];
      for (var j = 0; j < drawn.length; j++) if (numSet[drawn[j]]) matched.push(drawn[j]);
      var matches = matched.length;
      cfg.lastMatches = matches;
      cfg.lastEvalNonce = nonce;
      if (matches > (cfg.bestMatches || 0)) {
        cfg.bestMatches = matches;
        cfg.bestNonce = nonce;
      }
      var mult = pt && matches < pt.length ? pt[matches] : null;
      if (mult != null && mult > 0) {
        cfg.lastHitNonce = nonce;
        cfg.lastHitMult = mult;
        cfg.maxHitMult = Math.max(cfg.maxHitMult || 0, mult);
      }
      var tier = hitTier(cfg.size, matches);
      if (tier) {
        cfg.hitCount = (cfg.hitCount || 0) + 1;
        cfg.hits.push({ n: nonce, m: matches, x: mult, t: tier, hit: matched.slice(), drawn: drawn.slice(), bet: false });
      }
    }
    if (cfg.hits.length > 100) cfg.hits.splice(0, cfg.hits.length - 100);
  }

  function deleteConfig(id) {
    state.configs = state.configs.filter(function (c) {
      return c.id !== id;
    });
    persist();
    render();
  }

  function clearConfigs() {
    state.configs = [];
    persist();
    render();
  }

  function resetHistory() {
    state.history = clone(DEFAULTS.history);
    if (SITE.onHistoryReset) {
      try {
        SITE.onHistoryReset(); // clear the adapter's draw-tracking state too
      } catch (e) {}
    }
    state.configs.forEach(function (c) {
      c.hitCount = 0;
      c.bestMatches = 0;
      c.bestNonce = null;
      c.lastMatches = 0;
      c.lastEvalNonce = null;
      c.lastHitNonce = null;
      c.lastHitMult = null;
      c.maxHitMult = 0;
      c.gold = false;
      c.hits = [];
      c._flash = false;
    });
    persist();
    render();
    syncBoardHeat(); // clear stale heat tinting — the draw data is gone
  }

  // The player rotated their seed pair (new server seed → nonce restarts at 0).
  // Each adapter's net-hook detects the site's rotate call and calls this. Past
  // draws belong to the retired seed, so — when the setting is on — we wipe the
  // hit history exactly like the manual "Reset history" button (no confirm; the
  // rotation is itself the deliberate action). Gated so users who want stats to
  // accumulate across seeds can turn it off.
  function onSeedReset() {
    if (state.settings.resetOnSeed === false) return;
    log("seed rotated — resetting hit history");
    resetHistory();
    flashStatus("New seed · history reset");
  }

  // ---------------------------------------------------------------------------
  // Hotkey handling
  // ---------------------------------------------------------------------------
  function hotkeyMatches(e) {
    var spec = (state.settings.saveHotkey || "").toLowerCase().split("+").map(function (s) {
      return s.trim();
    });
    if (!spec.length) return false;
    var key = spec[spec.length - 1];
    var needAlt = spec.indexOf("alt") !== -1;
    var needCtrl = spec.indexOf("ctrl") !== -1 || spec.indexOf("control") !== -1;
    var needShift = spec.indexOf("shift") !== -1;
    var needMeta = spec.indexOf("meta") !== -1 || spec.indexOf("cmd") !== -1;
    if (e.altKey !== needAlt) return false;
    if (e.ctrlKey !== needCtrl) return false;
    if (e.shiftKey !== needShift) return false;
    if (e.metaKey !== needMeta) return false;
    return (e.key || "").toLowerCase() === key;
  }

  function onKeyDown(e) {
    if (hotkeyMatches(e)) {
      e.preventDefault();
      e.stopPropagation();
      saveCurrentSelection();
    } else if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key || "").toLowerCase() === "p") {
      dumpPaytables(); // Alt+P: paytable pipeline diagnostic
    }
  }

  // Diagnostic (Alt+P): everything the paytable pipeline sees — held picks,
  // the raw scrape, the live cache, the identified risk, learned profiles.
  function dumpPaytables() {
    try {
      var sel = readSelection();
      console.log("[KenoTracker] PAYTABLE DUMP · picks: " + sel.join(",") + " (" + sel.length + ")");
      console.log("[KenoTracker] raw scrape:", JSON.stringify(readPaytable()));
      console.log("[KenoTracker] live cache:", JSON.stringify(paytables));
      console.log(
        "[KenoTracker] currentRisk:", currentRisk,
        "· learned profiles (sizes):",
        learned
          .map(function (p) {
            return Object.keys(p.rows || {}).join("/");
          })
          .join(" | ") || "none"
      );
    } catch (e) {
      console.log("[KenoTracker] dump error", e);
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  var root = null;
  var statusTimer = null;
  var dragging = false; // a config row is being drag-reordered

  function flashStatus(msg) {
    var el = root && root.querySelector("#kt-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("kt-status-show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      el.classList.remove("kt-status-show");
    }, 2500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  // ---- hover popups (config odds ⓘ + hot/cold flame) ----
  // One shared card positioned near the hovered trigger. Content is built
  // lazily on hover so draws never trigger re-renders for it.
  var popEl = null;
  var popTrigger = null; // the ⓘ/flame the popup is anchored to
  function getPop() {
    if (!popEl || !popEl.isConnected) {
      popEl = document.createElement("div");
      popEl.className = "kt-pop";
      root.appendChild(popEl);
    }
    return popEl;
  }
  var popPinned = false; // set once the user CLICKS in a popup — hover-out no longer closes it
  function hidePop() {
    if (popEl) popEl.style.display = "none";
    popTrigger = null;
    popPinned = false;
  }
  // Safety net: if the row that anchored the popup was rewritten (autobet
  // refresh), the mouseout we rely on never fires — close it ourselves so a
  // stale popup can't sit over the panel swallowing clicks.
  function popHealthCheck() {
    if (
      popEl &&
      popEl.style.display !== "none" &&
      (!popTrigger || !popTrigger.isConnected)
    ) {
      hidePop();
    }
  }
  function showPopFor(trigger, html) {
    popTrigger = trigger;
    var pop = getPop();
    pop.innerHTML = html;
    pop.style.display = "block";
    pop.style.left = "0px";
    pop.style.top = "0px";
    var rr = root.getBoundingClientRect();
    var tr = trigger.getBoundingClientRect();
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    var x = tr.right - rr.left - pw; // right-align to the trigger
    var y = tr.bottom - rr.top - 2; // open downward, 2px overlap = unbroken hover path
    x = Math.max(6, Math.min(x, rr.width - pw - 6));
    if (y + ph > rr.height - 6) y = tr.top - rr.top - ph + 2; // flip above
    y = Math.max(6, y);
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  }

  // ---- hit banner + board glow colours ----
  // Gold is always first (bet-hits sort to the front); the rest differentiate
  // multiple configs hit by the same draw. A tile shared by several hit
  // configs takes the FIRST config's colour (highest bet/multiplier priority).
  var GLOW_PALETTE = ["#ffd23f", "#38bdf8", "#c084fc", "#fb7185", "#4ef08a", "#f97316"];
  var glowShown = false; // a glow from the previous draw is (probably) on the board
  var hitFxEl = null;
  function removeHitFx() {
    if (hitFxEl && hitFxEl.parentNode) hitFxEl.parentNode.removeChild(hitFxEl);
    hitFxEl = null;
  }
  // Combined hit notification: ONE card with a header (nonce + 👁 mark-as-read)
  // and a row per config hit by this draw, each with its glow-colour chip so
  // the board rings are attributable at a glance. No auto-fade — it stays
  // until the eye is clicked or the next draw replaces/clears it.
  function showHitFx(items, nonce) {
    if (!root || !state.settings.open || state.settings.hitBanner === false) return;
    removeHitFx();
    hitFxEl = document.createElement("div");
    hitFxEl.className = "kt-hitfx";
    hitFxEl.innerHTML =
      '<div class="kt-hitfx-head">' +
      "<span>Hit" + (items.length > 1 ? "s" : "") + " · nonce " + esc(nonce) + "</span>" +
      '<button class="kt-hitfx-eye" title="Mark as read">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>' +
      "</svg></button></div>" +
      items
        .map(function (it) {
          return (
            // Left edge carries the config's glow colour, matching its rings.
            '<div class="kt-hitfx-row" style="border-left-color:' + it.color + '">' +
            '<span class="kt-hitfx-chip" style="background:' + it.color + ";box-shadow:0 0 10px " + it.color + '"></span>' +
            '<span class="kt-hitfx-nums">' + esc(it.numbers.join(", ")) + "</span>" +
            '<span class="kt-hitfx-meta">' + it.m + "/" + it.size +
            (it.mult ? " · " + it.mult + "x" : "") + "</span>" +
            "</div>"
          );
        })
        .join("");
    root.appendChild(hitFxEl);
    hitFxEl.querySelector(".kt-hitfx-eye").addEventListener("click", function (e) {
      e.stopPropagation();
      removeHitFx();
    });
  }

  // Percentage with real digits at any scale: normal sizes get fixed decimals,
  // tiny ones are rounded to their first significant digit with the zeros shown
  // (0.0053214…% → "0.005%", 1.18e-7% → "0.0000001%").
  function fmtPct(pct) {
    if (pct <= 0) return "0%";
    if (pct >= 10) return pct.toFixed(1) + "%";
    if (pct >= 1) return pct.toFixed(2) + "%";
    if (pct >= 0.01) return pct.toFixed(2) + "%";
    var decimals = Math.min(12, -Math.floor(Math.log10(pct)));
    return pct.toFixed(decimals) + "%";
  }

  // Per-config odds card: for each match count, the payout, the exact chance
  // per nonce, and "1 in N". RTP of the pick size in the title when known.
  function infoPopHtml(c) {
    // Live table first so the card follows the risk currently selected on the
    // board, then the identified risk's known table; the at-save snapshot only
    // covers sizes neither the scrape nor the risk match has seen.
    var pt =
      paytables[c.size] ||
      (currentRisk && KENO_PAYTABLES[currentRisk] && KENO_PAYTABLES[currentRisk][c.size]) ||
      c.paytable ||
      (KENO_PAYTABLES.High && KENO_PAYTABLES.High[c.size]);
    var rtp = rtpOf(c.size, pt);
    var title =
      c.size + " number" + (c.size === 1 ? "" : "s") +
      (rtp != null ? " · RTP " + rtp.toFixed(1) + "%" : "");
    var rows =
      '<div class="kt-pop-row kt-pop-head"><span>Hit</span><span>Pays</span><span>Chance</span><span>Odds</span></div>';
    for (var m = 1; m <= c.size; m++) {
      var p = pMatches(c.size, m);
      var pctTxt = fmtPct(p * 100);
      var oneIn = p > 0 ? 1 / p : null;
      // Whole-number odds, always rounded UP: the displayed odds are never
      // better than the real ones (3.1 → "1 in 4"). The epsilon only stops
      // float fuzz from bumping exact values (1/0.025 must stay "1 in 40").
      var oneTxt = oneIn == null ? "—" : Math.ceil(oneIn - 1e-9).toLocaleString();
      var mult = pt && pt[m] != null ? pt[m] + "x" : "—";
      var paying = !!(pt && pt[m] > 0);
      rows +=
        '<div class="kt-pop-row' + (paying ? " kt-pays" : "") + '">' +
        "<span>" + m + "/" + c.size + "</span>" +
        "<span>" + esc(mult) + "</span>" +
        "<span>" + pctTxt + "</span>" +
        "<span>1 in " + oneTxt + "</span>" +
        "</div>";
    }
    return '<div class="kt-pop-title">' + esc(title) + "</div>" + rows;
  }

  // Hot/cold card: frequency of every number over the last `heatWindow`
  // tracked draws. Clicking the flame cycles the window (50/100/250/500/1000).
  var HEAT_WINDOWS = [50, 100, 250, 500, 1000];

  // Heat data for the current window: per-number counts (numeric order),
  // hottest-first ranking, and [hue, saturation, lightness] per number.
  function heatHues() {
    var bMax = state.settings.boardMax || 40;
    var win = state.settings.heatWindow || 100;
    var all = state.history.recent || [];
    var recent = all.slice(-win);
    if (!recent.length) return null;
    var counts = [];
    for (var n = 1; n <= bMax; n++) counts.push({ n: n, c: 0 });
    for (var i = 0; i < recent.length; i++) {
      var d = recent[i] || [];
      for (var j = 0; j < d.length; j++) {
        var num = d[j];
        if (num >= 1 && num <= bMax) counts[num - 1].c++;
      }
    }
    var ranked = counts.slice().sort(function (a, b) {
      return b.c - a.c || a.n - b.n;
    });
    // Colour by how far each number sits from its expected count (z-score),
    // not by rank: hot outliers go red/orange, cold outliers blue, and the
    // statistically-normal middle stays a neutral grey — no fake signal, and
    // no green (green means "hit" in this game's own colour language).
    var D = state.settings.drawCount || 10;
    var pDraw = D / bMax;
    var expCount = recent.length * pDraw;
    var sd = Math.sqrt(Math.max(recent.length * pDraw * (1 - pDraw), 1e-9));
    var hues = {}; // n -> [hue, saturation, lightness]
    counts.forEach(function (e) {
      var t = Math.max(-1, Math.min(1, (e.c - expCount) / sd / 2.5)); // ±2.5σ full scale
      var warm = t >= 0;
      // Warm side ramps earlier and brighter — red sinks into a dark board far
      // more than blue, so it needs the handicap to pop equally hard.
      var hue = warm ? Math.round(25 - 25 * t) : Math.round(205 + 25 * -t);
      var sat = Math.round(warm ? 100 * Math.pow(t, 1.15) : 95 * Math.pow(-t, 1.8));
      var light = warm ? Math.round(52 + 13 * t) : 52;
      hues[e.n] = [hue, sat, light];
    });
    return { counts: counts, ranked: ranked, hues: hues, used: recent.length, total: all.length };
  }

  // Push (or clear) the heat colours on the real keno board, matching the
  // Board/Ranked view toggle. The adapter decides HOW tiles get tinted.
  function syncBoardHeat() {
    var h = state.settings.heatBoard && siteActive() ? heatHues() : null;
    try {
      if (h) SITE.paintBoard(h);
      else SITE.unpaintBoard();
    } catch (e) {}
  }
  function siteActive() {
    try {
      return SITE.gameActive();
    } catch (e) {
      return true;
    }
  }

  function heatPopHtml() {
    var h = heatHues();
    if (!h) {
      return (
        '<div class="kt-pop-title">Hot / cold</div>' +
        '<div class="kt-pop-empty">No draws tracked yet — play a round.</div>'
      );
    }
    var win = state.settings.heatWindow || 100;
    function hsFor(n) {
      return h.hues[n] || [35, 20, 52];
    }
    var board = !!state.settings.heatBoard;
    var cells, gridClass;
    if (board) {
      // Board layout: numbers in their real positions (8 per row), heat as a
      // coloured backdrop so the shape pops.
      gridClass = "kt-heat-grid kt-heat-board";
      cells = h.counts
        .map(function (e) {
          var hs = hsFor(e.n);
          var hue = hs[0], sat = hs[1];
          return (
            '<div class="kt-heat-cell" style="background:hsla(' + hue + "," + sat + '%,50%,0.18);border-color:hsla(' + hue + "," + sat + '%,55%,0.5)">' +
            '<b style="color:hsl(' + hue + "," + Math.max(sat, 30) + '%,64%)">' + e.n + "</b>" +
            "<i>" + e.c + "</i>" +
            "</div>"
          );
        })
        .join("");
    } else {
      gridClass = "kt-heat-grid";
      cells = h.ranked
        .map(function (e) {
          var hs = hsFor(e.n);
          return (
            '<div class="kt-heat-cell">' +
            '<b style="color:hsl(' + hs[0] + "," + Math.max(hs[1], 30) + '%,60%)">' + e.n + "</b>" +
            "<i>" + e.c + "</i>" +
            "</div>"
          );
        })
        .join("");
    }
    // Clickable lookback chips — the active window is highlighted.
    var chips = HEAT_WINDOWS.map(function (w) {
      return (
        '<button class="kt-win' + (w === win ? " kt-win-on" : "") +
        '" data-act="win" data-win="' + w + '">' + w + "</button>"
      );
    }).join("");
    var views =
      '<button class="kt-win' + (!board ? " kt-win-on" : "") + '" data-act="hview" data-mode="rank">Ranked</button>' +
      '<button class="kt-win' + (board ? " kt-win-on" : "") + '" data-act="hview" data-mode="board">Board</button>';
    return (
      '<div class="kt-pop-title">Hot → cold · last ' + h.used +
      " draw" + (h.used === 1 ? "" : "s") +
      (h.total > h.used ? " of " + h.total : "") + "</div>" +
      '<div class="' + gridClass + '">' + cells + "</div>" +
      '<div class="kt-pop-wins"><span>View</span>' + views + "</div>" +
      '<div class="kt-pop-wins"><span>Window</span>' + chips + "</div>"
    );
  }

  // Multiplier tally: every tracked tier hit stores its multiplier and whether
  // you were betting the set (`bet`) — aggregate them into "81.5x · HIT n ·
  // MISSED n" rows. Hit = landed while betting it; Missed = landed on a set
  // you were only watching.
  function multTallyHtml() {
    var agg = {};
    var any = false;
    state.configs.forEach(function (c) {
      (c.hits || []).forEach(function (h) {
        if (h.x == null || !(h.x > 0)) return;
        var k = String(h.x);
        if (!agg[k]) agg[k] = { x: h.x, hit: 0, missed: 0 };
        if (h.bet) agg[k].hit++;
        else agg[k].missed++;
        any = true;
      });
    });
    if (!any) {
      return (
        '<div class="kt-pop-title">Multipliers</div>' +
        '<div class="kt-pop-empty">No tracked hits yet.</div>'
      );
    }
    var rows = Object.keys(agg)
      .map(function (k) {
        return agg[k];
      })
      .sort(function (a, b) {
        return b.x - a.x;
      });
    var html =
      '<div class="kt-pop-row kt-pop-3 kt-pop-head"><span>Multi</span><span>Hit</span><span>Missed</span></div>';
    rows.forEach(function (r) {
      html +=
        '<div class="kt-pop-row kt-pop-3' + (r.hit ? " kt-pays" : "") + '">' +
        "<span>" + r.x + "x</span><span>" + r.hit + "</span><span>" + r.missed + "</span></div>";
    });
    html +=
      '<div class="kt-pop-foot">Hit = while betting it<br>Missed = watched<br>Last 100 hits per config</div>';
    return '<div class="kt-pop-title">Multipliers · tracked tier hits</div>' + html;
  }

  var TIER_COLOR = { green: "#4ef08a", orange: "#ffb020", red: "#ff6b6b" };
  var oracleCache = null; // { seedTs, cfgSig, data }
  function oracleData(rec) {
    var cfgSig =
      state.configs
        .map(function (c) {
          return c.id + ":" + c.numbers.join("-");
        })
        .join("|") +
      "|risk=" + (currentRisk || "") + "|pt=" + Object.keys(paytables).length;
    if (oracleCache && oracleCache.seedTs === rec.ts && oracleCache.cfgSig === cfgSig) return oracleCache.data;
    var data = computeOracle(rec);
    oracleCache = { seedTs: rec.ts, cfgSig: cfgSig, data: data };
    return data;
  }
  function fmtMult(x) {
    if (x == null) return "";
    return (x >= 1000 ? x.toLocaleString() : x) + "x";
  }
  // Soonest upcoming hit across a config's tiers (for the sort; none = last).
  function cfgSoonest(slot) {
    var best = Infinity;
    for (var i = 0; i < slot.tiers.length; i++) {
      var n = slot.tiers[i].next;
      if (n != null && n < best) best = n;
    }
    return best;
  }
  // The "next hit" oracle popup — for the most-recently revealed seed, where
  // each config would have hit each of its coloured tiers next. Hover-opens like
  // the other header icons; each config card expands to show the next few hits.
  function oraclePopHtml() {
    var rec = state.seeds && state.seeds[0];
    var hdr =
      '<div class="kt-orc-hdr"><span class="kt-orc-title">Seed checker</span>' +
      (rec && rec.verified
        ? '<span class="kt-orc-reset"><span class="kt-orc-reset-lbl">reset at nonce</span><b>#' + rec.stopNonce + "</b></span>"
        : "") +
      "</div>";
    if (!rec) {
      return hdr + '<div class="kt-pop-empty">Rotate your seed to reveal it. This then replays that retired seed to show where each saved config would have hit.</div>';
    }
    // A hash-path reveal (Stake) that fails its committed hash is a corrupt/stale
    // seed — nothing to show. The replay path (Winna) always shows: the plaintext
    // is authentic from the site, the replay is deterministic, so even unverified
    // it's "what that seed would have done" — just flagged as unconfirmed.
    if (rec.byHash && !rec.verified) {
      return hdr + '<div class="kt-orc-warn">This revealed seed didn’t match its committed hash — it may be corrupt or stale.</div>';
    }
    if (!state.configs.length) {
      return hdr + '<div class="kt-pop-empty">Save a config to check it against this seed.</div>';
    }
    var data = oracleData(rec);
    var sorted = data.configs.slice().sort(function (a, b) {
      return cfgSoonest(a) - cfgSoonest(b); // soonest upcoming hit first; driest last
    });
    var body = sorted
      .map(function (slot) {
        var cfg = null;
        for (var i = 0; i < state.configs.length; i++) if (state.configs[i].id === slot.id) cfg = state.configs[i];
        var exp = !!(cfg && cfg._orcExp);
        var tiers = slot.tiers
          .map(function (t) {
            var col = TIER_COLOR[t.tier] || "#9fb4c4";
            var mult = t.mult != null ? '<span class="kt-orc-mult">' + fmtMult(t.mult) + "</span>" : "";
            var main;
            if (t.next != null) {
              main =
                '<b class="kt-orc-tnonce" style="color:' + col + '">#' + t.next.toLocaleString() + "</b>" +
                '<span class="kt-orc-till">' + (t.next - data.reset).toLocaleString() + " bets till hit</span>";
            } else if (t.nonces.length) {
              main = '<b class="kt-orc-tnonce" style="color:' + col + '">#' + t.nonces[0].toLocaleString() + "</b>";
            } else {
              main = '<span class="kt-orc-none">none in ' + data.reach.toLocaleString() + "</span>";
            }
            var seq = exp && t.nonces.length
              ? '<div class="kt-orc-seq">' +
                t.nonces
                  .map(function (n) {
                    return '<span class="kt-orc-chip' + (n <= data.reset ? " kt-orc-chip-past" : "") + '">#' + n.toLocaleString() + "</span>";
                  })
                  .join("") +
                "</div>"
              : "";
            return (
              '<div class="kt-orc-tier">' +
              '<div class="kt-orc-tline">' +
              '<span class="kt-orc-badge" style="color:' + col + ";background:" + col + '22">' + t.m + "/" + slot.size + "</span>" +
              mult +
              '<span class="kt-orc-next">' + main + "</span>" +
              "</div>" +
              seq +
              "</div>"
            );
          })
          .join("");
        return (
          '<div class="kt-orc-card' + (exp ? " kt-orc-open" : "") + '" data-act="orc-exp" data-id="' + esc(slot.id) + '">' +
          '<div class="kt-orc-nums"><span>' + esc(slot.numbers.join(", ")) + "</span>" +
          '<span class="kt-orc-caret">' + (exp ? "▾" : "▸") + "</span></div>" +
          tiers +
          "</div>"
        );
      })
      .join("");
    var note = rec.verified ? "" : ' · <span class="kt-orc-unver" title="Not confirmed against your recorded draws — computed from the revealed seed, but the nonce alignment is unverified">unverified</span>';
    // Offer to scan further while any tier can still gather more hits (hasn't
    // found its next-hit yet, or hasn't filled the sequence).
    var anyMore = data.configs.some(function (c) {
      return c.tiers.some(function (t) {
        return !t.done;
      });
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

  // Sort menu — opened by the ⇅ header button (click, not hover).
  function sortMenuHtml() {
    var sm = state.settings.sortMode || "manual";
    function chip(mode, label, title) {
      return (
        '<button class="kt-win' + (sm === mode ? " kt-win-on" : "") +
        '" data-act="sort" data-mode="' + mode + '" title="' + title + '">' + label + "</button>"
      );
    }
    var dir = state.settings.sortDir || "desc";
    return (
      '<div class="kt-pop-title">Sort configs</div>' +
      '<div class="kt-pop-wins">' +
      chip("manual", "Manual", "Your drag order") +
      chip("hit", "Hit", "By hit state (gold, then tier)") +
      chip("size", "Size", "By number count") +
      chip("due", "Due", "By longest dry streak (nonces since last hit)") +
      "</div>" +
      '<div class="kt-pop-wins">' +
      '<button class="kt-win" data-act="sortdir" title="Flip sort direction">' +
      (dir === "asc" ? "↑ Ascending" : "↓ Descending") +
      "</button>" +
      "</div>" +
      '<div class="kt-pop-foot">Drag-reorder works in Manual only</div>'
    );
  }

  // Settings menu — opened by the ⚙ header button (click, pinned like ⇅).
  function settingsMenuHtml() {
    var s = state.settings;
    function tog(act, label, on) {
      return (
        '<div class="kt-set-row"><span class="kt-set-label">' + label + "</span>" +
        '<button class="kt-switch' + (on ? " kt-switch-on" : "") + '" data-act="' + act +
        '" role="switch" aria-checked="' + (on ? "true" : "false") + '" aria-label="' + label +
        '"><span class="kt-knob"></span></button></div>'
      );
    }
    return (
      '<div class="kt-pop-title">Settings</div>' +
      tog("tog-title", "Hide title", s.hideTitle === true) +
      tog("tog-banner", "Hit notification", s.hitBanner !== false) +
      tog("tog-glow", "Board glow", s.hitGlow !== false) +
      tog("tog-drysmall", "Small wins reset dry counter", s.dryCountSmall === true) +
      tog("tog-backfill", "New configs backfill hits (last 1000)", s.backfill !== false) +
      tog("tog-seedreset", "New seed resets hit history", s.resetOnSeed !== false)
      // Debug logs toggle intentionally hidden from release builds so end users
      // can't enable console logging. The "tog-debug" handler + the cross-frame
      // debug sync are kept below — re-add this line to expose it in dev:
      //   + tog("tog-debug", "Debug logs", s.debug === true)
    );
  }

  // Small "window" count shown next to the flame in the header.
  function updateHeatLabel() {
    var el = root && root.querySelector(".kt-heat-n");
    if (el) el.textContent = state.settings.heatWindow || 100;
  }

  function onHoverIn(e) {
    var t = e.target.closest && e.target.closest(".kt-info, .kt-heat, .kt-multi, .kt-oracle");
    if (!t) return;
    if (t.classList.contains("kt-heat")) {
      showPopFor(t, heatPopHtml());
      return;
    }
    if (t.classList.contains("kt-multi")) {
      showPopFor(t, multTallyHtml());
      return;
    }
    if (t.classList.contains("kt-oracle")) {
      showPopFor(t, oraclePopHtml());
      return;
    }
    var id = t.getAttribute("data-id");
    for (var i = 0; i < state.configs.length; i++) {
      if (state.configs[i].id === id) {
        showPopFor(t, infoPopHtml(state.configs[i]));
        return;
      }
    }
  }
  function onHoverOut(e) {
    if (popPinned) return; // user clicked in the popup → only a click closes it
    var from = e.target.closest && e.target.closest(".kt-info, .kt-heat, .kt-multi, .kt-oracle, .kt-pop");
    if (!from) return;
    var to = e.relatedTarget;
    // Keep the popup while the cursor is on a trigger or inside the popup
    // itself (it's interactive — the hot/cold window chips live in it).
    if (to && to.closest && (to.closest(".kt-pop") || to.closest(".kt-info, .kt-heat, .kt-multi, .kt-oracle"))) return;
    hidePop();
  }

  // ---- styled confirm dialog (replaces window.confirm) ----
  var confirmEl = null;
  function ktConfirm(message, onYes) {
    if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
    confirmEl = document.createElement("div");
    confirmEl.className = "kt-confirm";
    confirmEl.innerHTML =
      '<div class="kt-confirm-card">' +
      '<div class="kt-confirm-msg">' + esc(message) + "</div>" +
      '<div class="kt-confirm-btns">' +
      '<button class="kt-confirm-no">Cancel</button>' +
      '<button class="kt-confirm-yes">Confirm</button>' +
      "</div></div>";
    root.appendChild(confirmEl);
    function close() {
      if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
      confirmEl = null;
    }
    confirmEl.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest(".kt-confirm-yes")) {
        close();
        onYes();
      } else if (e.target.closest(".kt-confirm-no") || e.target === confirmEl) {
        close(); // cancel button, or a click on the dimmed backdrop
      }
    });
  }

  // Prompt variant of the dialog: message + textarea (used for import).
  function ktPrompt(message, warning, submitLabel, onSubmit) {
    if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
    confirmEl = document.createElement("div");
    confirmEl.className = "kt-confirm";
    confirmEl.innerHTML =
      '<div class="kt-confirm-card">' +
      '<div class="kt-confirm-msg">' + esc(message) + "</div>" +
      (warning ? '<div class="kt-confirm-warn">⚠ ' + esc(warning) + "</div>" : "") +
      '<textarea class="kt-confirm-input" spellcheck="false" placeholder="Paste the exported JSON here…"></textarea>' +
      '<div class="kt-confirm-btns">' +
      '<button class="kt-confirm-no">Cancel</button>' +
      '<button class="kt-confirm-yes">' + esc(submitLabel) + "</button>" +
      "</div></div>";
    root.appendChild(confirmEl);
    var ta = confirmEl.querySelector("textarea");
    setTimeout(function () {
      try {
        ta.focus();
      } catch (e) {}
    }, 0);
    function close() {
      if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl);
      confirmEl = null;
    }
    confirmEl.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest(".kt-confirm-yes")) {
        var v = ta.value.trim();
        close();
        if (v) onSubmit(v);
      } else if (e.target.closest(".kt-confirm-no") || e.target === confirmEl) {
        close();
      }
    });
  }

  // ---- export / import ----
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  function copyText(text, cb) {
    try {
      navigator.clipboard.writeText(text).then(
        function () {
          cb(true);
        },
        function () {
          cb(fallbackCopy(text));
        }
      );
    } catch (e) {
      cb(fallbackCopy(text));
    }
  }

  // Export/import carries ONLY the number sets — never history or hit stats,
  // which belong to one seed/session and would be wrong anywhere else.
  function exportConfigs() {
    if (!state.configs.length) {
      flashStatus("Nothing to export yet.");
      return;
    }
    var payload = {
      // One tag for every casino — exports are deliberately site-agnostic so a
      // Winna set pastes straight into Stake or Thrill (import never checks
      // the tag; this is just so the JSON doesn't LOOK site-locked).
      app: "originals-keno-tracker",
      v: 2,
      sets: state.configs.map(function (c) {
        return c.numbers;
      })
    };
    copyText(JSON.stringify(payload), function (ok) {
      flashStatus(
        ok
          ? "Copied " + state.configs.length + " config(s) to clipboard."
          : "Couldn't copy — clipboard blocked."
      );
    });
  }

  function importConfigs() {
    ktPrompt(
      "Import configs",
      "Importing resets all config stats and tracked nonces.",
      "Import",
      function (text) {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          flashStatus("That isn't valid backup JSON.");
          return;
        }
        // Accept: v2 {sets:[[..]]}, v1 {configs:[{numbers}]}, or a bare [[1,2,3]].
        var sets = null;
        if (data && Array.isArray(data.sets)) sets = data.sets;
        else if (data && Array.isArray(data.configs))
          sets = data.configs.map(function (c) {
            return c && c.numbers;
          });
        else if (Array.isArray(data)) sets = data;
        if (!sets) {
          flashStatus("No configs found in that backup.");
          return;
        }
        var bMax = state.settings.boardMax || 40;
        var have = {};
        state.configs.forEach(function (c) {
          have[c.numbers.join(",")] = 1;
        });
        var added = 0;
        sets.forEach(function (nums) {
          if (!Array.isArray(nums)) return;
          var clean = [];
          var seen = {};
          nums.forEach(function (n) {
            n = parseInt(n, 10);
            if (n >= 1 && n <= bMax && !seen[n]) {
              seen[n] = 1;
              clean.push(n);
            }
          });
          clean.sort(function (a, b) {
            return a - b;
          });
          if (!clean.length) return;
          var key = clean.join(",");
          if (have[key]) return; // skip sets we already track
          have[key] = 1;
          state.configs.push(newConfig(clean)); // fresh stats — hits start at zero
          added++;
        });
        // Any successful import is a clean slate — stats and nonces reset even
        // when every set was already tracked (that's what the warning promises).
        resetHistory();
        flashStatus(
          added
            ? "Imported " + added + " config(s) — stats & nonces reset."
            : "Sets already tracked — stats & nonces reset."
        );
      }
    );
  }

  function buildShell() {
    root = document.createElement("div");
    root.id = "keno-tracker-root";
    document.body.appendChild(root);
    root.addEventListener("click", onPanelClick);
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("mouseover", onHoverIn);
    root.addEventListener("mouseout", onHoverOut);
    root.addEventListener("dblclick", function (e) {
      // Double-click the resize handle to reset the panel back to auto size
      // (backup for the pointer-timing path in startResize).
      if (e.target.closest && e.target.closest(".kt-resize")) {
        state.settings.panelW = null;
        state.settings.panelH = null;
        persist();
        layout();
      }
    });
    root.addEventListener("dragstart", onConfigDragStart);
    root.addEventListener("dragover", onConfigDragOver);
    root.addEventListener("drop", function (e) {
      e.preventDefault();
    });
    root.addEventListener("dragend", onConfigDragEnd);
    render();
  }

  // ---- config row drag-to-reorder (blue drop-line indicator) ----
  var draggedRow = null;
  var dropLine = null;
  function getDropLine() {
    if (!dropLine) {
      dropLine = document.createElement("div");
      dropLine.className = "kt-drop-line";
    }
    return dropLine;
  }
  function removeDropLine() {
    if (dropLine && dropLine.parentNode) dropLine.parentNode.removeChild(dropLine);
  }
  function onConfigDragStart(e) {
    if (state.settings.sortMode !== "manual") return; // sorted views aren't reorderable
    var row = e.target.closest && e.target.closest(".kt-config");
    if (!row) return;
    draggedRow = row;
    dragging = true;
    row.classList.add("kt-dragging");
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.getAttribute("data-id") || "");
    } catch (err) {}
  }
  function onConfigDragOver(e) {
    if (!draggedRow) return;
    var list = root.querySelector(".kt-config-list");
    if (!list || !list.contains(draggedRow)) return;
    e.preventDefault();
    // Leave the dragged row in place (dimmed) and show a line marking where
    // it would land, so the drop target is unambiguous.
    var rows = Array.prototype.slice.call(list.querySelectorAll(".kt-config:not(.kt-dragging)"));
    var after = null;
    var closest = -Infinity;
    for (var i = 0; i < rows.length; i++) {
      var box = rows[i].getBoundingClientRect();
      var offset = e.clientY - box.top - box.height / 2;
      if (offset < 0 && offset > closest) {
        closest = offset;
        after = rows[i];
      }
    }
    var line = getDropLine();
    if (after) list.insertBefore(line, after);
    else list.appendChild(line);
  }
  function onConfigDragEnd() {
    if (!draggedRow) return;
    var list = root.querySelector(".kt-config-list");
    // Drop the row where the indicator line ended up, then read the new order.
    if (list && dropLine && dropLine.parentNode === list) {
      list.insertBefore(draggedRow, dropLine);
    }
    removeDropLine();
    draggedRow.classList.remove("kt-dragging");
    draggedRow = null;
    dragging = false;
    if (list) {
      var order = Array.prototype.slice.call(list.querySelectorAll(".kt-config")).map(function (el) {
        return el.getAttribute("data-id");
      });
      state.configs.sort(function (a, b) {
        return order.indexOf(a.id) - order.indexOf(b.id);
      });
      persist();
    }
    render();
  }

  function isActiveConfig(c) {
    return activeKey && c.numbers.join(",") === activeKey;
  }

  function configRowClass(c) {
    // Base classes for the initial render (flash is handled separately so its
    // animation isn't cut short by frequent autobet refreshes).
    var bt = hitTier(c.size, c.bestMatches || 0);
    var active = isActiveConfig(c);
    var cls = "kt-config";
    if (c.gold) cls += " kt-goldhit"; // hit while you were betting it → stays gold
    else if (bt) cls += " kt-" + bt; // a watched set hit → tier colour
    if (active) cls += " kt-active"; // side bar marks the set you're betting now
    return cls;
  }

  // Reconcile a row's tier/active classes via classList (so the kt-flash class,
  // managed on a timer below, is never wiped) and pulse on a fresh hit.
  function applyRowState(el, c) {
    var bt = hitTier(c.size, c.bestMatches || 0);
    var gold = !!c.gold;
    el.classList.toggle("kt-goldhit", gold);
    el.classList.toggle("kt-red", !gold && bt === "red");
    el.classList.toggle("kt-orange", !gold && bt === "orange");
    el.classList.toggle("kt-green", !gold && bt === "green");
    el.classList.toggle("kt-active", isActiveConfig(c));
    if (c._flash) {
      c._flash = false;
      el.classList.remove("kt-flash");
      void el.offsetWidth; // restart the animation if it was mid-flight
      el.classList.add("kt-flash");
      var e2 = el;
      clearTimeout(e2._flashT);
      e2._flashT = setTimeout(function () {
        e2.classList.remove("kt-flash");
      }, 1300);
    }
  }

  // The "last hit" that BOTH the meta line and the dry counter reckon from.
  // By default a hit means a COLOURED tier hit (green = full, orange = 1-off,
  // red = 2-off — see hitTier), read off the last cfg.hits entry. The "Small
  // wins reset dry" setting widens it to ANY paying result (cfg.lastHitNonce),
  // e.g. a 3/4 that pays 10x but isn't a tier colour.
  function lastCountedHit(c) {
    if (state.settings.dryCountSmall) {
      return c.lastHitNonce == null ? null : { n: c.lastHitNonce, x: c.lastHitMult };
    }
    if (c.hits && c.hits.length) {
      var h = c.hits[c.hits.length - 1];
      return { n: h.n, x: h.x };
    }
    return null;
  }

  // Dry streak = nonces since this config's last counted hit. A DESCRIPTIVE
  // count only — provably-fair draws are independent, so a long dry streak does
  // NOT make a hit more likely. The "Due"/"dry" wording is just gambler
  // vernacular (user's call); we never claim it predicts anything. Never-hit
  // configs report the biggest val so they sort as the most "due".
  function configDry(c) {
    var last = state.history.lastNonce;
    if (last == null) return { val: 0, text: "" };
    var lh = lastCountedHit(c);
    if (!lh) return { val: 1e15, text: "dry —" };
    var d = last - lh.n;
    if (d < 0) d = 0;
    return { val: d, text: "dry " + d };
  }

  function configRowInner(c) {
    var ratio = (c.bestMatches || 0) + "/" + c.size;
    var bestTier = hitTier(c.size, c.bestMatches || 0);
    var tierClass = bestTier ? "kt-" + bestTier : "";

    var hits = c.hits || [];
    var lh = lastCountedHit(c);
    var meta = "last hit @ nonce " + esc(lh ? lh.n : "-");
    if (lh && lh.x != null) meta += " · " + lh.x + "x";

    var badge = "";
    if (c.hitCount) {
      badge =
        '<span class="kt-badge ' + tierClass + '" title="' + c.hitCount + ' tracked hit(s)">' +
        c.hitCount +
        "</span>";
    }

    var caret = "";
    if (hits.length >= 1) {
      caret =
        '<button class="kt-caret" data-act="toggle" data-id="' + c.id + '" title="Show all hits">' +
        (c._expanded ? "▴" : "▾") +
        "</button>";
    }

    // Expanded list — each hit on two lines: a header (matches · mult · nonce)
    // and the full draw (all numbers drawn that round) below it.
    var hitsHtml = "";
    if (c._expanded && hits.length) {
      var rows = hits
        .slice()
        .reverse()
        .map(function (h) {
          var mx = h.x != null ? " · " + h.x + "x" : "";
          // Gold = you were betting this set when it hit; else the tier colour.
          var tc = h.bet ? " kt-gold" : h.t ? " kt-" + h.t : "";
          var all = h.drawn && h.drawn.length ? h.drawn : h.hit;
          var numsLine = all && all.length
            ? '<div class="kt-hit-nums' + tc + '">' + esc(all.join(", ")) + "</div>"
            : "";
          return (
            '<div class="kt-hit-row' + (h.bet ? " kt-bethit" : "") + '">' +
            '<div class="kt-hit-head">' +
            '<span class="kt-hit-tier' + tc + '">' + h.m + "/" + c.size + esc(mx) + "</span>" +
            '<span class="kt-hit-nonce">nonce ' + esc(h.n) + "</span>" +
            "</div>" +
            numsLine +
            "</div>"
          );
        })
        .join("");
      hitsHtml = '<div class="kt-hits">' + rows + "</div>";
    }

    return (
      '<div class="kt-config-row">' +
      '<div class="kt-config-main">' +
      '<div class="kt-config-nums"><span class="kt-nums">' + esc(c.numbers.join(", ")) +
      '</span><span class="kt-dry">' + configDry(c).text + "</span></div>" +
      '<div class="kt-config-meta">' + meta + "</div>" +
      "</div>" +
      badge +
      caret +
      '<div class="kt-config-ratio">' + esc(ratio) + "</div>" +
      '<div class="kt-side">' +
      '<span class="kt-info" data-id="' + c.id + '">i</span>' +
      '<button class="kt-x" data-act="del" data-id="' + c.id + '" title="Remove">×</button>' +
      "</div>" +
      "</div>" +
      hitsHtml
    );
  }

  // Compact signature of everything that affects a row's rendered content.
  function configRowSig(c) {
    return [
      c.bestMatches || 0,
      c.hitCount || 0,
      c.lastHitNonce,
      c.lastHitMult,
      c._expanded ? 1 : 0,
      (c.hits || []).length,
      isActiveConfig(c) ? 1 : 0,
      c.gold ? 1 : 0,
      state.settings.dryCountSmall ? 1 : 0
    ].join("|");
  }

  function configRowHtml(c) {
    // Drag-to-reorder only makes sense in manual order — in a live-sorted view
    // the sorter would immediately fight the drop.
    var draggable = state.settings.sortMode === "manual" ? "true" : "false";
    return (
      '<div class="' + configRowClass(c) + '" data-id="' + c.id + '" draggable="' + draggable + '" data-sig="' +
      esc(configRowSig(c)) + '">' + configRowInner(c) + "</div>"
    );
  }

  // The configs in DISPLAY order. Sorting is a view — it never mutates the
  // saved (manual/drag) order, so switching back to Manual restores it.
  function viewConfigs() {
    var mode = state.settings.sortMode;
    if (mode !== "hit" && mode !== "size" && mode !== "due") return state.configs;
    // Direction flips the comparison, not the array — ties (comparator 0)
    // keep the manual order in BOTH directions instead of reversing it.
    var mul = state.settings.sortDir === "asc" ? -1 : 1;
    var arr = state.configs.slice();
    if (mode === "hit") {
      var rank = { green: 3, orange: 2, red: 1 };
      arr.sort(function (a, b) {
        var ra = a.gold ? 4 : rank[hitTier(a.size, a.bestMatches || 0)] || 0;
        var rb = b.gold ? 4 : rank[hitTier(b.size, b.bestMatches || 0)] || 0;
        if (rb !== ra) return mul * (rb - ra); // desc: gold > full > 1-off > 2-off > unhit
        return mul * ((b.hitCount || 0) - (a.hitCount || 0)); // then by tracked hits
      });
    } else if (mode === "size") {
      arr.sort(function (a, b) {
        return mul * (b.size - a.size); // desc: most numbers first; asc: fewest
      });
    } else {
      // "due" — by dry streak (nonces since last hit). Driest first in desc.
      // Honest metric; the label is just gambler vernacular (see configDry).
      arr.sort(function (a, b) {
        return mul * (configDry(b).val - configDry(a).val);
      });
    }
    return arr;
  }

  // Lightweight update of stats + config rows IN PLACE (no full innerHTML
  // rebuild), so the list doesn't lose its scroll position during autobet.
  function refreshDynamic() {
    if (!root || !state.settings.open) return;

    var nt = root.querySelector("#kt-nt");
    if (nt) nt.textContent = state.history.noncesTracked;
    var nn = root.querySelector("#kt-nn");
    if (nn) nn.textContent = "#" + state.history.noncesTracked;
    var cf = root.querySelector("#kt-cf");
    if (cf) cf.textContent = state.configs.length;
    var ld = root.querySelector("#kt-ld");
    if (ld) ld.textContent = state.history.lastDrawn.length ? state.history.lastDrawn.join(", ") : "none";

    if (dragging) return; // don't reorder/rewrite rows mid-drag
    popHealthCheck(); // close a popup whose anchor row is about to be rewritten

    var list = root.querySelector(".kt-config-list");
    if (!list) return;
    if (!state.configs.length) {
      render(); // empty-state message differs structurally
      return;
    }
    var byId = {};
    var children = Array.prototype.slice.call(list.children);
    children.forEach(function (el) {
      var id = el.getAttribute && el.getAttribute("data-id");
      if (id) byId[id] = el;
    });

    var prev = null;
    var draggable = state.settings.sortMode === "manual" ? "true" : "false";
    viewConfigs().forEach(function (c) {
      var el = byId[c.id];
      var sig = configRowSig(c);
      if (el) {
        applyRowState(el, c);
        if (el.getAttribute("draggable") !== draggable) el.setAttribute("draggable", draggable);
        // Only rewrite inner HTML when the row's content actually changed.
        if (el.getAttribute("data-sig") !== sig) {
          el.innerHTML = configRowInner(c);
          el.setAttribute("data-sig", sig);
        }
        // Dry counter ticks up every nonce — kept OUT of the sig (so turbo
        // autobet doesn't rebuild every row each draw) and patched in place.
        var dryEl = el.querySelector(".kt-dry");
        if (dryEl) dryEl.textContent = configDry(c).text;
        delete byId[c.id];
      } else {
        el = document.createElement("div");
        el.className = "kt-config";
        el.setAttribute("data-id", c.id);
        el.setAttribute("draggable", draggable);
        el.setAttribute("data-sig", sig);
        el.innerHTML = configRowInner(c);
        applyRowState(el, c);
      }
      // Enforce the view order in the DOM — this is what makes sort-mode
      // switches and live re-sorts actually MOVE rows (existing rows included),
      // not just patch their content in place.
      var expected = prev ? prev.nextSibling : list.firstChild;
      if (el !== expected) list.insertBefore(el, expected);
      prev = el;
    });
    for (var id in byId) {
      if (byId[id].parentNode) byId[id].parentNode.removeChild(byId[id]);
    }
  }

  var refreshScheduled = false;
  function scheduleRender() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(function () {
      refreshScheduled = false;
      refreshDynamic();
    }, 160);
  }

  function render() {
    if (!root) return;
    var s = state.settings;

    if (!s.open) {
      root.className = "kt-closed";
      root.removeAttribute("style");
      root.innerHTML = "";
      return;
    }

    // Preserve the list's scroll position across the full innerHTML rebuild
    // (otherwise autobet re-renders snap the list back to the top).
    var prevBody = root.querySelector(".kt-body");
    var prevScroll = prevBody ? prevBody.scrollTop : 0;

    var collapsed = !!s.collapsed;
    root.className =
      (s.mode === "float" ? "kt-open kt-float" : "kt-open kt-docked") +
      (collapsed ? " kt-collapsed" : "");

    var drawnStr = state.history.lastDrawn.length ? state.history.lastDrawn.join(", ") : "none";
    var configsHtml = state.configs.length
      ? viewConfigs().map(configRowHtml).join("")
      : '<div class="kt-empty">No configs yet. Select numbers on the board and press <b>Alt+S</b> (or Save config).</div>';

    var popTitle = s.mode === "float" ? "Dock to board" : "Pop out (drag anywhere)";
    var collapseTitle = collapsed ? "Expand" : "Collapse to configs only";

    // Full controls (hidden when collapsed — only the configs list remains).
    var fullHtml =
      '<div class="kt-stats">' +
      '<div><span class="kt-k">Nonces tracked</span><span id="kt-nt" class="kt-v">' +
      state.history.noncesTracked + "</span></div>" +
      '<div><span class="kt-k">Configs</span><span id="kt-cf" class="kt-v">' +
      state.configs.length + "</span></div>" +
      "</div>" +
      '<div class="kt-lastdraw"><span class="kt-k">Last draw</span><span id="kt-ld" class="kt-draw-nums">' +
      esc(drawnStr) + "</span></div>" +
      '<div class="kt-selection"><span class="kt-k">Selection</span>' +
      '<span id="kt-selection-nums" class="kt-v">—</span></div>' +
      '<div class="kt-actions">' +
      '<button class="kt-primary" data-act="save">Save config</button>' +
      '<button data-act="clear">Clear configs</button>' +
      '<button data-act="reset">Reset history</button>' +
      "</div>" +
      '<div class="kt-actions kt-actions-2nd">' +
      '<button data-act="export" title="Export config sets">Export</button>' +
      '<button data-act="import" title="Import config sets">Import</button>' +
      "</div>";

    root.innerHTML =
      '<div id="keno-tracker-panel">' +
      '<header class="kt-header">' +
      '<span class="kt-title"><span class="kt-title-txt"' + (s.hideTitle ? ' style="display:none"' : "") + ">Keno Tracker</span>" +
      '<span class="kt-nonce" id="kt-nn" title="Nonces tracked (current nonce)">#' + state.history.noncesTracked + "</span>" +
      '<span class="kt-heat" data-act="heat">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/>' +
      '</svg><i class="kt-heat-n">' + (s.heatWindow || 100) + "</i></span>" +
      '<span class="kt-multi">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 2l2.9 6.2 6.6.8-4.9 4.6 1.3 6.5L12 16.9 6.1 20l1.3-6.5L2.5 9l6.6-.8L12 2z"/>' +
      "</svg></span>" +
      '<span class="kt-oracle' + (state.seeds && state.seeds[0] && state.seeds[0].verified ? " kt-oracle-live" : "") + '" title="Seed checker">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M12 2a8 8 0 0 0-3.2 15.33V19a1 1 0 0 0 1 1h4.4a1 1 0 0 0 1-1v-1.67A8 8 0 0 0 12 2zm-.5 5.5a2.5 2.5 0 0 0-2.5 2.5 1 1 0 1 1-2 0 4.5 4.5 0 0 1 4.5-4.5 1 1 0 0 1 0 2zM10 21.5a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V21h-4z"/>' +
      "</svg></span></span>" +
      '<span class="kt-head-btns">' +
      '<button data-act="settingsmenu" title="Settings">⚙</button>' +
      '<button data-act="sortmenu" title="Sort configs">⇅</button>' +
      '<button data-act="collapse" title="' + collapseTitle + '">' + (collapsed ? "▴" : "▾") + "</button>" +
      '<button data-act="popout" title="' + popTitle + '">⤢</button>' +
      "</span>" +
      "</header>" +
      '<div class="kt-body">' +
      (collapsed ? "" : fullHtml) +
      '<div class="kt-config-list">' + configsHtml + "</div>" +
      "</div>" +
      // Toast OUTSIDE the scrolling body: floats over the panel bottom, so it
      // is always visible regardless of list length/scroll (and when collapsed).
      '<div id="kt-status" class="kt-status"></div>' +
      '<div class="kt-resize" title="Drag to resize · double-click to reset"></div>' +
      "</div>";

    var newBody = root.querySelector(".kt-body");
    if (newBody && prevScroll) newBody.scrollTop = prevScroll;

    if (!collapsed) updateSelectionDisplay();
    layout();
  }

  function updateSelectionDisplay() {
    try {
      var nums = readSelection();
      var el = root && root.querySelector("#kt-selection-nums");
      if (el) el.textContent = nums.length ? nums.join(", ") : "—";
      // Track which saved config matches the current board selection (the live
      // bet) so its row can be marked; re-mark rows when it changes.
      var key = nums.join(",");
      if (key !== activeKey) {
        activeKey = key;
        refreshDynamic();
      }
    } catch (e) {
      log("selection read error", e);
    }
  }

  // ---------------------------------------------------------------------------
  // Layout: float here; docked positioning is the adapter's job
  // ---------------------------------------------------------------------------
  // The board's on-screen rectangle (the keno grid) — generic helper for
  // adapters' docked-layout fallbacks.
  function boardRect() {
    var field = document.querySelector(".keno-field");
    if (field) {
      var fr = field.getBoundingClientRect();
      if (fr.width > 0) return fr;
    }
    var cls = classifyTiles();
    var minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    cls.tiles.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0) return;
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    });
    if (!isFinite(maxR)) return null;
    return { left: minL, top: minT, right: maxR, bottom: maxB, width: maxR - minL, height: maxB - minT };
  }

  // Lowest edge of the site's fixed/sticky top chrome (header + nav row), so a
  // docked panel stays below it while scrolling instead of sliding under it.
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

  // Clamp a user-chosen size to sane bounds within the viewport (so browser
  // zoom or a small window can never push the panel off-screen).
  function clampW(w) {
    return Math.max(240, Math.min(w, window.innerWidth - 16, 760));
  }
  function clampH(h) {
    return Math.max(220, Math.min(h, window.innerHeight - 16));
  }
  // The panel's effective width: the user's resized value, else the mode default.
  function effectiveW() {
    var w = state.settings.panelW;
    if (!w) w = state.settings.mode === "float" ? SITE.floatW || 340 : SITE.dockW || 330;
    return clampW(w);
  }
  // The user's resized height, or null to auto-size.
  function effectiveH() {
    return state.settings.panelH ? clampH(state.settings.panelH) : null;
  }

  function layout() {
    if (!root) return;
    var s = state.settings;

    if (!s.open) {
      root.removeAttribute("style");
      return;
    }
    if (s.mode === "float") {
      // Adapters may have re-parented the docked panel into the page layout;
      // floating always lives on <body>.
      if (root.parentElement !== document.body) document.body.appendChild(root);
      var fw = effectiveW();
      var fh = effectiveH();
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
      var card = root.querySelector("#keno-tracker-panel");
      if (card) card.style.maxHeight = fh ? "none" : "";
      return;
    }

    // Docked: the adapter knows where this site's board sits.
    try {
      SITE.dockLayout();
    } catch (e) {}
  }

  function setStyle(el, obj) {
    for (var k in obj) el.style[k] = obj[k];
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
    // Double-click (two grabs in quick succession) resets to the default size.
    // Detected by timing because preventDefault below suppresses the browser's
    // synthesized dblclick event.
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
    // The board may live in a cross-origin iframe; once the cursor crosses onto
    // it the iframe swallows pointer events and the drag stalls. A transparent
    // full-viewport shield keeps pointermove reaching us.
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
    // Handle is on the left edge: dragging left widens; dragging down heightens.
    // layout() is the single source of truth — we just feed it new dims.
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
    if (e.target.closest && e.target.closest(".kt-resize")) {
      startResize(e);
      return;
    }
    if (state.settings.mode !== "float") return;
    var header = e.target.closest && e.target.closest(".kt-header");
    if (!header || (e.target.closest && e.target.closest("button"))) return;
    var rect = root.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag) return;
    // Clip the drag to the viewport so the card can't be dropped off-screen.
    var r = root.getBoundingClientRect();
    var left = Math.max(8, Math.min(e.clientX - drag.dx, window.innerWidth - r.width - 8));
    var top = Math.max(8, Math.min(e.clientY - drag.dy, window.innerHeight - 68));
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
  // Panel events
  // ---------------------------------------------------------------------------
  // Flip a settings switch IN PLACE (toggle the class, don't rebuild the popup)
  // so the knob/track CSS transition can actually animate instead of snapping.
  function setSwitch(el, on) {
    if (!el) return;
    el.classList.toggle("kt-switch-on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function onPanelClick(e) {
    // A click anywhere outside the popup (and off its triggers) dismisses it.
    if (popEl && popEl.style.display !== "none") {
      if (e.target.closest(".kt-pop") || e.target.closest('[data-act="sortmenu"], [data-act="settingsmenu"]')) {
        // Clicking INSIDE a popup (or the click-born ⇅ menu) pins it — chip
        // clicks can resize the popup out from under the cursor, and the
        // hover-out close made that feel like the menu slamming shut.
        popPinned = true;
      } else if (!e.target.closest(".kt-info, .kt-heat, .kt-multi, .kt-oracle")) {
        // Clicked elsewhere → dismiss. Clicks on the hover triggers (ⓘ/★/🔥/🔮)
        // neither pin nor dismiss — those cards keep pure hover behaviour.
        hidePop();
      }
    }
    // Oracle card expand/collapse (inside the pinned popup).
    var orc = e.target.closest && e.target.closest("[data-act='orc-exp']");
    if (orc) {
      var oid = orc.getAttribute("data-id");
      for (var oi = 0; oi < state.configs.length; oi++) {
        if (state.configs[oi].id === oid) {
          state.configs[oi]._orcExp = !state.configs[oi]._orcExp;
          break;
        }
      }
      popPinned = true;
      // Re-render the popup in place WITHOUT losing the list scroll position
      // (rebuilding innerHTML would otherwise snap it back to the top).
      var prevList = popEl && popEl.querySelector(".kt-orc-list");
      var prevScroll = prevList ? prevList.scrollTop : 0;
      if (popTrigger) showPopFor(popTrigger, oraclePopHtml());
      var newList = popEl && popEl.querySelector(".kt-orc-list");
      if (newList) newList.scrollTop = prevScroll;
      return;
    }
    // "Scan more" — extend the current seed's range another step, in place.
    if (e.target.closest && e.target.closest("[data-act='orc-more']")) {
      popPinned = true;
      var mrec = state.seeds && state.seeds[0];
      if (mrec) {
        try {
          extendOracle(mrec, oracleData(mrec));
        } catch (em) {}
        var ml = popEl && popEl.querySelector(".kt-orc-list");
        var ms = ml ? ml.scrollTop : 0;
        if (popTrigger) showPopFor(popTrigger, oraclePopHtml());
        var ml2 = popEl && popEl.querySelector(".kt-orc-list");
        if (ml2) ml2.scrollTop = ms;
      }
      return;
    }
    if (e.target.closest("#kt-open")) {
      state.settings.open = true;
      persist();
      render();
      return;
    }
    var actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    switch (actEl.getAttribute("data-act")) {
      case "close":
        state.settings.open = false;
        persist();
        render();
        break;
      case "collapse":
        state.settings.collapsed = !state.settings.collapsed;
        persist();
        render();
        break;
      case "heat": {
        // Cycle the hot/cold lookback window and refresh the open popup.
        var hw = HEAT_WINDOWS.indexOf(state.settings.heatWindow);
        state.settings.heatWindow = HEAT_WINDOWS[(hw + 1) % HEAT_WINDOWS.length];
        persist();
        updateHeatLabel();
        syncBoardHeat();
        showPopFor(actEl, heatPopHtml());
        break;
      }
      case "win": {
        // Direct window pick from the chips inside the hot/cold popup.
        state.settings.heatWindow = parseInt(actEl.getAttribute("data-win"), 10) || 100;
        persist();
        updateHeatLabel();
        syncBoardHeat();
        if (popTrigger && popTrigger.isConnected) showPopFor(popTrigger, heatPopHtml());
        break;
      }
      case "hview": {
        // Ranked list ⇄ board layout — Board also paints the real keno board.
        state.settings.heatBoard = actEl.getAttribute("data-mode") === "board";
        persist();
        syncBoardHeat();
        if (popTrigger && popTrigger.isConnected) showPopFor(popTrigger, heatPopHtml());
        break;
      }
      case "export":
        exportConfigs();
        break;
      case "import":
        importConfigs();
        break;
      case "sortmenu":
        // Toggle: clicking the ⇅ again closes the menu. Click-born menus are
        // pinned from the start — they close on click, never on hover-out.
        if (popEl && popEl.style.display !== "none" && popTrigger === actEl) {
          hidePop();
        } else {
          showPopFor(actEl, sortMenuHtml());
          popPinned = true;
        }
        break;
      case "settingsmenu":
        if (popEl && popEl.style.display !== "none" && popTrigger === actEl) {
          hidePop();
        } else {
          showPopFor(actEl, settingsMenuHtml());
          popPinned = true;
        }
        break;
      case "tog-title":
        state.settings.hideTitle = state.settings.hideTitle !== true;
        persist();
        setSwitch(actEl, state.settings.hideTitle === true);
        var ttl = root.querySelector(".kt-title-txt");
        if (ttl) ttl.style.display = state.settings.hideTitle ? "none" : "";
        break;
      case "tog-backfill":
        state.settings.backfill = state.settings.backfill === false;
        persist();
        setSwitch(actEl, state.settings.backfill !== false);
        break;
      case "tog-seedreset":
        state.settings.resetOnSeed = state.settings.resetOnSeed === false;
        persist();
        setSwitch(actEl, state.settings.resetOnSeed !== false);
        break;
      case "tog-banner":
        state.settings.hitBanner = state.settings.hitBanner === false;
        persist();
        setSwitch(actEl, state.settings.hitBanner !== false);
        break;
      case "tog-drysmall":
        state.settings.dryCountSmall = state.settings.dryCountSmall !== true;
        persist();
        refreshDynamic(); // re-evaluate the dry baseline + meta for every row
        setSwitch(actEl, state.settings.dryCountSmall === true);
        break;
      case "tog-debug":
        state.settings.debug = state.settings.debug !== true;
        persist();
        setSwitch(actEl, state.settings.debug === true);
        break;
      case "tog-glow":
        state.settings.hitGlow = state.settings.hitGlow === false;
        persist();
        if (state.settings.hitGlow === false && SITE.glowBoard) {
          try {
            SITE.glowBoard([]); // clear any rings currently on the board
          } catch (e2) {}
          glowShown = false;
        }
        setSwitch(actEl, state.settings.hitGlow !== false);
        break;
      case "sort":
        state.settings.sortMode = actEl.getAttribute("data-mode") || "manual";
        persist();
        refreshDynamic(); // reorder rows in place — no rebuild, the menu stays open
        if (popTrigger && popTrigger.isConnected) showPopFor(popTrigger, sortMenuHtml());
        break;
      case "sortdir":
        // Single toggle: each click flips the direction and the arrow.
        state.settings.sortDir = state.settings.sortDir === "asc" ? "desc" : "asc";
        persist();
        refreshDynamic();
        if (popTrigger && popTrigger.isConnected) showPopFor(popTrigger, sortMenuHtml());
        break;
      case "popout":
        if (state.settings.mode !== "float") {
          // Popping OUT: freeze the current on-screen height so float doesn't
          // balloon to full — the user resizes from here manually.
          var _pr = root.getBoundingClientRect();
          if (_pr.height) state.settings.panelH = Math.round(_pr.height);
        }
        state.settings.mode = state.settings.mode === "float" ? "docked" : "float";
        if (state.settings.mode === "float" && !state.settings.floatPos) {
          state.settings.floatPos = { left: window.innerWidth - 380, top: 120 };
        }
        persist();
        render();
        break;
      case "save":
        saveCurrentSelection();
        break;
      case "clear":
        if (state.configs.length) ktConfirm("Remove all tracked configs?", clearConfigs);
        break;
      case "reset":
        ktConfirm("Reset all nonce/hit history?", resetHistory);
        break;
      case "del":
        deleteConfig(actEl.getAttribute("data-id"));
        break;
      case "toggle": {
        var id = actEl.getAttribute("data-id");
        var cfg = state.configs.filter(function (c) {
          return c.id === id;
        })[0];
        if (cfg) {
          cfg._expanded = !cfg._expanded;
          render();
        }
        break;
      }
    }
  }

  // Open/close the whole panel (used by the sites' bottom-toolbar buttons).
  function toggleOpen() {
    state.settings.open = !state.settings.open;
    persist();
    render();
  }

  // ---------------------------------------------------------------------------
  // Engine API → adapter, then boot
  // ---------------------------------------------------------------------------
  var E = {
    // state + persistence
    state: state,
    persist: persist,
    log: log,
    esc: esc,
    // board reading
    classifyTiles: classifyTiles,
    boardSelection: boardSelection,
    updatePaytableFromDOM: updatePaytableFromDOM,
    getPaytables: function () {
      return paytables;
    },
    mergePaytables: function (pt) {
      // REPLACE, don't merge: the reader relays its complete cache, and after
      // a risk switch it has deliberately dropped the old risk's sizes — a
      // merge would resurrect them on the panel side.
      if (pt) paytables = Object.assign({}, pt);
    },
    // draws
    processDraw: processDraw,
    nextDomNonce: nextDomNonce,
    onSeedReset: onSeedReset, // adapters call this when a seed rotation is seen
    onSeedRevealed: onSeedRevealed, // adapters call this (BEFORE onSeedReset) with the retired seed's plaintext
    // configs + hotkey
    saveCurrentSelection: saveCurrentSelection,
    hotkeyMatches: hotkeyMatches,
    onKeyDown: onKeyDown,
    // UI
    buildShell: buildShell,
    getRoot: function () {
      return root;
    },
    render: render,
    scheduleRender: scheduleRender,
    refreshDynamic: refreshDynamic,
    updateSelectionDisplay: updateSelectionDisplay,
    flashStatus: flashStatus,
    toggleOpen: toggleOpen,
    clearHitFx: removeHitFx, // adapters call this the moment a new bet fires
    // heat
    heatHues: heatHues,
    syncBoardHeat: syncBoardHeat,
    // layout helpers
    layout: layout,
    scheduleLayout: scheduleLayout,
    setStyle: setStyle,
    navBottom: navBottom,
    boardRect: boardRect,
    clampW: clampW,
    clampH: clampH,
    effectiveW: effectiveW,
    effectiveH: effectiveH
  };

  // Keep the debug flag live across frames: the ⚙ toggle persists from the
  // panel frame, but a board iframe (winna reader) loaded its settings at boot
  // and would never see it otherwise.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      var nv = changes[STORAGE_KEY].newValue;
      if (nv && nv.settings) state.settings.debug = nv.settings.debug === true;
    });
  } catch (e) {}

  SITE.attach(E);
  load(function () {
    SITE.init();
  });
})();
