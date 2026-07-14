/*
 * Thrill Keno Tracker — network hook (MAIN world).
 *
 * Thrill settles every keno bet with a REST request (devtools shows it as
 * "bet") whose response carries the authoritative result:
 *   { "data": { "roundId": "…", "result": [10 numbers], "wonMultiplier": …,
 *               "balanceAfterBet": {…}, "balanceAfterWin": {…} },
 *     "responseCode": "OK" }
 * The content script (ISOLATED world) can't see the page's own fetch/XHR, so
 * this tiny shim runs in the page's MAIN world, wraps fetch and XMLHttpRequest,
 * and forwards the response body of keno bet requests to the content script
 * via a DOM CustomEvent.
 *
 * We forward when the *request* names keno, or when its path ends in /bet —
 * the content script then validates the response shape strictly (roundId +
 * a full draw of distinct board numbers), so unrelated traffic is dropped.
 */
(function () {
  "use strict";
  if (window.__kenoNetHookLoaded) return;
  window.__kenoNetHookLoaded = true;

  var EVT = "__kt_net_payload";

  // Leave a marker the ISOLATED content script can read (the two worlds share
  // the DOM but not JS globals). Its presence tells content.js a network
  // counter is available, so DOM draw counting can stand down once it fires.
  try {
    document.documentElement.setAttribute("data-kt-nethook", "1");
  } catch (e) {}

  // SPA route changes don't reload the page, so the content script can't tell
  // it left the keno page without polling. Patch the History API here in the
  // MAIN world (where the app actually calls it) and forward a nav event.
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

  // True when this request could be a keno bet settling: the URL/body names
  // keno, or the URL path ends in /bet. Deliberately a bit broad — the content
  // script validates the response shape before counting anything.
  function isKenoReq(url, body) {
    var s = url + " " + body;
    if (/keno/i.test(s)) return true;
    try {
      var path = url.split(/[?#]/)[0];
      if (/\/bet$/i.test(path)) return true;
    } catch (e) {}
    return false;
  }

  // Seed rotation: Thrill's fairness UI hits a /rotate endpoint that promotes
  // the "next" seed to active (nonce 0). Forward its response so the adapter can
  // reset the tracker for the new seed; the adapter shape-checks first. (The
  // read-only /activeandnext call is NOT a rotation, so it is left alone.)
  var SEED_EVT = "__kt_seed_reset";
  function emitSeed(text) {
    try {
      document.dispatchEvent(new CustomEvent(SEED_EVT, { detail: text }));
    } catch (e) {}
  }
  function isSeedReset(url) {
    try {
      var path = (url || "").split(/[?#]/)[0];
      return /\/rotate$/i.test(path);
    } catch (e) {
      return false;
    }
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
      if (isSeedReset(url)) {
        p.then(function (res) {
          try {
            res.clone().text().then(emitSeed).catch(function () {});
          } catch (e) {}
          return res;
        });
        return p;
      }
      if (!isKenoReq(url, body)) return p;
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
      this.__ktUrl = typeof url === "string" ? url : "";
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    if (isSeedReset(xhr.__ktUrl || "")) {
      this.addEventListener("load", function () {
        try {
          var t = xhr.responseType;
          if (t === "" || t === "text") emitSeed(xhr.responseText);
          else if (t === "json" && xhr.response) emitSeed(JSON.stringify(xhr.response));
        } catch (e) {}
      });
    } else if (isKenoReq(xhr.__ktUrl || "", typeof body === "string" ? body : "")) {
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
