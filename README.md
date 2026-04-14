# UIKit DevTools — Chrome Extension

A Manifest V3 Chrome DevTools extension that inspects live **Three.js** scene hierarchies
with extra metadata support for **pmndrs/uikit** objects.

---

## Install (unpacked)

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`chrome-uikit-devtools/`).
4. The extension is now installed. Open DevTools (`F12` / `⌥⌘I`) on any page
   that uses Three.js — a **UIKit** tab will appear in the DevTools panel bar.

---

## Features

| Feature | Notes |
|---------|-------|
| Scene hierarchy tree | Collapsible, searchable, live-updated |
| Works on any Three.js page | No UIKit dependency required |
| Two discovery paths | `__THREE_DEVTOOLS__` observe events + fallback global scan |
| Renderer interception | Discovers scenes via `renderer.render()` patches |
| Live selection | Click a node → `window.$ui` / `window.$ui0` set in page context |
| Print to console | Right-click any node → logged with `console.log` |
| Live editor | Edit `name`, `visible`, `renderOrder`, `position`, `scale`, `rotation` |
| UIKit metadata | Shows `properties` and yoga layout node values for UIKit objects |
| Push updates | Mutations (add/remove/attach/clear) trigger immediate snapshots |
| Transform polling | Catches direct property writes via 500 ms dirty-check loop |
| Throttled snapshots | At most one snapshot per 100 ms regardless of mutation rate |
| Auto refresh | Optional 2 s pull loop as a recovery path |
| Resizable split pane | Drag the divider between tree and details |
| Dark/light themes | Respects `prefers-color-scheme` automatically |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Inspected page (main world)                             │
│                                                          │
│  page-hook.js                                            │
│  ├─ scene discovery  (THREE_DEVTOOLS + renderer + scan)  │
│  ├─ Object3D traversal + snapshot builder                │
│  ├─ mutation patches  (add/remove/attach/clear)          │
│  ├─ transform polling (500 ms dirty-check)               │
│  └─ window.__UIKitDevTools  (public API for eval)        │
│       │  CustomEvent '__uikit_devtools_snapshot__'       │
└───────┼──────────────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────┐
│  Content script  (isolated world)                        │
│  content-script.js                                       │
│  ├─ injects page-hook.js via <script> tag                │
│  └─ bridges CustomEvents → chrome.runtime port           │
└───────┬──────────────────────────────────────────────────┘
        │ chrome.runtime.connect('content-script')
┌───────▼──────────────────────────────────────────────────┐
│  Background service worker                               │
│  background.js                                           │
│  └─ relays messages: content-script ↔ devtools-panel    │
└───────┬──────────────────────────────────────────────────┘
        │ chrome.runtime.connect('devtools-panel')
┌───────▼──────────────────────────────────────────────────┐
│  DevTools panel  (panel.html / panel.js)                 │
│  ├─ renders hierarchy tree + details editor              │
│  ├─ receives snapshots from background                   │
│  └─ issues commands via inspectedWindow.eval()           │
└──────────────────────────────────────────────────────────┘
```

### Message flow

**Push (snapshot):**
`page hook` → CustomEvent → `content-script` → port → `background` → port → `panel`

**Commands (editing / selection):**
`panel` → `chrome.devtools.inspectedWindow.eval()` → `window.__UIKitDevTools.*`

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 extension manifest |
| `devtools.html` | DevTools bootstrap page (minimal) |
| `devtools.js` | Creates the custom panel |
| `background.js` | Service worker — message relay |
| `content-script.js` | Isolated world — injects hook, bridges events |
| `page-hook.js` | Main world — scene discovery, traversal, mutation tracking |
| `panel.html` | Panel UI markup |
| `panel.js` | Panel logic — tree, details editor, port management |
| `panel.css` | Panel styles (supports dark + light themes) |
| `README.md` | This file |

---

## UIKit object detection

An object is considered a **UIKit** node when all of the following hold:

```js
obj.isObject3D === true
typeof obj.setProperties === 'function'
obj.properties != null
obj.node != null
```

UIKit nodes get a green **uikit** tag in the tree, and the details pane shows
their `properties` bag and common yoga layout node values (`width`, `height`,
`flexDirection`, `justifyContent`, etc.).

---

## Keyboard / mouse shortcuts

| Action | How |
|--------|-----|
| Select object | Click tree node |
| Expand / collapse | Click the `▸` / `▾` arrow |
| Expand all | Toolbar `⊞` button |
| Collapse all | Toolbar `⊟` button |
| Print to console | Right-click tree node |
| Resize pane | Drag the vertical divider |

---

## Development notes

- **No bundler needed** — plain JS, load unpacked as-is.
- The service worker (`background.js`) stays alive while DevTools is open
  because the panel holds a persistent port connection.
- `page-hook.js` guards against double-injection; safe across SPA navigations.
- Snapshot serialisation strips live Three.js objects — only plain JS values
  are sent across the message boundary. Live refs stay in `objectMap` inside
  the hook and are accessed from the panel only via `eval()`.
# UIKit Chrome DevTools Inspector

Chrome extension to inspect pmndrs/uikit object trees inside Three.js scenes.

## Features

- Scene discovery via `__THREE_DEVTOOLS__` observe events plus fallback global scanning for `THREE.Scene` instances.
- Full Three.js scene traversal: every `Object3D` under tracked scenes is serialized into the hierarchy and flat lookup map.
- Object details panel (transform, type, userData, selected UIKit properties).
- Selection bridge: click node in panel and expose object as `window.$ui` and `window.$ui0` in page context.
- Right-click any hierarchy node and use "Print object in main console" to log the real object in inspected page console.
- Auto refresh on scene graph mutations (`add`, `remove`, `attach`, `clear`) and throttled frame-based change detection.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `tools/chrome-uikit-devtools`.
5. Open target page and then open Chrome DevTools.
6. Open **UIKit** panel.

## Notes

- Extension listens to `__THREE_DEVTOOLS__` and also scans common globals so it can still find scenes when the observe hook is missed.
- Snapshots are rebuilt by traversing tracked scenes, then mirrored into a flat lookup map used by the editor panel.
- For pages that initialize before injection, click **Refresh** in the panel to force scene discovery and rebuild the snapshot.
