/*
 * Winna Mines network hook (MAIN world). WINNA ONLY.
 *
 * Mines settles over REST: a game starts with "play", each revealed tile is a
 * "turn", a cashout is "finish" (a busted tile is also a "turn" with
 * status:"lose"). Every one of those responses carries the authoritative
 * config we can't reliably read from the DOM during play:
 *   { ..., data: { mines, gridSize, choices:[…revealed tile indices] } }
 * The content script (ISOLATED world) can't see the page's own fetch/XHR, so
 * this shim wraps both in the MAIN world and forwards the response body of any
 * play/turn/finish request via a DOM CustomEvent (__mc_net). The mines adapter
 * shape-checks for { data.gridSize, data.mines } before using it, so unrelated
 * traffic (incl. keno/plinko "play") is ignored.
 */
(function () {
  "use strict";
  if (window.__minesNetHookLoaded) return;
  window.__minesNetHookLoaded = true;

  var EVT = "__mc_net";

  function emit(text) {
    try {
      document.dispatchEvent(new CustomEvent(EVT, { detail: text }));
    } catch (e) {}
  }

  // A mines state request: the path ends in /play, /turn or /finish. Broad on
  // purpose — the adapter validates the response shape before acting.
  function isMinesReq(url) {
    try {
      var path = (url || "").split(/[?#]/)[0];
      return /\/(play|turn|finish)$/i.test(path);
    } catch (e) {
      return false;
    }
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
      var p = origFetch.apply(this, arguments);
      if (!isMinesReq(url)) return p;
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
      this.__mcUrl = typeof url === "string" ? url : "";
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    if (isMinesReq(xhr.__mcUrl || "")) {
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
