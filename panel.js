// panel.js — Runs inside the DevTools panel window (panel.html).

'use strict';

let snapshot = null;
let selectedUuid = null;
const expanded = new Set();
let filterText = '';
let showUikitPathOnly = true;
let contextMenuUuid = null;
let lastTreeSignature = '';
let lastDetailsSignature = '';
let lastDetailsUuid = null;
const collapsedDetailsSections = new Set();
const collapsedUikitCategories = new Set();
const initializedSectionDefaults = new Set();



let port = null;

function connectToBackground() {
  try {
    port = chrome.runtime.connect({ name: 'devtools-panel' });
  } catch (_) {
    return;
  }

  port.postMessage({ type: 'init', tabId: chrome.devtools.inspectedWindow.tabId });
  port.onMessage.addListener(onBackgroundMessage);

  port.onDisconnect.addListener(function () {
    port = null;
    setConnected(false);
    setTimeout(connectToBackground, 1500);
  });
}

function onBackgroundMessage(msg) {
  switch (msg.type) {
    case 'content-ready':
      setConnected(true);
      evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
      break;

    case 'snapshot':
      handleSnapshot(msg.data);
      break;

    case 'ready':
      setConnected(true);
      evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
      break;

    case 'disconnected':
      setConnected(false);
      break;

    case 'page-navigation':
      handlePageNavigated(msg.reason || 'page-navigation');
      break;
  }
}

connectToBackground();

if (chrome.devtools && chrome.devtools.network && chrome.devtools.network.onNavigated) {
  chrome.devtools.network.onNavigated.addListener(function () {
    handlePageNavigated('devtools-network');
  });
}

function evalHook(expr, cb) {
  try {
    chrome.devtools.inspectedWindow.eval(expr, function (result, isException) {
      if (cb) cb(result, isException);
    });
  } catch (_) { }
}

function toLiteral(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}

function handleSnapshot(data) {
  if (!data) return;
  snapshot = data;

  const nextTreeSignature = buildTreeSignature(data);
  const selectedObj = selectedUuid && snapshot.objectMap ? snapshot.objectMap[selectedUuid] : null;
  const nextDetailsSignature = selectedObj ? buildDetailsSignature(selectedObj) : '';

  if (isEditingDetails()) {
    return;
  }

  if (contextMenuUuid && (!snapshot.objectMap || !snapshot.objectMap[contextMenuUuid])) {
    hideContextMenu();
  }

  if (nextTreeSignature !== lastTreeSignature) {
    renderTree();
    lastTreeSignature = nextTreeSignature;
  }

  if (selectedObj) {
    if (lastDetailsUuid !== selectedUuid || nextDetailsSignature !== lastDetailsSignature) {
      renderDetails(selectedObj);
      lastDetailsUuid = selectedUuid;
      lastDetailsSignature = nextDetailsSignature;
    }
  } else if (selectedUuid) {
    clearDetails();
    lastDetailsUuid = null;
    lastDetailsSignature = '';
  }
}

function handlePageNavigated(_reason) {
  snapshot = null;
  selectedUuid = null;
  lastTreeSignature = '';
  lastDetailsSignature = '';
  lastDetailsUuid = null;
  hideContextMenu();
  clearDetails();
  renderTree();

  setTimeout(function () {
    evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
  }, 50);
  setTimeout(function () {
    evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
  }, 300);
  setTimeout(function () {
    evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
  }, 1000);
}

const elSearch = document.getElementById('search');
const elBtnRefresh = document.getElementById('btn-refresh');
const elBtnUikitOnly = document.getElementById('btn-uikit-only');
const elBtnExpand = document.getElementById('btn-expand');
const elBtnCollapse = document.getElementById('btn-collapse');
const elStatusDot = document.getElementById('status-dot');
const elTreeContextMenu = document.getElementById('tree-context-menu');
const elCtxPrint = document.getElementById('ctx-print');

elSearch.addEventListener('input', function () {
  filterText = elSearch.value.trim().toLowerCase();
  renderTree();
});

elBtnRefresh.addEventListener('click', function () {
  evalHook('window.__UIKitDevTools ? window.__UIKitDevTools.getSnapshot() : null', function (result) {
    if (result) handleSnapshot(result);
  });
  evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
});

elBtnUikitOnly.addEventListener('click', function () {
  showUikitPathOnly = !showUikitPathOnly;
  elBtnUikitOnly.classList.toggle('active', showUikitPathOnly);
  renderTree();
});

elBtnExpand.addEventListener('click', function () {
  if (!snapshot) return;
  expandAll(snapshot.scenes);
  renderTree();
});

elBtnCollapse.addEventListener('click', function () {
  expanded.clear();
  renderTree();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    deselectObject();
  }
});



function setConnected(ok) {
  elStatusDot.classList.toggle('connected', ok);
  elStatusDot.title = ok ? 'Hook connected' : 'Hook not detected';
}

function expandAll(nodes) {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.children && node.children.length) {
      expanded.add(node.uuid);
      expandAll(node.children);
    }
  }
}

const elTreeRoot = document.getElementById('tree-root');

function getHierarchyLabel(node) {
  const name = node.label || node.type || 'Object3D';
  const ctor = node.constructorName || node.type || '';
  if (!ctor || ctor === name) return name;
  return name + ' (' + ctor + ')';
}

function nodeMatchesFilter(text, node) {
  if (!text) return true;
  if (node.label.toLowerCase().includes(text)) return true;
  if ((node.constructorName || '').toLowerCase().includes(text)) return true;
  if (node.type.toLowerCase().includes(text)) return true;
  if (node.uuid.toLowerCase().includes(text)) return true;
  return false;
}

function subtreeMatchesFilter(text, node) {
  if (nodeMatchesFilter(text, node)) return true;
  if (node.children) {
    for (const child of node.children) {
      if (subtreeMatchesFilter(text, child)) return true;
    }
  }
  return false;
}

function subtreeContainsUikit(node) {
  if (node.isUikit) return true;
  if (!node.children) return false;
  for (const child of node.children) {
    if (subtreeContainsUikit(child)) return true;
  }
  return false;
}

function shouldRenderNode(node) {
  if (showUikitPathOnly && !subtreeContainsUikit(node)) return false;
  if (filterText && !subtreeMatchesFilter(filterText, node)) return false;
  return true;
}

function buildNodeSignature(node) {
  let sig =
    node.uuid + '|' +
    (node.label || '') + '|' +
    (node.type || '') + '|' +
    (node.constructorName || '') + '|' +
    (node.visible ? '1' : '0') + '|' +
    (node.isUikit ? '1' : '0');

  if (Array.isArray(node.children) && node.children.length > 0) {
    for (const child of node.children) {
      sig += '>' + buildNodeSignature(child);
    }
  }
  return sig;
}

function buildTreeSignature(data) {
  if (!data || !Array.isArray(data.scenes)) return 'empty';
  let sig = 'scenes:' + data.scenes.length;
  for (const scene of data.scenes) {
    sig += ';' + buildNodeSignature(scene);
  }
  return sig;
}

function buildDetailsSignature(obj) {
  if (!obj) return '';
  return JSON.stringify({
    uuid: obj.uuid,
    label: obj.label,
    visible: obj.visible,
    renderOrder: obj.renderOrder,
    position: obj.position,
    rotation: obj.rotation,
    scale: obj.scale,
    uikitExplicit: obj.uikitExplicit,
    textKey: obj.textKey,
    textValue: obj.textValue,
    uikit: obj.uikit,
    uikitSpecific: obj.uikitSpecific,
  });
}

function renderTree() {
  elTreeRoot.innerHTML = '';
  if (!snapshot || !snapshot.scenes.length) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 8px;color:var(--text-dim);text-align:center';
    msg.textContent = snapshot ? 'No scenes detected.' : 'Waiting for page…';
    elTreeRoot.appendChild(msg);
    return;
  }

  const frag = document.createDocumentFragment();
  let renderedCount = 0;
  for (const scene of snapshot.scenes) {
    if (!shouldRenderNode(scene)) continue;
    renderNode(scene, 0, frag);
    renderedCount += 1;
  }

  if (renderedCount === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 8px;color:var(--text-dim);text-align:center';
    msg.textContent = showUikitPathOnly
      ? 'No UIKit objects match the current filters.'
      : 'No objects match the current filters.';
    elTreeRoot.appendChild(msg);
    return;
  }

  elTreeRoot.appendChild(frag);
}

function renderNode(node, depth, container) {
  if (!shouldRenderNode(node)) return;

  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expanded.has(node.uuid);
  const isSelected = node.uuid === selectedUuid;
  const isScene = node.type === 'Scene';

  const row = document.createElement('div');
  row.className = 'tree-node' + (isSelected ? ' selected' : '');
  row.dataset.uuid = node.uuid;

  const indent = document.createElement('span');
  indent.style.cssText = 'display:inline-block;width:' + (depth * 14) + 'px;flex-shrink:0';
  row.appendChild(indent);

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (hasChildren ? '' : ' leaf');
  toggle.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : ' ';
  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isExpanded) expanded.delete(node.uuid);
    else expanded.add(node.uuid);
    renderTree();
  });
  row.appendChild(toggle);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = getHierarchyLabel(node);
  row.appendChild(label);

  if (isScene) row.appendChild(makeTag('scene', 'tag-scene'));
  if (node.isUikit) row.appendChild(makeTag('uikit', 'tag-uikit'));
  if (!node.visible) row.appendChild(makeTag('hidden', 'tag-hidden'));

  row.addEventListener('click', function () {
    hideContextMenu();
    selectObject(node.uuid);
  });

  row.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    selectObject(node.uuid);
    showContextMenu(e.clientX, e.clientY, node.uuid);
  });

  container.appendChild(row);

  if (hasChildren && isExpanded) {
    for (const child of node.children) {
      if (shouldRenderNode(child) && filterText && subtreeMatchesFilter(filterText, child)) {
        expanded.add(node.uuid);
      }
      renderNode(child, depth + 1, container);
    }
  }
}

function makeTag(text, cls) {
  const span = document.createElement('span');
  span.className = 'tag ' + cls;
  span.textContent = text;
  return span;
}

function selectObject(uuid) {
  selectedUuid = uuid;
  renderTree();

  evalHook('window.__UIKitDevTools && window.__UIKitDevTools.selectObject(' + JSON.stringify(uuid) + ')');

  const obj = snapshot && snapshot.objectMap[uuid];
  if (obj) renderDetails(obj);
}

function deselectObject() {
  if (!selectedUuid) return;
  selectedUuid = null;
  renderTree();
  clearDetails();
}

function showContextMenu(x, y, uuid) {
  contextMenuUuid = uuid;

  const menu = elTreeContextMenu;
  menu.style.display = 'block';

  const margin = 4;
  const menuWidth = menu.offsetWidth || 160;
  const menuHeight = menu.offsetHeight || 34;

  const maxX = window.innerWidth - menuWidth - margin;
  const maxY = window.innerHeight - menuHeight - margin;

  const clampedX = Math.max(margin, Math.min(x, maxX));
  const clampedY = Math.max(margin, Math.min(y, maxY));

  menu.style.left = clampedX + 'px';
  menu.style.top = clampedY + 'px';
}

function hideContextMenu() {
  contextMenuUuid = null;
  elTreeContextMenu.style.display = 'none';
}

elCtxPrint.addEventListener('click', function () {
  if (!contextMenuUuid) return;
  evalHook('window.__UIKitDevTools && window.__UIKitDevTools.printObject(' + JSON.stringify(contextMenuUuid) + ')');
  hideContextMenu();
});

document.addEventListener('click', function (event) {
  if (elTreeContextMenu.style.display !== 'block') return;
  if (elTreeContextMenu.contains(event.target)) return;
  hideContextMenu();
});

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    hideContextMenu();
    deselectObject();
  }
});

document.getElementById('tree-scroll').addEventListener('scroll', hideContextMenu);

const elDetailsEmpty = document.getElementById('details-empty');
const elDetailsContent = document.getElementById('details-content');

const uikitPropertyEnums = {
  visibility: ['visible', 'hidden'],
  display: ['flex', 'none', 'contents'],
  positionType: ['static', 'relative', 'absolute'],
  flexDirection: ['row', 'row-reverse', 'column', 'column-reverse'],
  flexWrap: ['no-wrap', 'wrap', 'wrap-reverse'],
  justifyContent: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  alignItems: ['auto', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline', 'space-between', 'space-around', 'space-evenly'],
  alignContent: ['auto', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline', 'space-between', 'space-around', 'space-evenly'],
  alignSelf: ['auto', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline', 'space-between', 'space-around', 'space-evenly'],
  textAlign: ['left', 'center', 'right'],
  verticalAlign: ['top', 'middle', 'bottom'],
  fontWeight: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
  wordBreak: ['normal', 'break-word', 'break-all', 'keep-all'],
  overflow: ['visible', 'hidden', 'scroll'],
  pointerEvents: ['auto', 'none', 'listener'],
  cursor: ['auto', 'default', 'pointer', 'text', 'wait', 'move', 'help', 'not-allowed', 'grab', 'grabbing'],
  anchorX: ['left', 'center', 'right'],
  anchorY: ['top', 'middle', 'bottom'],
  type: ['text', 'password', 'number'],
  objectFit: ['cover', 'fill'],
};

const uikitPropertyCategories = {
  'Layout': ['display', 'flexDirection', 'flexWrap', 'flexBasis', 'flexGrow', 'flexShrink', 'justifyContent', 'alignItems', 'alignContent', 'alignSelf', 'positionType', 'direction'],
  'Spacing': ['marginTop', 'marginLeft', 'marginRight', 'marginBottom', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'gapRow', 'gapColumn'],
  'Size': ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'boxSizing', 'aspectRatio'],
  'Position': ['positionTop', 'positionLeft', 'positionRight', 'positionBottom', 'pixelSize', 'anchorX', 'anchorY'],
  'Border': ['borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth'],
  'Text': ['text', 'value', 'defaultValue', 'placeholder', 'fontSize', 'letterSpacing', 'lineHeight', 'wordBreak', 'verticalAlign', 'textAlign', 'fontWeight', 'fontFamily', 'caretWidth'],
  'Appearance': ['fill', 'color', 'opacity', 'visibility', 'renderOrder', 'depthTest', 'receiveShadow', 'castShadow', 'scrollbarWidth'],
  'Input': ['type', 'disabled', 'autocomplete', 'tabIndex'],
  'Media': ['src', 'content', 'objectFit', 'keepAspectRatio', 'distanceToCamera'],
  'Interaction': ['pointerEvents', 'cursor', 'overflow'],
  'Other': ['updateMatrixWorld', 'id'],
};

const textOnlyUikitProps = new Set(['text']);
const inputOnlyUikitProps = new Set(['value', 'defaultValue', 'placeholder', 'type', 'disabled', 'autocomplete', 'tabIndex']);

function getCtorName(obj) {
  return String(obj && obj.constructorName ? obj.constructorName : '').toLowerCase();
}

function shouldIncludeUikitPropertyForObject(obj, key) {
  const ctor = getCtorName(obj);
  if (ctor === 'text') {
    return !inputOnlyUikitProps.has(key);
  }

  if (ctor === 'input' || ctor === 'textarea') {
    // Input/Textarea content flows through value/placeholder; hide raw text signal.
    if (textOnlyUikitProps.has(key)) return false;
    return true;
  }

  // Non text-like components should not show text/input-content fields by default.
  if (textOnlyUikitProps.has(key) || inputOnlyUikitProps.has(key)) {
    return false;
  }

  return true;
}

const uikitFlexProps = new Set([
  'flexDirection', 'flexWrap', 'flexBasis', 'flexGrow', 'flexShrink',
  'justifyContent', 'alignItems', 'alignContent', 'alignSelf', 'gapRow', 'gapColumn'
]);

const uikitAbsolutePositionProps = new Set([
  'positionTop', 'positionLeft', 'positionRight', 'positionBottom', 'anchorX', 'anchorY'
]);

const uikitPropertyDefaults = {
  display: 'flex',
  positionType: 'relative',
  flexDirection: 'column',
  flexWrap: 'no-wrap',
  justifyContent: 'flex-start',
  alignItems: 'stretch',
  alignContent: 'stretch',
  alignSelf: 'auto',
  visibility: 'visible',
  opacity: 1,
  textAlign: 'left',
  fontWeight: 'normal',
  wordBreak: 'normal',
  overflow: 'visible',
  pointerEvents: 'auto',
  cursor: 'default',
  anchorX: 'center',
  anchorY: 'middle',
  renderOrder: 0,
  depthTest: true,
  receiveShadow: false,
  castShadow: false,
  updateMatrixWorld: true,
  flexGrow: 0,
  flexShrink: 1,
  borderTopWidth: 0,
  borderLeftWidth: 0,
  borderRightWidth: 0,
  borderBottomWidth: 0,
  marginTop: 0,
  marginLeft: 0,
  marginRight: 0,
  marginBottom: 0,
  paddingTop: 0,
  paddingLeft: 0,
  paddingRight: 0,
  paddingBottom: 0,
  gapRow: 0,
  gapColumn: 0,
  disabled: false,
  type: 'text',
  autocomplete: '',
  tabIndex: 0,
  text: '',
  value: '',
  defaultValue: '',
  placeholder: '',
  src: '',
  content: '',
  objectFit: 'fill',
  keepAspectRatio: true,
  distanceToCamera: null,
};

const componentContentEditors = {
  text: [{ key: 'text', label: 'text' }],
  input: [{ key: 'value', label: 'value' }, { key: 'placeholder', label: 'placeholder' }],
  textarea: [{ key: 'value', label: 'value' }, { key: 'placeholder', label: 'placeholder' }],
  image: [{ key: 'src', label: 'image' }],
  video: [{ key: 'src', label: 'video' }],
  svg: [{ key: 'src', label: 'src' }, { key: 'content', label: 'content' }],
  fullscreen: [{ key: 'distanceToCamera', label: 'distanceToCamera' }],
};

function getComponentContentEditors(obj) {
  return componentContentEditors[getCtorName(obj)] || [];
}

function getObjectEditableValue(obj, key) {
  if (obj && obj.isUikit && obj.uikit && Object.prototype.hasOwnProperty.call(obj.uikit, key)) {
    const value = getEffectiveUikitValue(obj.uikit, key);
    return value == null ? '' : value;
  }
  if (obj && key === 'text' && typeof obj.textValue === 'string') {
    return obj.textValue;
  }
  return '';
}

function applyObjectEditValue(obj, key, value) {
  if (obj && obj.isUikit && obj.uikit) {
    evalUikitPropUpdate(obj.uuid, key, value);
    return;
  }
  const path = key === 'text' ? (obj.textKey || 'text') : key;
  evalCmd(obj.uuid, path, value);
}

function hasMeaningfulUikitValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function getUikitDefaultValue(key) {
  return Object.prototype.hasOwnProperty.call(uikitPropertyDefaults, key)
    ? uikitPropertyDefaults[key]
    : null;
}

function getEffectiveUikitValue(props, key) {
  const value = props[key];
  return hasMeaningfulUikitValue(value) ? value : getUikitDefaultValue(key);
}

function shouldShowUikitProperty(props, key) {
  const value = props[key];
  if (hasMeaningfulUikitValue(value)) return true;

  const display = getEffectiveUikitValue(props, 'display');
  const positionType = getEffectiveUikitValue(props, 'positionType');
  const overflow = getEffectiveUikitValue(props, 'overflow');
  const flexWrap = getEffectiveUikitValue(props, 'flexWrap');

  if (display === 'none') {
    return key === 'display' || key === 'visibility' || key === 'id';
  }

  if (uikitFlexProps.has(key) && display !== 'flex') {
    return false;
  }

  if (key === 'alignContent' && (display !== 'flex' || flexWrap === 'no-wrap')) {
    return false;
  }

  if (uikitAbsolutePositionProps.has(key) && positionType !== 'absolute') {
    return false;
  }

  if (key === 'scrollbarWidth' && overflow !== 'scroll') {
    return false;
  }

  return true;
}

function isEditingDetails() {
  const active = document.activeElement;
  if (!active) return false;
  if (!elDetailsContent.contains(active)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

elDetailsContent.addEventListener('focusout', function () {
  setTimeout(function () {
    if (isEditingDetails()) return;
    if (!snapshot) return;
    renderTree();
    if (selectedUuid && snapshot.objectMap[selectedUuid]) {
      renderDetails(snapshot.objectMap[selectedUuid]);
    }
  }, 0);
});

function clearDetails() {
  elDetailsEmpty.style.display = '';
  elDetailsContent.style.display = 'none';
  elDetailsContent.innerHTML = '';
}

function toPascalCase(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(function (part) {
      return part ? part[0].toUpperCase() + part.slice(1) : '';
    })
    .join('');
}

function toJsLiteral(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value && typeof value === 'object' && value.isColor === true) {
    const r = typeof value.r === 'number' ? value.r : 1;
    const g = typeof value.g === 'number' ? value.g : 1;
    const b = typeof value.b === 'number' ? value.b : 1;
    const toByte = function (v) {
      return Math.max(0, Math.min(255, Math.round(v * 255)));
    };
    const hex = ((toByte(r) << 16) | (toByte(g) << 8) | toByte(b)).toString(16).padStart(6, '0');
    return 'new THREE.Color(0x' + hex + ')';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return '[' + value.map(function (item) { return toJsLiteral(item); }).join(', ') + ']';
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return 'null';
  }
}

function getGeneratedUikitCode(obj) {
  if (!obj || !obj.isUikit || !obj.uikit) return '';

  const ctorRaw = obj.constructorName || obj.type || 'Component';
  const ctorName = toPascalCase(ctorRaw) || 'Component';
  const variableName = 'node';

  const explicitKeys = Array.isArray(obj.uikitExplicit)
    ? obj.uikitExplicit.filter(function (key) { return typeof key === 'string' && key.length > 0; })
    : [];

  const keySource = explicitKeys.length > 0 ? explicitKeys : Object.keys(obj.uikit);
  const keys = keySource.filter(function (key) {
    const rawValue = obj.uikit[key];
    if (!shouldIncludeUikitPropertyForObject(obj, key)) return false;
    return hasMeaningfulUikitValue(rawValue);
  });

  const lines = [];
  lines.push('const ' + variableName + ' = new UIKit.' + ctorName + '({');

  if (keys.length > 0) {
    for (const key of keys) {
      lines.push('\t' + key + ': ' + toJsLiteral(obj.uikit[key]) + ',');
    }
  }

  lines.push('});');
  return lines.join('\n');
}

function renderDetails(obj) {
  elDetailsEmpty.style.display = 'none';
  elDetailsContent.style.display = '';
  elDetailsContent.innerHTML = '';

  const contentEditors = getComponentContentEditors(obj);

  const secId = makeSection('Identity', { key: 'details:identity', store: collapsedDetailsSections });
  addReadRow(secId.content, 'uuid', obj.uuid);
  addReadRow(secId.content, 'type', obj.type);
  addReadRow(secId.content, 'constructor', obj.constructorName || obj.type);
  addEditRow(secId.content, 'name', obj.label, function (val) {
    evalCmd(obj.uuid, 'name', val);
  });
  elDetailsContent.appendChild(secId.element);

  const secVis = makeSection('Display', { key: 'details:display', store: collapsedDetailsSections });
  addCheckboxRow(secVis.content, 'visible', obj.visible, function (val) {
    evalCmd(obj.uuid, 'visible', val);
  });
  addNumberRow(secVis.content, 'renderOrder', obj.renderOrder, function (val) {
    evalCmd(obj.uuid, 'renderOrder', val);
  });
  elDetailsContent.appendChild(secVis.element);

  if (contentEditors.length > 0) {
    const secContent = makeSection('Component content', {
      key: 'details:component-content',
      store: collapsedDetailsSections,
    });
    for (const editor of contentEditors) {
      const value = getObjectEditableValue(obj, editor.key);
      if (typeof value === 'boolean') {
        addCheckboxRow(secContent.content, editor.label, value, function (next) {
          applyObjectEditValue(obj, editor.key, next);
        });
        continue;
      }
      if (typeof value === 'number') {
        addNumberRow(secContent.content, editor.label, value, function (next) {
          applyObjectEditValue(obj, editor.key, next);
        });
        continue;
      }
      addEditRow(secContent.content, editor.label, String(value), function (next) {
        applyObjectEditValue(obj, editor.key, next);
      });
    }
    elDetailsContent.appendChild(secContent.element);
  }

  if (!obj.isUikit) {
    const secTr = makeSection('Transform', { key: 'details:transform', store: collapsedDetailsSections });
    addVec3Row(secTr.content, 'position', obj.position, function (axis, val) {
      evalCmd(obj.uuid, 'position.' + axis, val);
    });
    addVec3Row(secTr.content, 'scale', obj.scale, function (axis, val) {
      evalCmd(obj.uuid, 'scale.' + axis, val);
    });
    addVec3Row(secTr.content, 'rotation', obj.rotation, function (axis, val) {
      evalCmd(obj.uuid, 'rotation.' + axis, val);
    });
    elDetailsContent.appendChild(secTr.element);
  }

  if (obj.userData && Object.keys(obj.userData).length > 0) {
    const secUD = makeSection('userData', { key: 'details:userData', store: collapsedDetailsSections });
    for (const entry of Object.entries(obj.userData)) {
      addReadRow(secUD.content, entry[0], JSON.stringify(entry[1]));
    }
    elDetailsContent.appendChild(secUD.element);
  }

  if (obj.isUikit && obj.uikit) {
    const secUK = makeSection('UIKit properties', { key: 'details:uikit', store: collapsedDetailsSections, collapsedByDefault: false });

    // Render properties organized by category
    const categorizedKeys = new Set();
    for (const [category, propNames] of Object.entries(uikitPropertyCategories)) {
      const visiblePropNames = [];
      for (const propName of propNames) {
        categorizedKeys.add(propName);
        if (!(propName in obj.uikit)) continue;
        if (!shouldIncludeUikitPropertyForObject(obj, propName)) continue;
        if (!shouldShowUikitProperty(obj.uikit, propName)) continue;
        visiblePropNames.push(propName);
      }

      if (visiblePropNames.length === 0) continue;

      const categorySection = makeSection(category, {
        key: 'uikit:' + category,
        store: collapsedUikitCategories,
        collapsedByDefault: true,
        count: visiblePropNames.length,
        className: 'uikit-category',
      });
      const categoryGrid = document.createElement('div');
      categoryGrid.className = 'uikit-editor-list';
      categorySection.content.appendChild(categoryGrid);
      secUK.content.appendChild(categorySection.element);

      for (const key of visiblePropNames) {
        const rawValue = obj.uikit[key];
        const value = getEffectiveUikitValue(obj.uikit, key);
        const row = document.createElement('div');
        row.className = 'uikit-editor-row';
        const label = document.createElement('label');
        label.className = 'uikit-editor-label';
        label.textContent = key;
        if (!hasMeaningfulUikitValue(rawValue) && hasMeaningfulUikitValue(value)) {
          label.title = 'Showing default value';
        }
        const valDiv = document.createElement('div');
        addUikitPropEditor(valDiv, obj.uuid, key, value, rawValue);
        row.appendChild(label);
        row.appendChild(valDiv);
        categoryGrid.appendChild(row);
      }
    }

    // Any property not mapped above still appears in panel.
    const remaining = Object.keys(obj.uikit).filter(function (key) {
      return !categorizedKeys.has(key) && shouldIncludeUikitPropertyForObject(obj, key) && shouldShowUikitProperty(obj.uikit, key);
    });
    if (remaining.length > 0) {
      const advancedSection = makeSection('Advanced', {
        key: 'uikit:advanced',
        store: collapsedUikitCategories,
        collapsedByDefault: true,
        count: remaining.length,
        className: 'uikit-category',
      });
      const categoryGrid = document.createElement('div');
      categoryGrid.className = 'uikit-editor-list';
      advancedSection.content.appendChild(categoryGrid);
      secUK.content.appendChild(advancedSection.element);

      for (const key of remaining) {
        const rawValue = obj.uikit[key];
        const value = getEffectiveUikitValue(obj.uikit, key);
        const row = document.createElement('div');
        row.className = 'uikit-editor-row';
        const label = document.createElement('label');
        label.className = 'uikit-editor-label';
        label.textContent = key;
        if (!hasMeaningfulUikitValue(rawValue) && hasMeaningfulUikitValue(value)) {
          label.title = 'Showing default value';
        }
        const valDiv = document.createElement('div');
        addUikitPropEditor(valDiv, obj.uuid, key, value, rawValue);
        row.appendChild(label);
        row.appendChild(valDiv);
        categoryGrid.appendChild(row);
      }
    }

    elDetailsContent.appendChild(secUK.element);
  }

  if (obj.isUikit && obj.uikitSpecific && Object.keys(obj.uikitSpecific).length) {
    const secLayout = makeSection('UIKit layout (yoga node)', { key: 'details:yoga', store: collapsedDetailsSections });
    const grid = document.createElement('div');
    grid.className = 'uikit-props-grid';
    for (const entry of Object.entries(obj.uikitSpecific)) {
      const kEl = document.createElement('div');
      kEl.className = 'uikit-prop-key';
      kEl.textContent = entry[0];

      const vEl = document.createElement('div');
      vEl.className = 'uikit-prop-val';
      vEl.textContent = formatValue(entry[1]);

      grid.appendChild(kEl);
      grid.appendChild(vEl);
    }
    secLayout.content.appendChild(grid);
    elDetailsContent.appendChild(secLayout.element);
  }

  if (obj.isUikit && obj.uikit) {
    const secCode = makeSection('Generated UIKit code', {
      key: 'details:uikitCode',
      store: collapsedDetailsSections,
      collapsedByDefault: true,
    });
    const code = getGeneratedUikitCode(obj);
    const codeArea = document.createElement('textarea');
    codeArea.className = 'details-input details-code-block';
    codeArea.readOnly = true;
    codeArea.spellcheck = false;
    codeArea.value = code;
    secCode.content.appendChild(codeArea);
    elDetailsContent.appendChild(secCode.element);
  }

  const secAct = makeSection('Actions', { key: 'details:actions' });
  const printBtn = document.createElement('button');
  printBtn.className = 'btn print-btn';
  printBtn.textContent = 'console.log($ui)';
  printBtn.addEventListener('click', function () {
    evalHook('window.__UIKitDevTools && window.__UIKitDevTools.printObject(' + JSON.stringify(obj.uuid) + ')');
  });
  secAct.content.appendChild(printBtn);
  elDetailsContent.appendChild(secAct.element);
}

function makeSection(title, options) {
  const opts = options || {};
  const store = opts.store || collapsedDetailsSections;
  const key = opts.key || title;
  const initGroup = opts.initGroup || 'details';
  const initKey = initGroup + ':' + key;
  const sec = document.createElement('div');
  sec.className = 'details-section';
  if (opts.className) sec.classList.add(opts.className);

  const hdr = document.createElement('div');
  hdr.className = 'details-header is-foldable';

  const main = document.createElement('span');
  main.className = 'details-header-main';

  const chevron = document.createElement('span');
  chevron.className = 'details-chevron';
  main.appendChild(chevron);

  const label = document.createElement('span');
  label.className = 'details-title-text';
  label.textContent = title;
  main.appendChild(label);
  hdr.appendChild(main);

  const meta = document.createElement('span');
  meta.className = 'details-header-meta';
  if (typeof opts.count === 'number') {
    const count = document.createElement('span');
    count.className = 'details-count';
    count.textContent = String(opts.count);
    meta.appendChild(count);
  }
  const hint = document.createElement('span');
  hint.className = 'details-header-hint';
  meta.appendChild(hint);
  hdr.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'details-section-content';

  // Apply default collapsed state once per section key/group, then preserve user toggles.
  if (opts.collapsedByDefault && !initializedSectionDefaults.has(initKey)) {
    store.add(key);
    initializedSectionDefaults.add(initKey);
  }

  function syncCollapsedState() {
    const collapsed = store.has(key);
    sec.classList.toggle('is-collapsed', collapsed);
    chevron.textContent = collapsed ? '▸' : '▾';
    hint.textContent = collapsed ? 'click to expand' : 'click to collapse';
  }

  hdr.addEventListener('click', function () {
    if (store.has(key)) store.delete(key);
    else store.add(key);
    syncCollapsedState();
  });

  sec.appendChild(hdr);
  sec.appendChild(content);
  syncCollapsedState();

  return { element: sec, content: content };
}

function addReadRow(parent, label, value) {
  const row = document.createElement('div');
  row.className = 'details-row';
  const lbl = document.createElement('span');
  lbl.className = 'details-label';
  lbl.textContent = label;
  const val = document.createElement('span');
  val.className = 'details-value';
  val.textContent = formatValue(value);
  val.title = String(value);
  row.appendChild(lbl);
  row.appendChild(val);
  parent.appendChild(row);
}

function addEditRow(parent, label, value, onChange) {
  const row = document.createElement('div');
  row.className = 'details-row';
  const lbl = document.createElement('span');
  lbl.className = 'details-label';
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'details-input';
  inp.value = value || '';
  inp.addEventListener('change', function () { onChange(inp.value); });
  row.appendChild(lbl);
  row.appendChild(inp);
  parent.appendChild(row);
}

function addNumberRow(parent, label, value, onChange) {
  const row = document.createElement('div');
  row.className = 'details-row';
  const lbl = document.createElement('span');
  lbl.className = 'details-label';
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'details-input';
  inp.value = value || 0;
  inp.addEventListener('change', function () { onChange(parseFloat(inp.value)); });
  row.appendChild(lbl);
  row.appendChild(inp);
  parent.appendChild(row);
}

function addCheckboxRow(parent, label, value, onChange) {
  const row = document.createElement('div');
  row.className = 'details-row';
  const lbl = document.createElement('span');
  lbl.className = 'details-label';
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.className = 'details-checkbox';
  inp.checked = !!value;
  inp.addEventListener('change', function () { onChange(inp.checked); });
  row.appendChild(lbl);
  row.appendChild(inp);
  parent.appendChild(row);
}

function addVec3Row(parent, label, vec, onChange) {
  const row = document.createElement('div');
  row.className = 'vec3-row';
  const lbl = document.createElement('span');
  lbl.className = 'details-label';
  lbl.textContent = label;
  row.appendChild(lbl);

  const axes = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'details-input';
    inp.step = '0.001';
    inp.value = vec ? vec[i].toFixed(4) : '0';
    inp.title = axes[i];
    inp.placeholder = axes[i];
    const axis = axes[i];
    inp.addEventListener('change', function () {
      onChange(axis, parseFloat(inp.value));
    });
    row.appendChild(inp);
  }

  parent.appendChild(row);
}

function evalCmd(uuid, path, value) {
  const expr =
    'window.__UIKitDevTools && window.__UIKitDevTools.setProperty(' +
    JSON.stringify(uuid) + ',' + JSON.stringify(path) + ',' + toLiteral(value) + ')';
  evalHook(expr);
}

function evalUikitPropUpdate(uuid, key, value) {
  const expr =
    'window.__UIKitDevTools && window.__UIKitDevTools.setUikitProperties(' +
    JSON.stringify(uuid) + ',{' + JSON.stringify(key) + ':' + toLiteral(value) + '})';
  evalHook(expr, function () {
    evalHook('window.__UIKitDevTools && window.__UIKitDevTools.requestSnapshot()');
  });
}

function addUikitPropEditor(container, uuid, key, value, rawValue) {
  const enumOptions = uikitPropertyEnums[key];
  const hasEnumOptions = Array.isArray(enumOptions);

  if (typeof value === 'boolean') {
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'details-checkbox';
    inp.checked = value;
    inp.addEventListener('change', function () {
      evalUikitPropUpdate(uuid, key, inp.checked);
    });
    container.appendChild(inp);
    return;
  }

  if ((typeof value === 'string' && hasEnumOptions) || (value === null && hasEnumOptions)) {
    const sel = document.createElement('select');
    sel.className = 'details-input';
    sel.innerHTML = '<option value="">(empty)</option>';
    for (const opt of enumOptions) {
      const optEl = document.createElement('option');
      optEl.value = opt;
      optEl.textContent = opt;
      optEl.selected = opt === value;
      sel.appendChild(optEl);
    }
    if (!hasMeaningfulUikitValue(rawValue) && hasMeaningfulUikitValue(value)) {
      sel.title = 'Default value';
    }
    sel.addEventListener('change', function () {
      const val = sel.value === '' ? null : sel.value;
      evalUikitPropUpdate(uuid, key, val);
    });
    container.appendChild(sel);
    return;
  }

  if (typeof value === 'number') {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'details-input';
    inp.step = 'any';
    inp.value = String(value);
    if (!hasMeaningfulUikitValue(rawValue)) {
      inp.title = 'Default value';
    }
    inp.addEventListener('change', function () {
      const parsed = parseFloat(inp.value);
      if (!Number.isNaN(parsed)) evalUikitPropUpdate(uuid, key, parsed);
    });
    container.appendChild(inp);
    return;
  }

  if (value === null || value === undefined) {
    // Show default if known, but don't write anything until user changes the field.
    const fallbackDefault = getUikitDefaultValue(key);
    const defaultType = key.includes('Width') || key.includes('Height') || key.includes('Size') || key.includes('pixel') || key.includes('Spacing') ? 'number' : 'text';
    const inp = document.createElement('input');
    inp.type = defaultType;
    inp.className = 'details-input';
    if (fallbackDefault !== null && fallbackDefault !== undefined) {
      inp.value = String(fallbackDefault);
      inp.title = 'Default value';
    } else {
      inp.placeholder = '(not set)';
    }
    inp.addEventListener('change', function () {
      let val = inp.value.trim();
      if (!val) {
        val = null;
      } else if (defaultType === 'number') {
        val = parseFloat(val);
        if (isNaN(val)) return;
      }
      evalUikitPropUpdate(uuid, key, val);
    });
    container.appendChild(inp);
    return;
  }

  if (typeof value === 'string') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'details-input';
    inp.value = value;
    if (!hasMeaningfulUikitValue(rawValue)) {
      inp.title = 'Default value';
    }
    inp.addEventListener('change', function () {
      evalUikitPropUpdate(uuid, key, inp.value);
    });
    container.appendChild(inp);
    return;
  }

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'details-input';
  inp.value = JSON.stringify(value);
  inp.addEventListener('change', function () {
    try {
      const parsed = JSON.parse(inp.value);
      evalUikitPropUpdate(uuid, key, parsed);
    } catch (_) {
      inp.value = JSON.stringify(value);
    }
  });
  container.appendChild(inp);
}

function formatValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number') return v.toFixed(4).replace(/\.?0+$/, '') || '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const elTreePane = document.getElementById('tree-pane');
const elResizer = document.getElementById('resizer');
const elMain = document.getElementById('main');

(function initResizer() {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  elResizer.addEventListener('mousedown', function (e) {
    dragging = true;
    startX = e.clientX;
    startW = elTreePane.offsetWidth;
    elResizer.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(120, Math.min(startW + delta, elMain.offsetWidth - 120));
    elTreePane.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    elResizer.classList.remove('dragging');
  });
})();

setTimeout(function () {
  evalHook('window.__UIKitDevTools ? window.__UIKitDevTools.getSnapshot() : null', function (result) {
    if (result) handleSnapshot(result);
  });
}, 500);
