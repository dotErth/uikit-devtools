// background.js — MV3 service worker.
// Relays messages between content scripts (one per inspected tab) and the
// DevTools panel port (one per open DevTools window).
//
// Port naming convention:
//   'devtools-panel'   opened by panel.js
//   'content-script'   opened by content-script.js

'use strict';

/** @type {Map<number, chrome.runtime.Port>} tabId → panel port */
const panelPorts = new Map();

/** @type {Map<number, chrome.runtime.Port>} tabId → content-script port */
const contentPorts = new Map();

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'devtools-panel') {
    onPanelConnect(port);
  } else if (port.name === 'content-script') {
    onContentConnect(port);
  }
});

// ── Panel port ───────────────────────────────────────────────────────────────

function onPanelConnect(port) {
  let tabId = null;

  port.onMessage.addListener(function (msg) {
    if (msg.type === 'init') {
      // First message from panel identifies which tab it inspects.
      tabId = msg.tabId;
      panelPorts.set(tabId, port);

      // If the content script is already connected, tell the panel.
      if (contentPorts.has(tabId)) {
        safeSend(port, { type: 'content-ready' });
      }
      return;
    }

    // Any other message from the panel → relay to content script.
    if (tabId !== null) {
      const cs = contentPorts.get(tabId);
      if (cs) safeSend(cs, msg);
    }
  });

  port.onDisconnect.addListener(function () {
    if (tabId !== null) panelPorts.delete(tabId);
  });
}

// ── Content-script port ──────────────────────────────────────────────────────

function onContentConnect(port) {
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;

  contentPorts.set(tabId, port);

  // Notify panel (if open) that the content script side is available.
  const panel = panelPorts.get(tabId);
  if (panel) safeSend(panel, { type: 'content-ready' });

  port.onMessage.addListener(function (msg) {
    // Relay every message from the page hook → panel.
    const p = panelPorts.get(tabId);
    if (p) safeSend(p, msg);
  });

  port.onDisconnect.addListener(function () {
    contentPorts.delete(tabId);
    // Notify panel the page/content script disconnected.
    const p = panelPorts.get(tabId);
    if (p) safeSend(p, { type: 'disconnected' });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeSend(port, msg) {
  try {
    port.postMessage(msg);
  } catch (_) {
    // Port may have been closed between check and send — ignore.
  }
}
