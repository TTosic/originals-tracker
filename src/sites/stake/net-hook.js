/*
 * Stake Keno Tracker — network hook (MAIN world).
 *
 * Stake settles every keno bet with a GraphQL request whose response carries
 * the authoritative result: the real nonce, the drawn numbers, and the payout
 * multiplier. The content script (ISOLATED world) can't see the page's own
 * fetch/XHR, so this tiny shim runs in the page's MAIN world, wraps fetch and
 * XMLHttpRequest, and forwards the response body of *keno bet* requests to the
 * content script via a DOM CustomEvent.
 *
 * We gate strictly on the *request* mentioning keno, so the global "All Bets"
 * feed (everyone else's bets) and unrelated traffic are never forwarded — only
 * the player's own keno bets reach the tracker.
 */
(function () {
  "use strict";
  if (window.__kenoNetHookLoaded) return;
  window.__kenoNetHookLoaded = true;

  var EVT = "__kt_net_payload";

  // Leave a marker the ISOLATED content script can read (the two worlds share
  // the DOM but not JS globals). Its presence tells content.js the network is
  // the authoritative counter, so it disables the racy DOM draw counter and
  // never double-counts a bet.
  try {
    document.documentElement.setAttribute("data-kt-nethook", "1");
  } catch (e) {}

  // SPA route changes don't reload the page, so the content script can't tell it
  // left the keno page without polling. Patch the History API here in the MAIN
  // world (where the app actually calls it) and forward a nav event, so the
  // tracker can hide the instant the URL changes.
  function emitNav() {
    try {
      document.dispatchEvent(new CustomEvent("__kt_nav"));
    } catch (e) {}
  }
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== "function") return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      emitNav();
      return r;
    };
  });
  window.addEventListener("popstate", emitNav);
  window.addEventListener("hashchange", emitNav);

  // The response is forwarded as a *string*; strings clone reliably across the
  // MAIN↔ISOLATED world boundary (object details can come through as null).
  function emit(text) {
    try {
      document.dispatchEvent(new CustomEvent(EVT, { detail: text }));
    } catch (e) {}
  }

  // True when this request targets keno — either the URL path (REST) or the
  // GraphQL operation/body names it. We match the *request* (not the response)
  // so the global "All Bets" feed, which never asks for keno by name, is
  // excluded; only the player's own keno bets are forwarded.
  function isKenoReq(urlAndBody) {
    return typeof urlAndBody === "string" && /keno/i.test(urlAndBody);
  }

  // Seed rotation: Stake's fairness UI runs the GraphQL op `rotateSeedPair`
  // (new activeServerSeed, nonce 0). Forward its response so the adapter can
  // reset the tracker for the new seed; the adapter shape-checks first.
  var SEED_EVT = "__kt_seed_reset";
  function emitSeed(text) {
    try {
      document.dispatchEvent(new CustomEvent(SEED_EVT, { detail: text }));
    } catch (e) {}
  }
  function isSeedReset(urlAndBody) {
    return typeof urlAndBody === "string" && /rotateSeedPair/i.test(urlAndBody);
  }

  // Seed REVEAL (passive path): a rotated-away server seed's plaintext shows up
  // in the bet-detail GraphQL (data.bet.bet.serverSeed.seed) when the user opens
  // a past bet's fairness. We peek GraphQL responses for that shape and forward
  // it; the content script verifies SHA256(seed)===seedHash before acting.
  var REVEAL_EVT = "__kt_seed_reveal";
  function emitReveal(text) {
    try {
      document.dispatchEvent(new CustomEvent(REVEAL_EVT, { detail: text }));
    } catch (e) {}
  }
  function isGraphql(url) {
    return typeof url === "string" && /graphql/i.test(url);
  }
  function looksLikeReveal(text) {
    return typeof text === "string" && text.indexOf('"serverSeed"') !== -1 && text.indexOf('"seedHash"') !== -1;
  }

  // ZERO-CLICK REVEAL via `serverSeedByHash(hash)` — a Stake query that returns a
  // server seed's plaintext by its HASH (null while active, the real seed once
  // rotated out). We already see every seed's hash on rotation, so after each
  // rotation we fetch the JUST-RETIRED seed's plaintext with no bet/iid/panel.
  //   * activePair — the currently active {hash, client}, tracked from any
  //     response carrying activeServerSeed+activeClientSeed (UserSeedPair /
  //     rotateSeedPair). On rotation the retired pair = the PREVIOUS activePair.
  //   * auth comes from the user's own GraphQL headers (captured live); nothing
  //     is forged or persisted.
  var PLAIN_EVT = "__kt_seed_plain";
  function emitPlain(server, client, seedHash) {
    try {
      document.dispatchEvent(new CustomEvent(PLAIN_EVT, { detail: JSON.stringify({ server: server, client: client, seedHash: seedHash }) }));
    } catch (e) {}
  }
  function headersToObj(h) {
    var o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === "function") {
        h.forEach(function (v, k) {
          o[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) o[h[i][0]] = h[i][1];
      } else {
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) o[k] = h[k];
      }
    } catch (e) {}
    delete o["content-length"];
    delete o["Content-Length"];
    return o;
  }
  var lastGqlHeaders = null;
  var lastGqlUrl = "/_api/graphql";
  var activePair = { hash: null, client: null };
  function findActivePair(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 10) return null;
    if (obj.activeServerSeed && obj.activeClientSeed && obj.activeServerSeed.seedHash && obj.activeClientSeed.seed) {
      return { hash: obj.activeServerSeed.seedHash, client: obj.activeClientSeed.seed };
    }
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === "object") {
        var f = findActivePair(v, depth + 1);
        if (f) return f;
      }
    }
    return null;
  }
  function updateActivePair(json) {
    var np = findActivePair(json);
    if (np) activePair = np;
  }
  function fetchServerSeed(hash, client, attempt) {
    if (!lastGqlHeaders || !hash || attempt > 3) return;
    var f = origFetch || window.fetch;
    f.call(window, lastGqlUrl, {
      method: "POST",
      headers: lastGqlHeaders,
      credentials: "include",
      body: JSON.stringify({
        operationName: "serverSeedByHash",
        query: "query serverSeedByHash($hash: String!) {\n  serverSeedByHash(hash: $hash) {\n    id\n    seed\n    active\n    __typename\n  }\n}",
        variables: { hash: hash }
      })
    })
      .then(function (r) {
        return r.text();
      })
      .then(function (t) {
        var s = null;
        try {
          s = JSON.parse(t);
          s = s && s.data && s.data.serverSeedByHash;
        } catch (e) {}
        if (s && s.seed && s.active === false) emitPlain(s.seed, client, hash);
        else setTimeout(function () { fetchServerSeed(hash, client, (attempt || 0) + 1); }, 900); // not settled yet
      })
      .catch(function () {
        setTimeout(function () { fetchServerSeed(hash, client, (attempt || 0) + 1); }, 900);
      });
  }
  function revealRetiredSeed(rotateText) {
    try {
      var retired = activePair.hash ? { hash: activePair.hash, client: activePair.client } : null;
      updateActivePair(JSON.parse(rotateText)); // advance active to the new pair
      if (retired && retired.hash) fetchServerSeed(retired.hash, retired.client, 0);
    } catch (e) {}
  }

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url; // Request object
    } catch (e) {}
    return "";
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = urlOf(input);
      var body = init && typeof init.body === "string" ? init.body : "";
      var p = origFetch.apply(this, arguments);
      var reqText = url + " " + body;
      // Capture the user's own GraphQL auth headers (used to fetch serverSeedByHash).
      if (isGraphql(url) && init && init.headers) {
        lastGqlHeaders = headersToObj(init.headers);
        lastGqlUrl = url;
      }
      if (isSeedReset(reqText)) {
        p.then(function (res) {
          try {
            res.clone().text().then(function (t) {
              emitSeed(t); // history reset
              revealRetiredSeed(t); // zero-click: fetch the just-retired seed's plaintext
            }).catch(function () {});
          } catch (e) {}
          return res;
        });
        return p;
      }
      if (!isKenoReq(reqText)) {
        if (isGraphql(url)) {
          p.then(function (res) {
            try {
              res.clone().text().then(function (t) {
                if (looksLikeReveal(t)) emitReveal(t);
                if (t.indexOf('"activeServerSeed"') !== -1) {
                  try {
                    updateActivePair(JSON.parse(t)); // keep the active {hash,client} current
                  } catch (e2) {}
                }
              }).catch(function () {});
            } catch (e) {}
            return res;
          });
        }
        return p;
      }
      return p.then(function (res) {
        try {
          res
            .clone()
            .text()
            .then(function (t) {
              emit(t);
              if (looksLikeReveal(t)) emitReveal(t); // a bet-detail query can name keno
            })
            .catch(function () {});
        } catch (e) {}
        return res;
      });
    };
  }

  // ---- XMLHttpRequest ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__ktUrl = typeof url === "string" ? url : "";
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var reqText = (xhr.__ktUrl || "") + " " + (typeof body === "string" ? body : "");
    if (isSeedReset(reqText)) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          if (t === "" || t === "text") emitSeed(xhr.responseText);
          else if (t === "json" && xhr.response) emitSeed(JSON.stringify(xhr.response));
        } catch (e) {}
      });
    } else if (isKenoReq(reqText)) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          var txt = t === "" || t === "text" ? xhr.responseText : t === "json" && xhr.response ? JSON.stringify(xhr.response) : "";
          if (txt) {
            emit(txt);
            if (looksLikeReveal(txt)) emitReveal(txt);
          }
        } catch (e) {}
      });
    } else if (isGraphql(xhr.__ktUrl || "")) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          var txt = t === "" || t === "text" ? xhr.responseText : t === "json" && xhr.response ? JSON.stringify(xhr.response) : "";
          if (looksLikeReveal(txt)) emitReveal(txt);
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
