// content-script.js — Runs at document_start in isolated world.
// Injects page-hook.js into page world ASAP and bridges hook events to background.

'use strict';

(function () {
  function injectExternalScript(id, fileName, onload) {
    const existing = document.getElementById(id);
    if (existing) {
      if (onload) onload();
      return;
    }

    const s = document.createElement('script');
    s.id = id;
    try {
      s.src = chrome.runtime.getURL(fileName);
    } catch (_) {
      // Happens if extension was reloaded and this old content-script instance is stale.
      return;
    }
    s.async = false;
    s.onload = function () {
      s.remove();
      if (onload) onload();
    };
    (document.documentElement || document.head || document.body).appendChild(s);
  }

  function injectHookNow() {
    injectExternalScript('__uikit_devtools_hook__', 'page-hook.js');
  }

  injectExternalScript('__uikit_devtools_bootstrap__', 'early-bootstrap.js', injectHookNow);

  // Fallback if bootstrap load is delayed: still enforce bootstrap -> hook order.
  setTimeout(function () {
    injectExternalScript('__uikit_devtools_bootstrap__', 'early-bootstrap.js', injectHookNow);
  }, 80);
  if (!window.__UIKitDevTools) {
    setTimeout(function () {
      injectExternalScript('__uikit_devtools_bootstrap__', 'early-bootstrap.js', injectHookNow);
    }, 50);
  }

  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'content-script' });
    } catch (_) {
      return;
    }

    port.onDisconnect.addListener(function () {
      port = null;
      setTimeout(connect, 1000);
    });
  }

  function relay(msg) {
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch (_) { }
  }

  function notifyNavigation(reason) {
    relay({ type: 'page-navigation', reason: reason || 'unknown' });
    // On SPA/full reload edges, attempt bootstrap+hook reinjection.
    injectExternalScript('__uikit_devtools_bootstrap__', 'early-bootstrap.js', injectHookNow);
  }

  connect();

  window.addEventListener('__uikit_devtools_ready__', function () {
    relay({ type: 'ready' });
  });

  window.addEventListener('__uikit_devtools_snapshot__', function (e) {
    relay({ type: 'snapshot', data: e.detail });
  });

  window.addEventListener('__uikit_devtools_navigation__', function (e) {
    const reason = e && e.detail && e.detail.reason ? e.detail.reason : 'page-hook';
    notifyNavigation(reason);
  });

  // Navigation/lifecycle fallback events from isolated world.
  window.addEventListener('pageshow', function () { notifyNavigation('pageshow'); });
  window.addEventListener('pagehide', function () { notifyNavigation('pagehide'); });
  window.addEventListener('popstate', function () { notifyNavigation('popstate'); });
  window.addEventListener('hashchange', function () { notifyNavigation('hashchange'); });
  window.addEventListener('load', function () { notifyNavigation('load'); });
})();
