/*
 * Stake Mines Tracker — network hook (MAIN world).
 *
 * Mirrors the Stake keno net-hook: the page settles every mines bet with a
 * GraphQL request whose response carries the authoritative round — the nonce,
 * the full mine layout, the mine count, and the payout. The ISOLATED content
 * script can't see the page's own fetch/XHR, so this MAIN-world shim wraps them
 * and forwards the response body of *mines* requests to the content script.
 *
 * Gated strictly on the request naming mines, so the global "All Bets" feed and
 * unrelated traffic are never forwarded — only the player's own mines rounds.
 *
 * Namespaced apart from the keno hook: guard __stakeMinesNetHookLoaded, event
 * __sm_net, marker data-sm-nethook, nav event __sm_nav.
 */
(function () {
  "use strict";
  if (window.__stakeMinesNetHookLoaded) return;
  window.__stakeMinesNetHookLoaded = true;

  var EVT = "__sm_net";

  try {
    document.documentElement.setAttribute("data-sm-nethook", "1");
  } catch (e) {}

  function emitNav() {
    try {
      document.dispatchEvent(new CustomEvent("__sm_nav"));
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

  // Forwarded as a string — strings clone reliably across the MAIN↔ISOLATED
  // boundary (object details can arrive null).
  function emit(text) {
    try {
      document.dispatchEvent(new CustomEvent(EVT, { detail: text }));
    } catch (e) {}
  }

  // True when this request targets mines — the URL or the GraphQL op/body names
  // it. Matching the *request* excludes the global bet feed (never asks for
  // mines by name); only the player's own mines rounds are forwarded.
  function isMinesReq(urlAndBody) {
    return typeof urlAndBody === "string" && /mines/i.test(urlAndBody);
  }

  // Seed rotation is account-level (shared across all game modes), so the mines
  // tracker resets on it too. Same GraphQL op as keno — `rotateSeedPair` (new
  // activeServerSeed, nonce 0). Forward its response on a namespaced event; the
  // tracker shape-checks before acting.
  var SEED_EVT = "__sm_seed_reset";
  function emitSeed(text) {
    try {
      document.dispatchEvent(new CustomEvent(SEED_EVT, { detail: text }));
    } catch (e) {}
  }
  function isSeedReset(urlAndBody) {
    return typeof urlAndBody === "string" && /rotateSeedPair/i.test(urlAndBody);
  }

  // ZERO-CLICK seed REVEAL for the mines seed checker — same as keno's: after a
  // rotation, fetch the JUST-RETIRED seed's plaintext via `serverSeedByHash(hash)`
  // (null while active, the real seed once rotated out). We track the active
  // {hash, client} from any response carrying activeServerSeed+activeClientSeed,
  // and reuse the user's own GraphQL auth. Emits __sm_seed_plain.
  var PLAIN_EVT = "__sm_seed_plain";
  function emitPlain(server, client, seedHash) {
    try {
      document.dispatchEvent(new CustomEvent(PLAIN_EVT, { detail: JSON.stringify({ server: server, client: client, seedHash: seedHash }) }));
    } catch (e) {}
  }
  function isGraphql(url) {
    return typeof url === "string" && /graphql/i.test(url);
  }
  function headersToObj(h) {
    var o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === "function") h.forEach(function (v, k) { o[k] = v; });
      else if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) o[h[i][0]] = h[i][1]; }
      else { for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) o[k] = h[k]; }
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
        else setTimeout(function () { fetchServerSeed(hash, client, (attempt || 0) + 1); }, 900);
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
      if (input && typeof input.url === "string") return input.url;
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
      if (isGraphql(url) && init && init.headers) {
        lastGqlHeaders = headersToObj(init.headers); // user's own auth, for serverSeedByHash
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
      if (!isMinesReq(reqText)) {
        if (isGraphql(url)) {
          // Peek non-mines graphql for the active seed pair (UserSeedPair etc.).
          p.then(function (res) {
            try {
              res.clone().text().then(function (t) {
                if (t.indexOf('"activeServerSeed"') !== -1) {
                  try {
                    updateActivePair(JSON.parse(t));
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
            .then(emit)
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
      this.__smUrl = typeof url === "string" ? url : "";
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var reqText = (xhr.__smUrl || "") + " " + (typeof body === "string" ? body : "");
    if (isSeedReset(reqText)) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          if (t === "" || t === "text") emitSeed(xhr.responseText);
          else if (t === "json" && xhr.response) emitSeed(JSON.stringify(xhr.response));
        } catch (e) {}
      });
    } else if (isMinesReq(reqText)) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          if (t === "" || t === "text") emit(xhr.responseText);
          else if (t === "json" && xhr.response) emit(JSON.stringify(xhr.response));
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
