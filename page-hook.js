// page-hook.js — runs in inspected page world.

// Backward-compat globals for previously injected variants.
// Keep in script global scope (not inside IIFE) so bare identifier lookups work.
var observedRoots = window.observedRoots;
if (!(observedRoots instanceof Set)) observedRoots = new Set();
window.observedRoots = observedRoots;

var traversalRoots = window.traversalRoots;
if (!traversalRoots || typeof traversalRoots[Symbol.iterator] !== 'function') traversalRoots = [];
window.traversalRoots = traversalRoots;

(function () {
  'use strict';

  if (window.__UIKitDevTools) {
    window.dispatchEvent(new CustomEvent('__uikit_devtools_ready__'));
    return;
  }

  const scenes = new Map();
  const sceneRefs = new WeakSet();
  const orphanRoots = new Map();
  const orphanRefs = new WeakSet();
  const objectMap = new Map();
  const signatures = new Map();
  const pendingObserved = [];
  let selectedUuid = null;
  let highlightOverlayEl = null;
  let highlightOverlayBoxEl = null;
  let highlightOverlayShadeTopEl = null;
  let highlightOverlayShadeLeftEl = null;
  let highlightOverlayShadeRightEl = null;
  let highlightOverlayShadeBottomEl = null;
  let lastOverlayRenderer = null;
  let lastOverlayScene = null;
  let lastOverlayCamera = null;
  let capturedTHREE = null;

  let pushTimer = null;
  let dirty = false;
  let overlayQueued = false;
  let lastOverlayUpdateTime = 0;

  const OVERLAY_MIN_INTERVAL_MS = 50;

  function bboxLog() {}

  function bboxError() {}

  const PATCH_SYMBOL = '__uikit_patched__';
  const RENDER_PATCH_SYMBOL = '__uikit_renderer_intercepted__';

  function ensureHighlightOverlay() {
    if (highlightOverlayEl && highlightOverlayEl.isConnected) return highlightOverlayEl;

    const root = document.createElement('div');
    root.id = '__uikit_devtools_bbox_overlay__';
    root.style.position = 'fixed';
    root.style.left = '0px';
    root.style.top = '0px';
    root.style.width = '100vw';
    root.style.height = '100vh';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483647';
    root.style.display = 'none';

    function makeShade() {
      const shade = document.createElement('div');
      shade.style.position = 'fixed';
      shade.style.pointerEvents = 'none';
      shade.style.background = 'rgba(26,115,232,0.3)';
      return shade;
    }

    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = '-99999px';
    box.style.top = '-99999px';
    box.style.width = '0px';
    box.style.height = '0px';
    box.style.border = '2px solid #1a73e8';
    box.style.boxSizing = 'border-box';
    box.style.borderRadius = '2px';
    box.style.pointerEvents = 'none';

    const shadeTop = makeShade();
    const shadeLeft = makeShade();
    const shadeRight = makeShade();
    const shadeBottom = makeShade();

    root.appendChild(shadeTop);
    root.appendChild(shadeLeft);
    root.appendChild(shadeRight);
    root.appendChild(shadeBottom);
    root.appendChild(box);
    document.documentElement.appendChild(root);

    highlightOverlayEl = root;
    highlightOverlayBoxEl = box;
    highlightOverlayShadeTopEl = shadeTop;
    highlightOverlayShadeLeftEl = shadeLeft;
    highlightOverlayShadeRightEl = shadeRight;
    highlightOverlayShadeBottomEl = shadeBottom;
    return root;
  }

  function hideHighlightOverlay() {
    const el = ensureHighlightOverlay();
    el.style.display = 'none';
    if (highlightOverlayBoxEl) {
      highlightOverlayBoxEl.style.left = '-99999px';
      highlightOverlayBoxEl.style.top = '-99999px';
      highlightOverlayBoxEl.style.width = '0px';
      highlightOverlayBoxEl.style.height = '0px';
    }
  }

  function objectInScene(scene, obj) {
    if (!scene || !obj) return false;
    let current = obj;
    let guard = 0;
    while (current && guard < 1024) {
      if (current === scene) return true;
      current = current.parent;
      guard += 1;
    }
    return false;
  }

  function projectPointManual(point, camera, canvasRect) {
    // Fallback projection without needing THREE.Vector3 class
    try {
      const cameraPos = camera.position || { x: 0, y: 0, z: 0 };
      
      // Vector from point to camera
      let dx = point.x - cameraPos.x;
      let dy = point.y - cameraPos.y;
      let dz = point.z - cameraPos.z;
      
      const depth = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (depth <= 0.01) return null;
      
      const fov = (camera.fov || 75) * Math.PI / 360;
      const aspect = canvasRect.width / canvasRect.height;
      const vFOV = 2 * Math.atan(Math.tan(fov) * aspect);
      
      const x = (dx / depth) * Math.tan(fov) / 2;
      const y = (dy / depth) * Math.tan(vFOV) / 2;
      
      return { x, y };
    } catch (e) {
      bboxError('[BBOX DEBUG] Manual projection failed:', e.message);
      return null;
    }
  }

  function makeVector3Like(obj, x, y, z) {
    try {
      if (obj && obj.position && typeof obj.position.clone === 'function') {
        const v = obj.position.clone();
        if (typeof v.set === 'function') {
          v.set(x, y, z);
          return v;
        }
      }
    } catch (_) { }
    return { x, y, z };
  }

  function readSignalValue(signalLike) {
    try {
      if (signalLike == null) return undefined;
      if (typeof signalLike.peek === 'function') return signalLike.peek();
      if (typeof signalLike === 'object' && 'value' in signalLike) return signalLike.value;
    } catch (_) { }
    return undefined;
  }

  function buildUikitWorldCorners(obj) {
    try {
      const sizeValue = readSignalValue(obj && obj.size);
      const panelMatrix = readSignalValue(obj && obj.globalPanelMatrix);
      if (!Array.isArray(sizeValue) || sizeValue.length < 2 || !panelMatrix) {
        return null;
      }

      let rootParentMatrixWorld = null;
      try {
        const rootContext = readSignalValue(obj && obj.root);
        rootParentMatrixWorld = rootContext && rootContext.component && rootContext.component.parent
          ? rootContext.component.parent.matrixWorld
          : null;
      } catch (_) { }

      const corners = [];
      const uikitLocalCorners = [
        [-0.5, -0.5, 0],
        [-0.5, 0.5, 0],
        [0.5, -0.5, 0],
        [0.5, 0.5, 0],
      ];

      for (const c of uikitLocalCorners) {
        const v = makeVector3Like(obj, c[0], c[1], c[2]);
        if (!v || typeof v.applyMatrix4 !== 'function') return null;
        v.applyMatrix4(panelMatrix);
        if (rootParentMatrixWorld && typeof rootParentMatrixWorld === 'object' && rootParentMatrixWorld.elements) {
          v.applyMatrix4(rootParentMatrixWorld);
        }
        corners.push(v);
      }

      return corners;
    } catch (_) {
      return null;
    }
  }

  function getProjectedBboxRect(renderer, camera, obj) {
    try {
      if (!renderer || !renderer.domElement || !camera || !obj) {
        bboxError('[BBOX DEBUG] Missing input:', { renderer: !!renderer, domElement: !!renderer?.domElement, camera: !!camera, obj: !!obj });
        return null;
      }

      const canvasRect = renderer.domElement.getBoundingClientRect();
      if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) {
        bboxError('[BBOX DEBUG] Invalid canvas rect:', canvasRect);
        return null;
      }
      bboxLog('[BBOX DEBUG] Input obj:', { type: obj.type, uuid: obj.uuid, visible: obj.visible });

      let corners = [];

      // UIKit path: use panel matrix computed from Yoga layout + pixel size.
      const uikitCorners = buildUikitWorldCorners(obj);
      if (Array.isArray(uikitCorners) && uikitCorners.length > 0) {
        corners = uikitCorners;
        bboxLog('[BBOX DEBUG] UIKit layout bounds path:', { corners: corners.length });
      }

      // Geometry path for non-UIKit meshes.
      if (corners.length === 0 && obj.geometry) {
        try {
          if (!obj.geometry.boundingBox && typeof obj.geometry.computeBoundingBox === 'function') {
            obj.geometry.computeBoundingBox();
          }
          const bbox = obj.geometry.boundingBox;
          if (bbox && bbox.min && bbox.max) {
            const min = bbox.min;
            const max = bbox.max;
            const localCorners = [
              [min.x, min.y, min.z],
              [min.x, min.y, max.z],
              [min.x, max.y, min.z],
              [min.x, max.y, max.z],
              [max.x, min.y, min.z],
              [max.x, min.y, max.z],
              [max.x, max.y, min.z],
              [max.x, max.y, max.z],
            ];
            for (const c of localCorners) {
              try {
                const v = makeVector3Like(obj, c[0], c[1], c[2]);
                if (typeof obj.localToWorld === 'function') {
                  obj.localToWorld(v);
                }
                corners.push(v);
              } catch (_) { }
            }
          }
        } catch (e) {
          bboxLog('[BBOX DEBUG] Geometry bounds error:', e.message);
        }
      }

      // Last fallback: world-position marker.
      if (corners.length === 0) {
        const marker = makeVector3Like(obj, 0, 0, 0);
        try {
          if (obj.getWorldPosition && typeof obj.getWorldPosition === 'function') {
            obj.getWorldPosition(marker);
          }
        } catch (_) { }
        corners.push(marker);
      }
      bboxLog('[BBOX DEBUG] Corners to project:', corners.length);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let validPointCount = 0;

      for (const corner of corners) {
        try {
          let p;
          // Try Vector3.project() if available
          if (corner && typeof corner.project === 'function') {
            p = corner.project(camera);
          } else {
            // Manual projection: transform to NDC using matrices
            // This is a simplified version - uses camera's built-in projection
            p = projectPointManual(corner, camera, canvasRect);
          }
          
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          
          const x = canvasRect.left + (p.x * 0.5 + 0.5) * canvasRect.width;
          const y = canvasRect.top + (-p.y * 0.5 + 0.5) * canvasRect.height;
          validPointCount += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        } catch (e) {
          bboxLog('[BBOX DEBUG] Failed to project corner:', e.message);
          continue;
        }
      }

      if (validPointCount === 0) {
        bboxError('[BBOX DEBUG] No valid projected points from', corners.length, 'corners');
        return null;
      }
      bboxLog('[BBOX DEBUG] Valid points:', validPointCount, 'min:', { x: minX, y: minY }, 'max:', { x: maxX, y: maxY });

      // Clamp to canvas viewport
      minX = Math.max(canvasRect.left, Math.min(canvasRect.right, minX));
      maxX = Math.max(canvasRect.left, Math.min(canvasRect.right, maxX));
      minY = Math.max(canvasRect.top, Math.min(canvasRect.bottom, minY));
      maxY = Math.max(canvasRect.top, Math.min(canvasRect.bottom, maxY));

      let width = maxX - minX;
      let height = maxY - minY;

      // Point-like fallback -> visible marker box.
      if (width <= 1 || height <= 1) {
        const markerSize = 12;
        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        minX = Math.max(canvasRect.left, centerX - markerSize * 0.5);
        minY = Math.max(canvasRect.top, centerY - markerSize * 0.5);
        width = Math.min(markerSize, canvasRect.right - minX);
        height = Math.min(markerSize, canvasRect.bottom - minY);
      }

      if (width <= 0 || height <= 0) {
        bboxError('[BBOX DEBUG] Invalid rect dimensions:', { width, height });
        return null;
      }

      const rect = { left: minX, top: minY, width, height };
      bboxLog('[BBOX DEBUG] Final rect:', rect);
      return rect;
    } catch (_) {
      return null;
    }
  }

  function resolveSelectedObject(scene) {
    if (!selectedUuid) {
      bboxLog('[BBOX DEBUG] No selectedUuid');
      return null;
    }

    let obj = objectMap.get(selectedUuid) || null;
    if (obj) {
      bboxLog('[BBOX DEBUG] Found object in objectMap:', { type: obj.type, uuid: obj.uuid });
      return obj;
    }
    bboxLog('[BBOX DEBUG] Object not in objectMap, trying scene.getObjectByProperty');

    try {
      if (scene && typeof scene.getObjectByProperty === 'function') {
        obj = scene.getObjectByProperty('uuid', selectedUuid) || null;
        if (obj) bboxLog('[BBOX DEBUG] Found via scene.getObjectByProperty:', { type: obj.type });
        else bboxLog('[BBOX DEBUG] Not found in scene via getObjectByProperty');
      } else {
        bboxLog('[BBOX DEBUG] Scene or getObjectByProperty not available');
      }
    } catch (e) {
      bboxError('[BBOX DEBUG] Error in scene.getObjectByProperty:', e);
      obj = null;
    }

    if (obj) {
      try { objectMap.set(selectedUuid, obj); } catch (_) { }
    }
    return obj;
  }

  function updateSelectionOverlay(renderer, scene, camera) {
    const el = ensureHighlightOverlay();
    if (!selectedUuid) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlay: no selectedUuid, hiding');
      hideHighlightOverlay();
      return;
    }

    const obj = resolveSelectedObject(scene);
    if (!obj) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlay: object not resolved, hiding');
      hideHighlightOverlay();
      return;
    }
    if (!obj.visible) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlay: object not visible, hiding');
      hideHighlightOverlay();
      return;
    }

    // Hide bbox if not a UIKit object
    const uikitCorners = buildUikitWorldCorners(obj);
    if (!uikitCorners) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlay: not a UIKit object, hiding');
      hideHighlightOverlay();
      return;
    }

    // Some engines render wrappers / detached subtrees; don't hard-fail here.
    // Projection below will naturally fail if object is not renderable.

    const rect = getProjectedBboxRect(renderer, camera, obj);
    if (!rect) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlay: no rect from projection, hiding');
      hideHighlightOverlay();
      return;
    }

    bboxLog('[BBOX DEBUG] updateSelectionOverlay: DISPLAYING rect', rect);
    el.style.display = 'block';

    if (highlightOverlayBoxEl) {
      highlightOverlayBoxEl.style.left = rect.left + 'px';
      highlightOverlayBoxEl.style.top = rect.top + 'px';
      highlightOverlayBoxEl.style.width = rect.width + 'px';
      highlightOverlayBoxEl.style.height = rect.height + 'px';
    }

    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(vw, rect.left + rect.width);
    const bottom = Math.min(vh, rect.top + rect.height);

    if (highlightOverlayShadeTopEl) {
      highlightOverlayShadeTopEl.style.left = '0px';
      highlightOverlayShadeTopEl.style.top = '0px';
      highlightOverlayShadeTopEl.style.width = vw + 'px';
      highlightOverlayShadeTopEl.style.height = Math.max(0, top) + 'px';
    }
    if (highlightOverlayShadeLeftEl) {
      highlightOverlayShadeLeftEl.style.left = '0px';
      highlightOverlayShadeLeftEl.style.top = top + 'px';
      highlightOverlayShadeLeftEl.style.width = Math.max(0, left) + 'px';
      highlightOverlayShadeLeftEl.style.height = Math.max(0, bottom - top) + 'px';
    }
    if (highlightOverlayShadeRightEl) {
      highlightOverlayShadeRightEl.style.left = right + 'px';
      highlightOverlayShadeRightEl.style.top = top + 'px';
      highlightOverlayShadeRightEl.style.width = Math.max(0, vw - right) + 'px';
      highlightOverlayShadeRightEl.style.height = Math.max(0, bottom - top) + 'px';
    }
    if (highlightOverlayShadeBottomEl) {
      highlightOverlayShadeBottomEl.style.left = '0px';
      highlightOverlayShadeBottomEl.style.top = bottom + 'px';
      highlightOverlayShadeBottomEl.style.width = vw + 'px';
      highlightOverlayShadeBottomEl.style.height = Math.max(0, vh - bottom) + 'px';
    }
  }

  function requestSelectionOverlayUpdate(renderer, scene, camera, force) {
    if (!renderer || !scene || !camera) return;
    lastOverlayRenderer = renderer;
    lastOverlayScene = scene;
    lastOverlayCamera = camera;

    if (force) {
      lastOverlayUpdateTime = performance.now();
      updateSelectionOverlay(renderer, scene, camera);
      return;
    }

    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(function () {
      overlayQueued = false;
      const now = performance.now();
      if (now - lastOverlayUpdateTime < OVERLAY_MIN_INTERVAL_MS) return;
      lastOverlayUpdateTime = now;
      updateSelectionOverlay(lastOverlayRenderer, lastOverlayScene, lastOverlayCamera);
    });
  }

  function updateSelectionOverlayFromLastContext() {
    if (!lastOverlayRenderer || !lastOverlayScene || !lastOverlayCamera) {
      bboxLog('[BBOX DEBUG] updateSelectionOverlayFromLastContext: missing context:', { renderer: !!lastOverlayRenderer, scene: !!lastOverlayScene, camera: !!lastOverlayCamera });
      return;
    }
    requestSelectionOverlayUpdate(lastOverlayRenderer, lastOverlayScene, lastOverlayCamera, false);
  }

  // All possible UIKit property keys (comprehensive schema)
  const allUikitPropertyKeys = [
    // Layout / Flex
    'positionType', 'positionTop', 'positionLeft', 'positionRight', 'positionBottom',
    'alignContent', 'alignItems', 'alignSelf', 'flexDirection', 'flexWrap', 'justifyContent',
    'marginTop', 'marginLeft', 'marginRight', 'marginBottom',
    'flexBasis', 'flexGrow', 'flexShrink',
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    'boxSizing', 'aspectRatio',
    'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth',
    'overflow', 'display', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
    'gapRow', 'gapColumn', 'direction',
    // Text
    'text', 'value', 'defaultValue', 'placeholder', 'fontSize', 'letterSpacing', 'lineHeight', 'wordBreak', 'verticalAlign', 'textAlign',
    'fontWeight', 'fontFamily', 'caretWidth', 'id',
    // Appearance
    'fill', 'color', 'opacity', 'depthTest', 'renderOrder', 'receiveShadow', 'castShadow',
    'visibility', 'scrollbarWidth', 'updateMatrixWorld',
    // Positioning
    'pixelSize', 'anchorX', 'anchorY',
    // Interaction
    'pointerEvents', 'cursor', 'type', 'disabled', 'autocomplete', 'tabIndex',
    // Media / specialized
    'src', 'content', 'objectFit', 'keepAspectRatio', 'distanceToCamera',
  ];

  function drainEarlyObservedQueue() {
    const queue = window.__UIKitDevtoolsEarlyQueue__;
    if (!Array.isArray(queue) || queue.length === 0) return;
    while (queue.length) {
      pendingObserved.push(queue.shift());
    }
  }

  function safeSerialize(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return {};
    }
  }

  function getTextEditInfo(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const candidates = ['text', 'value', 'content'];
    for (const key of candidates) {
      let value;
      try {
        value = obj[key];
      } catch (_) {
        value = undefined;
      }
      if (typeof value === 'string') {
        return { key, value };
      }
    }
    return null;
  }

  function isUikitObject(obj) {
    try {
      return (
        obj.isObject3D === true &&
        typeof obj.setProperties === 'function' &&
        obj.properties != null &&
        obj.node != null
      );
    } catch (_) {
      return false;
    }
  }

  function serializeUikitValue(value, depth) {
    if (depth > 8) return null;
    if (value == null) return value;

    // Unwrap signal-like wrappers (`{ value: ... }`) so UIKit fields remain readable.
    let current = value;
    for (let i = 0; i < 3; i++) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) break;
      let hasValue = false;
      try {
        hasValue = 'value' in current;
      } catch (_) {
        hasValue = false;
      }
      if (!hasValue) break;

      let next;
      try {
        next = current.value;
      } catch (_) {
        break;
      }
      if (next === current) break;
      current = next;
      if (current == null) break;
    }

    value = current;

    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      return value;
    }

    if (t === 'bigint') {
      return String(value);
    }

    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const v = serializeUikitValue(item, depth + 1);
        if (v !== undefined) out.push(v);
      }
      return out;
    }

    if (t === 'object') {
      try {
        const out = {};
        for (const key of Object.keys(value)) {
          const v = serializeUikitValue(value[key], depth + 1);
          if (v !== undefined) out[key] = v;
        }
        return out;
      } catch (_) {
        return undefined;
      }
    }

    return undefined;
  }

  function getUikitEditableKeys(propertiesObj) {
    try {
      if (!propertiesObj || typeof propertiesObj !== 'object') return [];
      const keys = propertiesObj.propertyKeys;
      if (!Array.isArray(keys)) return [];
      const out = [];
      for (const key of keys) {
        if (typeof key === 'string' && key.length > 0) out.push(key);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  function readUikitValueFromState(propertiesObj, key) {
    try {
      if (!propertiesObj || typeof propertiesObj !== 'object') return undefined;
      const map = propertiesObj.propertyStateMap;
      if (!map || typeof map !== 'object') return undefined;
      const state = map[key];
      if (!state || typeof state !== 'object') return undefined;
      const raw = state.signal;
      return serializeUikitValue(raw, 0);
    } catch (_) {
      return undefined;
    }
  }

  function getUikitSnapshot(obj) {
    try {
      const props = {};
      const explicitKeys = [];

      // obj.properties is a PropertiesImplementation (signals/proxies in some builds).
      try {
        const sourceRecords = [];
        const p = obj.properties;

        const propsValue =
          p != null &&
          typeof p === 'object' &&
          p.value != null &&
          typeof p.value === 'object'
            ? p.value
            : null;

        if (propsValue != null) sourceRecords.push(propsValue);

        if (p && typeof p.toJSON === 'function') {
          try {
            const jsonValue = p.toJSON();
            if (jsonValue && typeof jsonValue === 'object') sourceRecords.push(jsonValue);
          } catch (_) { }
        }

        if (p && typeof p.get === 'function') {
          try {
            const getValue = p.get();
            if (getValue && typeof getValue === 'object') sourceRecords.push(getValue);
          } catch (_) { }
        }

        // Include ALL possible UIKit properties (not just editable keys)
        for (const key of allUikitPropertyKeys) {
          let resolved;
          let isExplicit = false;

          // Try to get from source records
          for (const record of sourceRecords) {
            if (!record || typeof record !== 'object') continue;
            if (!(key in record)) continue;
            isExplicit = true;
            try {
              resolved = serializeUikitValue(record[key], 0);
            } catch (_) {
              resolved = undefined;
            }
            if (resolved !== undefined) break;
          }

          // Try property state map
          if (resolved === undefined) {
            resolved = readUikitValueFromState(p, key);
          }

          // Include property with null for unset values
          props[key] = resolved !== undefined ? resolved : null;
          if (isExplicit) explicitKeys.push(key);
        }
      } catch (_) { }

      // Yoga-computed layout values live on obj.node.yogaNode, not as direct
      // properties. Read them via the computed size/position signals if available.
      const specific = {};
      try {
        const size = obj.size && typeof obj.size.value !== 'undefined' ? obj.size.value : null;
        if (Array.isArray(size) && size.length >= 2) {
          specific.computedWidth = size[0];
          specific.computedHeight = size[1];
        }
      } catch (_) { }

      return { props, specific, explicitKeys };
    } catch (_) {
      return null;
    }
  }

  function getObjectChildren(obj) {
    const out = [];
    const seen = new WeakSet();

    function pushCandidate(candidate) {
      if (!candidate || typeof candidate !== 'object') return;
      if (candidate === obj) return;
      if (candidate.isObject3D !== true) return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      out.push(candidate);
    }

    try {
      if (Array.isArray(obj.children)) {
        for (const child of obj.children) pushCandidate(child);
      }
    } catch (_) { }

    // UIKit/app wrappers sometimes hide Object3D links outside .children.
    const linkKeys = ['child', 'content', 'root', 'container', 'group', 'object3D'];
    for (const key of linkKeys) {
      try {
        const value = obj[key];
        if (Array.isArray(value)) {
          for (const item of value) pushCandidate(item);
        } else {
          pushCandidate(value);
        }
      } catch (_) { }
    }

    return out;
  }

  function buildNode(obj, depth, recursionSeen) {
    if (depth > 256) return null;
    if (!obj || typeof obj !== 'object') return null;
    if (recursionSeen.has(obj)) return null;
    recursionSeen.add(obj);

    let uuid;
    let type;
    let label;
    let visible;
    let renderOrder;
    let constructorName;
    let position;
    let rotation;
    let scale;
    let textInfo = null;

    let isUikit = false;
    let uikitData = null;

    try {
      uuid = obj.uuid;
      if (!uuid) return null;
      type = obj.type || 'Object3D';
      label = obj.name || type;
      visible = !!obj.visible;
      renderOrder = obj.renderOrder || 0;
      constructorName = obj.constructor && obj.constructor.name ? obj.constructor.name : null;
      position = [obj.position.x, obj.position.y, obj.position.z];
      rotation = [obj.rotation.x, obj.rotation.y, obj.rotation.z];
      scale = [obj.scale.x, obj.scale.y, obj.scale.z];
      isUikit = isUikitObject(obj);
      if (isUikit) uikitData = getUikitSnapshot(obj);
      textInfo = getTextEditInfo(obj);
    } catch (_) {
      return null;
    }

    objectMap.set(uuid, obj);

    const children = [];
    const childCandidates = getObjectChildren(obj);
    for (const child of childCandidates) {
      const childNode = buildNode(child, depth + 1, recursionSeen);
      if (childNode) children.push(childNode);
    }

    return {
      uuid,
      type,
      label,
      visible,
      renderOrder,
      constructorName,
      isUikit,
      position,
      rotation,
      scale,
      uikitExplicit: uikitData ? uikitData.explicitKeys : null,
      textKey: textInfo ? textInfo.key : null,
      textValue: textInfo ? textInfo.value : null,
      uikit: uikitData ? uikitData.props : null,
      uikitSpecific: uikitData ? uikitData.specific : null,
      children,
    };
  }

  function buildSnapshot() {
    objectMap.clear();

    const sceneNodes = [];
    const emittedSceneUuids = new Set();
    const emittedSceneRefs = new WeakSet();
    for (const scene of scenes.values()) {
      if (!scene || typeof scene !== 'object') continue;
      if (emittedSceneRefs.has(scene)) continue;
      emittedSceneRefs.add(scene);

      const sceneUuid = scene.uuid;
      if (sceneUuid && emittedSceneUuids.has(sceneUuid)) continue;
      if (sceneUuid) emittedSceneUuids.add(sceneUuid);

      const node = buildNode(scene, 0, new WeakSet());
      if (node) sceneNodes.push(node);
    }

    // Include UIKit/Object3D roots found outside tracked scenes.
    for (const root of orphanRoots.values()) {
      if (!root || typeof root !== 'object') continue;
      if (emittedSceneRefs.has(root)) continue;

      const rootUuid = root.uuid;
      if (rootUuid && emittedSceneUuids.has(rootUuid)) continue;
      if (rootUuid) emittedSceneUuids.add(rootUuid);

      emittedSceneRefs.add(root);
      const node = buildNode(root, 0, new WeakSet());
      if (node) sceneNodes.push(node);
    }

    const flatMap = {};
    for (const [uuid, obj] of objectMap.entries()) {
      try {
        const isUikit = isUikitObject(obj);
        const ui = isUikit ? getUikitSnapshot(obj) : null;
        const textInfo = getTextEditInfo(obj);

        flatMap[uuid] = {
          uuid,
          type: obj.type || 'Object3D',
          label: obj.name || obj.type || 'Object3D',
          visible: !!obj.visible,
          renderOrder: obj.renderOrder || 0,
          constructorName: obj.constructor && obj.constructor.name ? obj.constructor.name : null,
          isUikit,
          userData: safeSerialize(obj.userData),
          position: [obj.position.x, obj.position.y, obj.position.z],
          rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
          scale: [obj.scale.x, obj.scale.y, obj.scale.z],
          uikitExplicit: ui ? ui.explicitKeys : null,
          textKey: textInfo ? textInfo.key : null,
          textValue: textInfo ? textInfo.value : null,
          uikit: ui ? ui.props : null,
          uikitSpecific: ui ? ui.specific : null,
        };
      } catch (_) { }
    }

    return { scenes: sceneNodes, objectMap: flatMap };
  }

  function pushSnapshot() {
    try {
      const snapshot = buildSnapshot();
      window.dispatchEvent(new CustomEvent('__uikit_devtools_snapshot__', { detail: snapshot }));
    } catch (err) {
      console.warn('[UIKitDevTools] snapshot error', err);
    }
  }

  function schedulePush() {
    dirty = true;
    if (pushTimer !== null) return;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      if (!dirty) return;
      dirty = false;
      pushSnapshot();
    }, 100);
  }

  function patchMethod(proto, methodName) {
    const original = proto[methodName];
    if (typeof original !== 'function') return;
    if (original[PATCH_SYMBOL]) return;

    function wrapped() {
      const result = original.apply(this, arguments);
      schedulePush();
      return result;
    }

    wrapped[PATCH_SYMBOL] = true;
    proto[methodName] = wrapped;
  }

  function patchObject3DPrototypeFrom(instance) {
    try {
      let proto = Object.getPrototypeOf(instance);
      while (proto && proto !== Object.prototype) {
        if (!proto[PATCH_SYMBOL] && typeof proto.add === 'function' && typeof proto.remove === 'function') {
          patchMethod(proto, 'add');
          patchMethod(proto, 'remove');
          patchMethod(proto, 'attach');
          patchMethod(proto, 'clear');
          proto[PATCH_SYMBOL] = true;
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }
    } catch (_) { }
  }

  function trackScene(scene) {
    if (!scene || typeof scene !== 'object' || !scene.uuid) return;
    if (sceneRefs.has(scene)) return;
    if (scenes.has(scene.uuid)) {
      sceneRefs.add(scene);
      return;
    }
    sceneRefs.add(scene);
    scenes.set(scene.uuid, scene);
    patchObject3DPrototypeFrom(scene);
    schedulePush();
  }

  function findSceneRoot(obj) {
    let current = obj;
    let guard = 0;
    while (current && guard < 512) {
      if (current.isScene === true) return current;
      current = current.parent;
      guard += 1;
    }
    return null;
  }

  function trackOrphanRoot(obj) {
    if (!obj || typeof obj !== 'object' || !obj.uuid) return;
    if (orphanRefs.has(obj)) return;
    orphanRefs.add(obj);
    if (!orphanRoots.has(obj.uuid)) {
      orphanRoots.set(obj.uuid, obj);
      schedulePush();
    }
  }

  function trackCandidateObject(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.isScene === true) {
      trackScene(obj);
      return;
    }

    if (obj.isObject3D === true) {
      const scene = findSceneRoot(obj);
      if (scene) {
        trackScene(scene);
      } else if (isUikitObject(obj)) {
        trackOrphanRoot(obj);
      }
    }

    if (typeof obj.render === 'function') {
      interceptRenderer(obj);
    }
  }

  function interceptRenderer(renderer) {
    if (!renderer || renderer[RENDER_PATCH_SYMBOL]) return;
    const originalRender = renderer.render;
    if (typeof originalRender !== 'function') return;

    renderer[RENDER_PATCH_SYMBOL] = true;
    renderer.render = function (scene, camera) {
      if (scene && scene.isScene) {
        trackScene(scene);
      }
      const result = originalRender.apply(this, arguments);
      if (scene && scene.isScene && camera) {
        requestSelectionOverlayUpdate(renderer, scene, camera, false);
      }
      return result;
    };
  }

  function handleObservedObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.isScene) {
      trackScene(obj);
      return;
    }
    if (typeof obj.render === 'function') {
      interceptRenderer(obj);
      return;
    }
    if (obj.object && typeof obj.object === 'object') {
      handleObservedObject(obj.object);
    }
  }

  function flushPendingObserved() {
    while (pendingObserved.length) {
      const obj = pendingObserved.shift();
      handleObservedObject(obj);
    }
  }

  (function installDevtoolsBridgeEarly() {
    let internal = window.__THREE_DEVTOOLS__;

    function recreateDevtoolsBridge(target) {
      if (!target || typeof target !== 'object') {
        const listeners = new Map();
        return {
          __uikit_recreated_devtools__: true,
          __uikit_devtools_shim__: true,
          addEventListener(type, listener) {
            if (typeof listener !== 'function') return;
            let list = listeners.get(type);
            if (!list) {
              list = new Set();
              listeners.set(type, list);
            }
            list.add(listener);
          },
          removeEventListener(type, listener) {
            const list = listeners.get(type);
            if (list) list.delete(listener);
          },
          dispatchEvent(event) {
            const detail = event ? event.detail : null;
            pendingObserved.push(detail && detail.object ? detail.object : detail);
            flushPendingObserved();
            const type = event && event.type;
            const list = listeners.get(type);
            if (!list) return true;
            list.forEach(function (fn) {
              try { fn(event); } catch (_) { }
            });
            return true;
          }
        };
      }
      if (target.__uikit_recreated_devtools__) return target;

      const originalDispatch = typeof target.dispatchEvent === 'function'
        ? target.dispatchEvent.bind(target)
        : null;
      const originalAdd = typeof target.addEventListener === 'function'
        ? target.addEventListener.bind(target)
        : null;
      const originalRemove = typeof target.removeEventListener === 'function'
        ? target.removeEventListener.bind(target)
        : null;

      const recreated = {
        __uikit_recreated_devtools__: true,
        addEventListener(type, listener, options) {
          if (originalAdd) originalAdd(type, listener, options);
        },
        removeEventListener(type, listener, options) {
          if (originalRemove) originalRemove(type, listener, options);
        },
        dispatchEvent(event) {
          const detail = event ? event.detail : null;
          pendingObserved.push(detail && detail.object ? detail.object : detail);
          flushPendingObserved();
          if (originalDispatch) return originalDispatch(event);
          return true;
        }
      };

      return recreated;
    }

    function tryAttachObserveListener(target) {
      if (!target || typeof target.addEventListener !== 'function') return;
      if (target.__uikit_observe_listener__) return;
      target.__uikit_observe_listener__ = true;
      target.addEventListener('observe', function (event) {
        pendingObserved.push(event ? event.detail : null);
        flushPendingObserved();
      });
    }

    internal = recreateDevtoolsBridge(internal);
    try {
      if (!window.__THREE_DEVTOOLS__) window.__THREE_DEVTOOLS__ = internal;
    } catch (_) { }

    try {
      Object.defineProperty(window, '__THREE_DEVTOOLS__', {
        configurable: true,
        get() {
          return internal;
        },
        set(v) {
          internal = recreateDevtoolsBridge(v);
          tryAttachObserveListener(v);
          tryAttachObserveListener(internal);
        }
      });

      internal = recreateDevtoolsBridge(internal);
      window.__THREE_DEVTOOLS__ = internal;
    } catch (_) {
      // Non-configurable property on some pages. Poll and attach when available.
      let attempts = 0;
      const timer = setInterval(function () {
        attempts += 1;
        try {
          const current = recreateDevtoolsBridge(window.__THREE_DEVTOOLS__);
          tryAttachObserveListener(current);
        } catch (_) { }
        if (attempts > 200) clearInterval(timer);
      }, 50);
    }

    tryAttachObserveListener(internal);
  })();

  function patchRendererPrototype(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const proto = Ctor.prototype;
    const originalRender = proto.render;
    if (typeof originalRender !== 'function') return;
    if (originalRender[RENDER_PATCH_SYMBOL]) return;

    function patchedRender(scene, camera) {
      if (scene && scene.isScene) {
        trackScene(scene);
      }
      const result = originalRender.apply(this, arguments);
      if (scene && scene.isScene && camera) {
        requestSelectionOverlayUpdate(this, scene, camera, false);
      }
      return result;
    }

    patchedRender[RENDER_PATCH_SYMBOL] = true;
    proto.render = patchedRender;
  }

  function patchThreeRendererPrototypes() {
    const THREE = window.THREE;
    if (!THREE || typeof THREE !== 'object') return false;
    capturedTHREE = THREE;
    bboxLog('[BBOX DEBUG] Captured THREE:', !!THREE);
    patchRendererPrototype(THREE.WebGLRenderer);
    patchRendererPrototype(THREE.WebGPURenderer);
    return true;
  }

  window.addEventListener('__THREE_DEVTOOLS__', function (event) {
    const detail = event ? event.detail : null;
    if (!detail) return;
    pendingObserved.push(detail.object || detail);
    flushPendingObserved();
  });

  const SKIP_GLOBALS = new Set([
    'window', 'self', 'top', 'parent', 'frames', 'document', 'location',
    'history', 'navigator', 'screen', 'performance', 'console', 'crypto',
    'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'origin',
    'devicePixelRatio', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY',
  ]);

  function scanGlobals() {
    let keys;
    try {
      keys = Object.keys(window);
    } catch (_) {
      return;
    }

    for (const key of keys) {
      if (SKIP_GLOBALS.has(key)) continue;
      try {
        const value = window[key];
        if (!value || typeof value !== 'object') continue;

        trackCandidateObject(value);

        const scene = value.scene || value._scene;
        trackCandidateObject(scene);

        const renderer = value.renderer || value._renderer;
        trackCandidateObject(renderer);

        // Common wrappers used by UI kits and app state objects.
        trackCandidateObject(value.object3D);
        trackCandidateObject(value.root);
        trackCandidateObject(value.group);
        trackCandidateObject(value.container);
      } catch (_) { }
    }
  }

  function scanReachable(root) {
    if (!root || (typeof root !== 'object' && typeof root !== 'function')) return;

    const visited = new WeakSet();
    const queue = [{ value: root, depth: 0 }];
    let processed = 0;

    while (queue.length && processed < 6000) {
      const entry = queue.shift();
      const value = entry.value;
      const depth = entry.depth;

      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (visited.has(value)) continue;
      visited.add(value);
      processed += 1;

      trackCandidateObject(value);
      if (depth >= 5) continue;

      try {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length && i < 32; i++) {
            queue.push({ value: value[i], depth: depth + 1 });
          }
          continue;
        }

        if (value instanceof Map) {
          let i = 0;
          for (const v of value.values()) {
            queue.push({ value: v, depth: depth + 1 });
            i += 1;
            if (i >= 32) break;
          }
          continue;
        }

        if (value instanceof Set) {
          let i = 0;
          for (const v of value.values()) {
            queue.push({ value: v, depth: depth + 1 });
            i += 1;
            if (i >= 32) break;
          }
          continue;
        }

        const keys = Object.keys(value);
        for (let i = 0; i < keys.length && i < 32; i++) {
          const key = keys[i];
          queue.push({ value: value[key], depth: depth + 1 });
        }
      } catch (_) { }
    }
  }

  function objectSignature(obj) {
    try {
      const p = obj.position;
      const r = obj.rotation;
      const s = obj.scale;
      return [
        obj.visible ? '1' : '0',
        p.x.toFixed(4), p.y.toFixed(4), p.z.toFixed(4),
        r.x.toFixed(4), r.y.toFixed(4), r.z.toFixed(4),
        s.x.toFixed(4), s.y.toFixed(4), s.z.toFixed(4),
      ].join('|');
    } catch (_) {
      return '';
    }
  }

  function checkTransformDirty() {
    let changed = false;

    if (selectedUuid && !objectMap.has(selectedUuid)) {
      selectedUuid = null;
      hideHighlightOverlay();
    }

    if (objectMap.size > 200) {
      const obj = selectedUuid ? objectMap.get(selectedUuid) : null;
      if (obj && selectedUuid) {
        try {
          const sig = objectSignature(obj);
          if (signatures.get(selectedUuid) !== sig) {
            signatures.set(selectedUuid, sig);
            changed = true;
          }
        } catch (_) { }
      }
    } else {
      for (const [uuid, obj] of objectMap.entries()) {
        try {
          const sig = objectSignature(obj);
          if (signatures.get(uuid) !== sig) {
            signatures.set(uuid, sig);
            changed = true;
          }
        } catch (_) { }
      }
    }

    if (changed) schedulePush();

    // Keep selection overlay alive even when scene render is static.
    if (selectedUuid) {
      updateSelectionOverlayFromLastContext();
    }
  }

  setInterval(checkTransformDirty, 800);

  drainEarlyObservedQueue();
  flushPendingObserved();

  patchThreeRendererPrototypes();
  let threePatchAttempts = 0;
  const threePatchTimer = setInterval(function () {
    threePatchAttempts += 1;
    const ok = patchThreeRendererPrototypes();
    if (ok || threePatchAttempts > 200) {
      clearInterval(threePatchTimer);
    }
  }, 50);

  scanGlobals();
  scanReachable(window);
  setTimeout(scanGlobals, 0);
  setTimeout(function () { scanReachable(window); }, 0);
  setTimeout(scanGlobals, 250);
  setTimeout(function () { scanReachable(window); }, 250);
  setTimeout(scanGlobals, 1000);
  setTimeout(function () { scanReachable(window); }, 1000);
  setTimeout(scanGlobals, 3000);
  setTimeout(function () { scanReachable(window); }, 3000);

  (function installNavigationSignals() {
    function emitNavigation(reason) {
      selectedUuid = null;
      hideHighlightOverlay();
      try {
        window.dispatchEvent(new CustomEvent('__uikit_devtools_navigation__', {
          detail: { reason: reason || 'unknown' }
        }));
      } catch (_) { }
      schedulePush();
    }

    try {
      const rawPushState = history.pushState;
      if (typeof rawPushState === 'function' && !rawPushState.__uikitPatched__) {
        const patchedPushState = function () {
          const result = rawPushState.apply(this, arguments);
          emitNavigation('pushState');
          return result;
        };
        patchedPushState.__uikitPatched__ = true;
        history.pushState = patchedPushState;
      }
    } catch (_) { }

    try {
      const rawReplaceState = history.replaceState;
      if (typeof rawReplaceState === 'function' && !rawReplaceState.__uikitPatched__) {
        const patchedReplaceState = function () {
          const result = rawReplaceState.apply(this, arguments);
          emitNavigation('replaceState');
          return result;
        };
        patchedReplaceState.__uikitPatched__ = true;
        history.replaceState = patchedReplaceState;
      }
    } catch (_) { }

    window.addEventListener('popstate', function () { emitNavigation('popstate'); });
    window.addEventListener('hashchange', function () { emitNavigation('hashchange'); });
    window.addEventListener('pageshow', function () { emitNavigation('pageshow'); });
  })();

  const HOOK = {
    getSnapshot() {
      return buildSnapshot();
    },

    selectObject(uuid) {
      bboxLog('[BBOX DEBUG] selectObject called with uuid:', uuid);
      selectedUuid = uuid || null;
      bboxLog('[BBOX DEBUG] selectedUuid set to:', selectedUuid);
      if (!selectedUuid) {
        bboxLog('[BBOX DEBUG] No selectedUuid, hiding overlay');
        hideHighlightOverlay();
      }
      if (selectedUuid) {
        // Try immediate overlay refresh (works for static scenes after selection).
        bboxLog('[BBOX DEBUG] selectedUuid exists, attempting immediate overlay refresh');
        if (lastOverlayRenderer && lastOverlayScene && lastOverlayCamera) {
          requestSelectionOverlayUpdate(lastOverlayRenderer, lastOverlayScene, lastOverlayCamera, true);
        }
      }
      return !!selectedUuid;
    },

    printObject(uuid) {
      const obj = objectMap.get(uuid);
      if (obj) {
        console.log('[UIKitDevTools]', obj.type || 'Object3D', obj);
      }
    },

    setProperty(uuid, path, value) {
      const obj = objectMap.get(uuid);
      if (!obj) return false;
      try {
        const parts = path.split('.');
        let target = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          target = target[parts[i]];
          if (target == null) return false;
        }
        target[parts[parts.length - 1]] = value;
        if (parts.length === 1 && parts[0] === 'text' && typeof obj.sync === 'function') {
          try {
            obj.sync();
          } catch (_) { }
        }
        schedulePush();
        return true;
      } catch (_) {
        return false;
      }
    },

    setUikitProperties(uuid, propsObj) {
      const obj = objectMap.get(uuid);
      if (!obj || typeof obj.setProperties !== 'function') return false;
      try {
        obj.setProperties(propsObj);
        schedulePush();
        return true;
      } catch (_) {
        return false;
      }
    },

    requestSnapshot() {
      pushSnapshot();
    }
  };

  window.__UIKitDevTools = HOOK;
  flushPendingObserved();
  window.dispatchEvent(new CustomEvent('__uikit_devtools_ready__'));
})();
