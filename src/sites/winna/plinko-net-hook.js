/*
 * Winna Plinko Tracker — network hook (MAIN world, document_start).
 *
 * The Plinko ball is drawn on a <canvas>, and the board's only DOM signal is
 * the `multiplier-hit` class, which stays put when consecutive balls land in
 * the same bucket — so the DOM can't count repeats. The authoritative source is
 * the bet response itself (nonce + payout multiplier per ball), which we read
 * by wrapping fetch / XMLHttpRequest / WebSocket here in the page's own world.
 *
 * Each detected bet is handed to the ISOLATED content script via a DOM
 * CustomEvent ("pt-net-bet") — content scripts share the DOM, so no
 * postMessage (and no "Unknown message type!" console spam from winna's page).
 */
(function () {
  "use strict";
  if (window.__plinkoNetHookLoaded) return;
  window.__plinkoNetHookLoaded = true;

  function emit(bet) {
    try {
      document.dispatchEvent(
        new CustomEvent("pt-net-bet", { detail: JSON.stringify(bet) })
      );
    } catch (e) {}
  }

  // Seed rotation is account-level (shared across all game modes), so the plinko
  // tracker resets on it too. Winna's fairness /unhash response reveals the old
  // seed and issues a fresh one — { response: { new_seed:{nonce:0,…}, old_seed }
  // }. We parse every JSON response anyway, so detect that shape here (no URL in
  // the fetch wrapper) and signal the content script on a namespaced event.
  function emitSeedReset() {
    try {
      document.dispatchEvent(new CustomEvent("pt-seed-reset"));
    } catch (e) {}
  }
  function isSeedResetJson(json) {
    return !!(json && json.response && json.response.new_seed);
  }

  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    return null;
  }

  var MULT_KEYS = /^(payoutmultiplier|payout_multiplier|multiplier|mult|payoutmult)$/;
  var NONCE_KEYS = /^(nonce|id|betid|bet_id|gameid|game_id)$/;

  function strId(v) {
    if (typeof v === "number" && isFinite(v)) return String(v);
    if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  }

  function looksLikePlinkoBet(node) {
    return (
      node &&
      typeof node === "object" &&
      node.data &&
      typeof node.data === "object" &&
      node.data.service === "originals" &&
      typeof node.data.pins !== "undefined" &&
      typeof node.data.bucket !== "undefined" &&
      typeof node.multiplier !== "undefined"
    );
  }

  function directBet(node, ctxNonce) {
    if (!node || typeof node !== "object") return null;

    // This is the response shape the user showed from the `play` request:
    // { id, multiplier, data:{ service:"originals", pins, bucket, difficulty } }
    if (looksLikePlinkoBet(node)) {
      return {
        n: strId(node.nonce) || strId(node.id) || ctxNonce,
        m: num(node.multiplier),
        bucket: num(node.data.bucket),
        pins: num(node.data.pins),
        difficulty: node.data.difficulty || null
      };
    }

    var nonce = ctxNonce;
    for (var nk in node) {
      if (Object.prototype.hasOwnProperty.call(node, nk) && NONCE_KEYS.test(nk.toLowerCase())) {
        nonce = strId(node[nk]) || nonce;
        break;
      }
    }

    var mult = null;
    for (var mk in node) {
      if (Object.prototype.hasOwnProperty.call(node, mk) && MULT_KEYS.test(mk.toLowerCase())) {
        mult = num(node[mk]);
        break;
      }
    }
    if (nonce && mult != null && mult >= 0 && mult <= 1000000) {
      return { n: nonce, m: mult };
    }
    return null;
  }

  // Collect {nonce, mult} pairs from arbitrary parsed JSON. The nonce may sit on
  // an ancestor object of the multiplier, so it's threaded down the walk.
  function extractBets(data) {
    var out = [];
    walk(data, 0, null);
    return out;

    function walk(node, depth, ctxNonce) {
      if (!node || typeof node !== "object" || depth > 12) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, ctxNonce);
        return;
      }
      var myNonce = ctxNonce;
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (NONCE_KEYS.test(k.toLowerCase())) {
          myNonce = strId(node[k]) || myNonce;
          break;
        }
      }
      var bet = directBet(node, myNonce);
      if (bet && bet.n && bet.m != null) out.push(bet);
      for (var k2 in node) {
        if (Object.prototype.hasOwnProperty.call(node, k2)) walk(node[k2], depth + 1, myNonce);
      }
    }
  }

  // A live bet response carries one bet (or a small autobet batch). A response
  // carrying many bet objects is almost certainly bet *history* loading — skip
  // it so we don't replay old nonces as new bets.
  function handle(json) {
    if (!json || typeof json !== "object") return;
    if (isSeedResetJson(json)) {
      emitSeedReset();
      return;
    }
    var bets;
    try {
      bets = extractBets(json);
    } catch (e) {
      return;
    }
    if (bets.length < 1 || bets.length > 25) return;
    for (var i = 0; i < bets.length; i++) emit(bets[i]);
  }

  function tryParse(text) {
    if (typeof text !== "string" || !text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      // socket.io / engine.io frames look like `42["evt",{…}]` — parse the array.
      var idx = text.indexOf("[");
      var brace = text.indexOf("{");
      var start = idx === -1 ? brace : brace === -1 ? idx : Math.min(idx, brace);
      if (start > 0) {
        try {
          return JSON.parse(text.slice(start));
        } catch (e2) {}
      }
    }
    return null;
  }

  // --- fetch ---
  if (typeof window.fetch === "function") {
    var origFetch = window.fetch;
    window.fetch = function () {
      var p = origFetch.apply(this, arguments);
      try {
        p.then(function (res) {
          try {
            var ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
            if (/json/i.test(ct)) {
              res
                .clone()
                .json()
                .then(function (j) {
                  handle(j);
                })
                .catch(function () {});
            }
          } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  }

  // --- XMLHttpRequest ---
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () {
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      this.addEventListener("load", function () {
        try {
          if (xhr.responseType === "" || xhr.responseType === "text") {
            var j = tryParse(xhr.responseText);
            if (j) handle(j);
          } else if (xhr.responseType === "json" && xhr.response) {
            handle(xhr.response);
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  // --- WebSocket ---
  try {
    var OrigWS = window.WebSocket;
    if (OrigWS) {
      var PatchedWS = function (url, protocols) {
        var ws = arguments.length > 1 ? new OrigWS(url, protocols) : new OrigWS(url);
        try {
          ws.addEventListener("message", function (ev) {
            try {
              if (typeof ev.data === "string") {
                var j = tryParse(ev.data);
                if (j) handle(j);
              }
            } catch (e) {}
          });
        } catch (e) {}
        return ws;
      };
      PatchedWS.prototype = OrigWS.prototype;
      ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
        try {
          PatchedWS[k] = OrigWS[k];
        } catch (e) {}
      });
      window.WebSocket = PatchedWS;
    }
  } catch (e) {}
})();
