// devtools.js — Runs in the DevTools context.
// Creates the custom panel and does nothing else.

chrome.devtools.panels.create(
  'UIKit',          // panel title shown in DevTools tab bar
  null,             // no icon (use null for default)
  'panel.html',     // panel HTML page
  function (panel) {
    // panel created — lifecycle events available if needed
    panel.onShown.addListener(function (win) {
      // panel became visible – panel.js handles its own init
    });
  }
);
