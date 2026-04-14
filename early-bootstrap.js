// early-bootstrap.js — CSP-safe page-world bootstrap loaded as external script.
// Captures __THREE_DEVTOOLS__ observe events as early as possible into a queue.

// Backward-compat globals for previously injected hook variants.
// Keep these in global scope so legacy scripts don't crash with ReferenceError.
var observedRoots = window.observedRoots || new Set();
window.observedRoots = observedRoots;
var traversalRoots = window.traversalRoots || [];
window.traversalRoots = traversalRoots;

(function () {
  'use strict';

  if (window.__UIKitDevtoolsBootstrapInstalled__) return;
  window.__UIKitDevtoolsBootstrapInstalled__ = true;

  var queue = window.__UIKitDevtoolsEarlyQueue__;
  if (!Array.isArray(queue)) {
    queue = [];
    window.__UIKitDevtoolsEarlyQueue__ = queue;
  }

  function enqueueObserved(value) {
    try {
      queue.push(value);
      if (queue.length > 2000) queue.shift();
    } catch (_) { }
  }

  function attachObserve(target) {
    if (!target || typeof target.addEventListener !== 'function') return;
    if (target.__uikit_devtools_observe_attached__) return;
    target.__uikit_devtools_observe_attached__ = true;
    target.addEventListener('observe', function (event) {
      enqueueObserved(event ? event.detail : null);
    });
  }

  function createDevtoolsShim() {
    var listeners = new Map();
    return {
      __uikit_devtools_shim__: true,
      addEventListener: function (type, fn) {
        if (typeof fn !== 'function') return;
        var list = listeners.get(type);
        if (!list) {
          list = new Set();
          listeners.set(type, list);
        }
        list.add(fn);
      },
      removeEventListener: function (type, fn) {
        var list = listeners.get(type);
        if (list) list.delete(fn);
      },
      dispatchEvent: function (event) {
        var detail = event ? event.detail : null;
        enqueueObserved(detail && detail.object ? detail.object : detail);
        var type = event && event.type;
        var list = listeners.get(type);
        if (!list) return true;
        list.forEach(function (fn) {
          try { fn(event); } catch (_) { }
        });
        return true;
      }
    };
  }

  window.addEventListener('__THREE_DEVTOOLS__', function (event) {
    var detail = event ? event.detail : null;
    enqueueObserved(detail && detail.object ? detail.object : detail);
  });

  var current = window.__THREE_DEVTOOLS__ || createDevtoolsShim();
  try {
    if (!window.__THREE_DEVTOOLS__) window.__THREE_DEVTOOLS__ = current;
  } catch (_) { }
  attachObserve(current);

  try {
    Object.defineProperty(window, '__THREE_DEVTOOLS__', {
      configurable: true,
      get: function () {
        return current;
      },
      set: function (v) {
        current = v;
        attachObserve(v);
      }
    });
  } catch (_) {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      try {
        attachObserve(window.__THREE_DEVTOOLS__);
      } catch (_) { }
      if (attempts > 200) clearInterval(timer);
    }, 50);
  }
})();
