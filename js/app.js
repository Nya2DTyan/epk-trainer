/* =========================================================================
   EPK-Trainer — интерфейс
   Холст на SVG: перетаскивание элементов, проведение связей, привязки,
   живая проверка синтаксиса, сверка с эталоном, экспорт.
   ========================================================================= */

import {
  NODE_TYPES, OPERATORS, CONTROL, ATTACH, RULE_TEXT,
  uid, validate, compare, autoLayout, emptyModel, normalize, boundsOf, sizeOf,
} from './core.js';
import { TASKS, taskById } from './tasks.js';

/* ------------------------------------------------------------------ состояние */

const STORE_KEY = 'epk-trainer-v1';

const state = {
  taskId: TASKS[0].id,
  model: emptyModel(),
  selectedNode: null,
  selectedEdge: null,
  mode: 'select',
  zoom: 1,
  panX: 0,
  panY: 0,
  connectFrom: null,
  drag: null,
  lastResult: null,
  checked: false,
  history: [],
  store: loadStore(),
};

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : { models: {}, scores: {} };
  } catch {
    return { models: {}, scores: {} };
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  } catch { /* приватный режим — просто не сохраняем */ }
}

function persistModel() {
  state.store.models[state.taskId] = state.model;
  saveStore();
}

/* --------------------------------------------------------------------- DOM */

const $ = (sel) => document.querySelector(sel);
const svg = $('#canvas');
const gViewport = $('#viewport');
const gEdges = $('#edges');
const gNodes = $('#nodes');
const gOverlay = $('#overlay');

const el = {
  taskSelect: $('#taskSelect'),
  taskLevel: $('#taskLevel'),
  taskTitle: $('#taskTitle'),
  taskSubtitle: $('#taskSubtitle'),
  taskGoal: $('#taskGoal'),
  taskText: $('#taskText'),
  taskTextRu: $('#taskTextRu'),
  taskHints: $('#taskHints'),
  palette: $('#palette'),
  issues: $('#issues'),
  liveBadge: $('#liveBadge'),
  scoreBox: $('#scoreBox'),
  scoreRing: $('#scoreRing'),
  scoreValue: $('#scoreValue'),
  scoreMeta: $('#scoreMeta'),
  props: $('#props'),
  propsType: $('#propsType'),
  propsLabel: $('#propsLabel'),
  canvasHint: $('#canvasHint'),
  zoomLabel: $('#zoomLabel'),
  progressChip: $('#progressChip'),
  legendList: $('#legendList'),
  modal: $('#modal'),
  modalTitle: $('#modalTitle'),
  modalBody: $('#modalBody'),
};

/* -------------------------------------------------------------- геометрия */

/** Точка на границе фигуры в направлении к (tx, ty). */
function anchorPoint(node, tx, ty) {
  const cx = node.x;
  const cy = node.y;
  let dx = tx - cx;
  let dy = ty - cy;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) { dx = 1; dy = 0; }
  const s = sizeOf(node);

  if (s.r) {
    const len = Math.hypot(dx, dy) || 1;
    return { x: cx + (dx / len) * s.r, y: cy + (dy / len) * s.r };
  }
  if (s.rx) {
    const k = 1 / Math.sqrt((dx / s.rx) ** 2 + (dy / s.ry) ** 2);
    return { x: cx + dx * k, y: cy + dy * k };
  }
  const hw = s.w / 2;
  const hh = s.h / 2;
  const tx1 = hw / Math.abs(dx || 1e-6);
  const ty1 = hh / Math.abs(dy || 1e-6);
  const t = Math.min(tx1, ty1);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Путь связи: прямая либо дуга для обратных связей. */
function edgePath(a, b) {
  const pa = anchorPoint(a, b.x, b.y);
  const pb = anchorPoint(b, a.x, a.y);
  if (b.x < a.x - 20) {
    // обратная связь — обводим снизу
    const dy = Math.max(90, Math.abs(a.y - b.y) * 0.6 + 70);
    return `M ${pa.x} ${pa.y} C ${pa.x + 60} ${pa.y + dy}, ${pb.x - 60} ${pb.y + dy}, ${pb.x} ${pb.y}`;
  }
  return `M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`;
}

/* ------------------------------------------------------------ SVG-хелперы */

const NS = 'http://www.w3.org/2000/svg';
function mk(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  return n;
}

function wrapLabel(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) {
    const rest = lines.slice(2).join(' ');
    return [lines[0], lines[1], rest.length > maxChars ? rest.slice(0, maxChars - 1) + '…' : rest];
  }
  return lines;
}

function shapePath(node) {
  const s = sizeOf(node);
  const { x, y } = node;
  if (s.r) return null;
  if (s.rx) return null;
  const hw = s.w / 2;
  const hh = s.h / 2;

  if (node.type === 'event') {
    const k = 16;
    return `M ${x - hw + k} ${y - hh} L ${x + hw - k} ${y - hh} L ${x + hw} ${y} L ${x + hw - k} ${y + hh} L ${x - hw + k} ${y + hh} L ${x - hw} ${y} Z`;
  }
  if (node.type === 'interface') {
    const k = 18;
    return `M ${x - hw + k} ${y - hh} L ${x + hw - k} ${y - hh} L ${x + hw} ${y} L ${x + hw - k} ${y + hh} L ${x - hw + k} ${y + hh} L ${x - hw} ${y} Z`;
  }
  if (node.type === 'data') {
    const fold = 14;
    return `M ${x - hw} ${y - hh} L ${x + hw} ${y - hh} L ${x + hw} ${y + hh - fold} Q ${x + hw} ${y + hh} ${x + hw - fold} ${y + hh} L ${x - hw} ${y + hh} Z`;
  }
  // function — скруглённый прямоугольник
  const r = 8;
  return `M ${x - hw + r} ${y - hh} L ${x + hw - r} ${y - hh} Q ${x + hw} ${y - hh} ${x + hw} ${y - hh + r} L ${x + hw} ${y + hh - r} Q ${x + hw} ${y + hh} ${x + hw - r} ${y + hh} L ${x - hw + r} ${y + hh} Q ${x - hw} ${y + hh} ${x - hw} ${y + hh - r} L ${x - hw} ${y - hh + r} Q ${x - hw} ${y - hh} ${x - hw + r} ${y - hh} Z`;
}

/* ---------------------------------------------------------------- отрисовка */

function render() {
  gNodes.textContent = '';
  gEdges.textContent = '';

  const flaggedNodes = new Set();
  const flaggedEdges = new Set();
  if (state.lastResult) {
    for (const i of state.lastResult.issues) {
      if (i.level !== 'error') continue;
      (i.nodeIds || []).forEach((id) => flaggedNodes.add(id));
      (i.edgeIds || []).forEach((id) => flaggedEdges.add(id));
    }
  }

  const byId = new Map(state.model.nodes.map((n) => [n.id, n]));

  // связи
  for (const e of state.model.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const d = edgePath(a, b);
    const isAssoc = e.kind === 'assoc';
    const cls = ['edge'];
    if (isAssoc) cls.push('assoc');
    else cls.push('arrow');
    if (flaggedEdges.has(e.id)) cls.push('flagged');
    if (state.selectedEdge === e.id) cls.push('selected');

    const hit = mk('path', { d, class: 'edge hit' });
    hit.dataset.edge = e.id;
    gEdges.appendChild(hit);

    const path = mk('path', { d, class: cls.join(' ') });
    path.dataset.edge = e.id;
    if (isAssoc) path.setAttribute('marker-end', '');
    gEdges.appendChild(path);
  }

  // элементы
  for (const node of state.model.nodes) {
    const g = mk('g', { class: `node ${node.type}`, transform: `translate(0,0)` });
    g.dataset.node = node.id;
    if (state.selectedNode === node.id) g.classList.add('selected');
    if (flaggedNodes.has(node.id)) g.classList.add('flagged');

    const s = sizeOf(node);

    if (s.r) {
      g.appendChild(mk('circle', { class: 'halo', cx: node.x, cy: node.y, r: s.r + 6, fill: 'transparent' }));
      g.appendChild(mk('circle', { class: 'shape', cx: node.x, cy: node.y, r: s.r }));
      const sym = node.type === 'and' ? '∧' : node.type === 'or' ? '∨' : '×';
      const t = mk('text', { class: 'label', x: node.x, y: node.y + 1 });
      t.textContent = sym;
      g.appendChild(t);
    } else if (s.rx) {
      g.appendChild(mk('ellipse', { class: 'halo', cx: node.x, cy: node.y, rx: s.rx + 6, ry: s.ry + 6, fill: 'transparent' }));
      g.appendChild(mk('ellipse', { class: 'shape', cx: node.x, cy: node.y, rx: s.rx, ry: s.ry }));
      const lines = wrapLabel(node.label, 22);
      const t = mk('text', { class: 'label', x: node.x, y: node.y - (lines.length - 1) * 7 });
      lines.forEach((ln, i) => {
        const ts = mk('tspan', { x: node.x, dy: i === 0 ? 0 : 14 });
        ts.textContent = ln;
        t.appendChild(ts);
      });
      g.appendChild(t);
    } else {
      g.appendChild(mk('path', { class: 'halo', d: shapePath(node), fill: 'transparent', stroke: 'none' }));
      g.appendChild(mk('path', { class: 'shape', d: shapePath(node) }));
      const maxChars = node.type === 'data' ? 17 : 22;
      const lines = wrapLabel(node.label, maxChars);
      const lh = 14;
      const startY = node.y - ((lines.length - 1) * lh) / 2;
      const t = mk('text', { class: 'label', x: node.x, y: startY });
      lines.forEach((ln, i) => {
        const ts = mk('tspan', { x: node.x, dy: i === 0 ? 0 : lh });
        ts.textContent = ln;
        t.appendChild(ts);
      });
      g.appendChild(t);
    }

    // порты: выход справа, вход слева
    if (CONTROL.has(node.type)) {
      const outPort = mk('circle', {
        class: 'port port-out', cx: node.x + (s.r || s.rx || s.w / 2) + (s.r ? 0 : 0),
        cy: node.y, r: 5,
      });
      outPort.dataset.port = 'out';
      outPort.dataset.node = node.id;
      g.appendChild(outPort);
    }

    gNodes.appendChild(g);
  }

  // черновая линия при перетаскивании связи
  gOverlay.textContent = '';
  if (state.drag?.kind === 'connect' && state.drag.cursor) {
    const from = byId.get(state.drag.from);
    if (from) {
      const p = anchorPoint(from, state.drag.cursor.x, state.drag.cursor.y);
      gOverlay.appendChild(mk('line', {
        x1: p.x, y1: p.y, x2: state.drag.cursor.x, y2: state.drag.cursor.y,
        stroke: '#4a9eff', 'stroke-width': 2.2, 'stroke-dasharray': '6 4',
      }));
    }
  }

  applyTransform();
  updateProps();
}

function applyTransform() {
  gViewport.setAttribute('transform', `translate(${state.panX}, ${state.panY}) scale(${state.zoom})`);
  el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

/* ------------------------------------------------------------ координаты */

function screenToWorld(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.panX) / state.zoom,
    y: (clientY - r.top - state.panY) / state.zoom,
  };
}

function nodeAt(world, pad = 0) {
  for (let i = state.model.nodes.length - 1; i >= 0; i--) {
    const n = state.model.nodes[i];
    const s = sizeOf(n);
    if (s.r) {
      if (Math.hypot(world.x - n.x, world.y - n.y) <= s.r + pad) return n;
    } else if (s.rx) {
      const k = ((world.x - n.x) / (s.rx + pad)) ** 2 + ((world.y - n.y) / (s.ry + pad)) ** 2;
      if (k <= 1) return n;
    } else {
      if (Math.abs(world.x - n.x) <= s.w / 2 + pad && Math.abs(world.y - n.y) <= s.h / 2 + pad) return n;
    }
  }
  return null;
}

/* ------------------------------------------------------------- операции */

function pushHistory() {
  state.history.push(JSON.stringify(state.model));
  if (state.history.length > 60) state.history.shift();
}

function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  state.model = JSON.parse(prev);
  state.selectedNode = null;
  state.selectedEdge = null;
  persistModel();
  runValidation();
  render();
}

/** Куда ставить новый элемент при клике по палитре: справа от последнего,
    чтобы цепочка росла слева направо, как принято в EPK. */
function nextSpot(type) {
  const nodes = state.model.nodes;
  if (!nodes.length) return { x: 160, y: 260 };
  const last = state.selectedNode
    ? nodes.find((n) => n.id === state.selectedNode) || nodes[nodes.length - 1]
    : nodes[nodes.length - 1];
  return { x: Math.round((last.x + 250) / 8) * 8, y: last.y };
}

/** Свободная точка рядом с желаемой: не даём новым элементам лечь друг на друга. */
function freeSpot(type, want) {
  const s = sizeOf({ type });
  const halfW = (s.w || s.rx * 2 || s.r * 2) / 2;
  const halfH = (s.h || s.ry * 2 || s.r * 2) / 2;

  const taken = state.model.nodes.map((n) => {
    const t = sizeOf(n);
    const hw = (t.w || t.rx * 2 || t.r * 2) / 2;
    const hh = (t.h || t.ry * 2 || t.r * 2) / 2;
    return { x: n.x - hw, y: n.y - hh, w: hw * 2, h: hh * 2 };
  });

  const fits = (x, y) => {
    const box = { x: x - halfW, y: y - halfH, w: halfW * 2, h: halfH * 2 };
    return !taken.some((b) => {
      const ox = Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x);
      const oy = Math.min(b.y + b.h, box.y + box.h) - Math.max(b.y, box.y);
      return ox > 6 && oy > 6;
    });
  };

  if (fits(want.x, want.y)) return want;
  // EPK читается слева направо, поэтому свободное место ищем в первую
  // очередь справа, затем по вертикали.
  for (let ring = 1; ring <= 8; ring++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = Math.round((want.x + dx * ring * 110) / 8) * 8;
      const y = Math.round((want.y + dy * ring * 96) / 8) * 8;
      if (fits(x, y)) return { x, y };
    }
  }
  return { x: want.x + 320, y: want.y + 160 };
}

function addNode(type, world) {
  pushHistory();
  const want = { x: world?.x ?? 240, y: world?.y ?? 200 };
  const spot = freeSpot(type, want);
  const node = {
    id: uid(type[0]),
    type,
    label: defaultLabel(type),
    x: spot.x,
    y: spot.y,
  };
  state.model.nodes.push(node);
  state.selectedNode = node.id;
  state.selectedEdge = null;
  persistModel();
  runValidation();
  render();
  ensureVisible(node);
  if (type === 'event' || type === 'function') {
    setTimeout(() => el.propsLabel.focus(), 30);
  }
}

/** Подвигаем холст, если элемент оказался за пределами видимой области. */
function ensureVisible(node) {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const s = sizeOf(node);
  const halfW = (s.w || s.rx * 2 || s.r * 2) / 2;
  const halfH = (s.h || s.ry * 2 || s.r * 2) / 2;
  const margin = 40;

  const left = state.panX + (node.x - halfW) * state.zoom;
  const right = state.panX + (node.x + halfW) * state.zoom;
  const top = state.panY + (node.y - halfH) * state.zoom;
  const bottom = state.panY + (node.y + halfH) * state.zoom;

  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > r.width - margin) dx = (r.width - margin) - right;
  if (top < margin) dy = margin - top;
  else if (bottom > r.height - margin) dy = (r.height - margin) - bottom;

  if (dx || dy) {
    state.panX += dx;
    state.panY += dy;
    applyTransform();
  }
}

function defaultLabel(type) {
  switch (type) {
    case 'event': return 'Ereignis ist eingetreten';
    case 'function': return 'Funktion ausführen';
    case 'and': return 'UND';
    case 'or': return 'ODER';
    case 'xor': return 'XOR';
    case 'org': return 'Organisationseinheit';
    case 'data': return 'Datenobjekt';
    case 'interface': return 'Prozessschnittstelle';
    default: return '';
  }
}

function deleteSelection() {
  if (state.selectedNode) {
    pushHistory();
    const id = state.selectedNode;
    state.model.nodes = state.model.nodes.filter((n) => n.id !== id);
    state.model.edges = state.model.edges.filter((e) => e.from !== id && e.to !== id);
    state.selectedNode = null;
  } else if (state.selectedEdge) {
    pushHistory();
    const id = state.selectedEdge;
    state.model.edges = state.model.edges.filter((e) => e.id !== id);
    state.selectedEdge = null;
  } else return;
  persistModel();
  runValidation();
  render();
}

function connect(fromId, toId) {
  if (fromId === toId) return;
  const a = state.model.nodes.find((n) => n.id === fromId);
  const b = state.model.nodes.find((n) => n.id === toId);
  if (!a || !b) return;

  const attachPair = (ATTACH.has(a.type) && b.type === 'function') || (ATTACH.has(b.type) && a.type === 'function');
  const kind = attachPair ? 'assoc' : 'flow';

  if (kind === 'flow' && (ATTACH.has(a.type) || ATTACH.has(b.type))) {
    flashHint('Орг. единицы и данные соединяются только с функциями — включите режим «Привязка».');
    return;
  }

  // привязка неориентирована: дубликат в обратную сторону тоже не нужен
  const exists = state.model.edges.some((e) => e.kind === kind && (
    (e.from === fromId && e.to === toId) ||
    (kind === 'assoc' && e.from === toId && e.to === fromId)
  ));
  if (exists) { flashHint('Такая связь уже есть.'); return; }

  pushHistory();
  state.model.edges.push({ id: uid('e'), from: fromId, to: toId, kind });
  persistModel();
  runValidation();
  render();
}

function flashHint(text) {
  const prev = el.canvasHint.textContent;
  el.canvasHint.textContent = text;
  el.canvasHint.style.color = '#f85149';
  setTimeout(() => {
    el.canvasHint.textContent = prev;
    el.canvasHint.style.color = '';
  }, 2600);
}

/* ---------------------------------------------------------- взаимодействие */

svg.addEventListener('pointerdown', (ev) => {
  if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
    state.drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, panX: state.panX, panY: state.panY };
    svg.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button !== 0) return;

  const portEl = ev.target.closest?.('[data-port]');
  if (portEl) {
    const id = portEl.dataset.node;
    state.drag = { kind: 'connect', from: id, cursor: screenToWorld(ev.clientX, ev.clientY) };
    svg.setPointerCapture(ev.pointerId);
    render();
    return;
  }

  const edgeEl = ev.target.closest?.('[data-edge]');
  if (edgeEl) {
    state.selectedEdge = edgeEl.dataset.edge;
    state.selectedNode = null;
    render();
    return;
  }

  const g = ev.target.closest?.('[data-node]');
  const world = screenToWorld(ev.clientX, ev.clientY);

  if (g) {
    const node = state.model.nodes.find((n) => n.id === g.dataset.node);
    if (!node) return;

    if (state.mode === 'connect' || state.mode === 'assoc') {
      if (!state.connectFrom) {
        // в режиме привязки первым должен идти орг. элемент или данные
        if (state.mode === 'assoc' && !ATTACH.has(node.type)) {
          flashHint('Привязка: сначала кликните орг. единицу или данные, затем функцию.');
          return;
        }
        if (state.mode === 'connect' && ATTACH.has(node.type)) {
          flashHint('Орг. единицы и данные привязываются в режиме «Привязка», а не «Связь».');
          return;
        }
        state.connectFrom = node.id;
        state.selectedNode = node.id;
        flashHint(`Источник: «${node.label}». Теперь кликните целевой элемент.`);
        render();
      } else {
        connect(state.connectFrom, node.id);
        state.connectFrom = null;
        render();
      }
      return;
    }

    state.selectedNode = node.id;
    state.selectedEdge = null;
    state.drag = {
      kind: 'move',
      id: node.id,
      dx: node.x - world.x,
      dy: node.y - world.y,
      moved: false,
    };
    svg.setPointerCapture(ev.pointerId);
    render();
    return;
  }

  // пустое место — снять выделение
  state.selectedNode = null;
  state.selectedEdge = null;
  state.connectFrom = null;
  state.drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, panX: state.panX, panY: state.panY };
  svg.setPointerCapture(ev.pointerId);
  render();
});

svg.addEventListener('pointermove', (ev) => {
  if (!state.drag) return;
  const d = state.drag;

  if (d.kind === 'pan') {
    state.panX = d.panX + (ev.clientX - d.startX);
    state.panY = d.panY + (ev.clientY - d.startY);
    applyTransform();
    return;
  }

  if (d.kind === 'move') {
    const world = screenToWorld(ev.clientX, ev.clientY);
    const node = state.model.nodes.find((n) => n.id === d.id);
    if (!node) return;
    node.x = Math.round((world.x + d.dx) / 8) * 8;
    node.y = Math.round((world.y + d.dy) / 8) * 8;
    d.moved = true;
    render();
    return;
  }

  if (d.kind === 'connect') {
    d.cursor = screenToWorld(ev.clientX, ev.clientY);
    render();
  }
});

svg.addEventListener('pointerup', (ev) => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;

  if (d.kind === 'move' && d.moved) {
    persistModel();
  }

  if (d.kind === 'connect') {
    const world = screenToWorld(ev.clientX, ev.clientY);
    const target = nodeAt(world, 6);
    if (target && target.id !== d.from) connect(d.from, target.id);
    else render();
    return;
  }

  render();
});

svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  const prev = state.zoom;
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = Math.min(2.6, Math.max(0.35, prev * factor));
  state.panX = mx - ((mx - state.panX) / prev) * next;
  state.panY = my - ((my - state.panY) / prev) * next;
  state.zoom = next;
  applyTransform();
}, { passive: false });

/* ------------------------------------------------------------- проверка */

function runValidation() {
  state.lastResult = validate(state.model);
  renderIssues();
  updateLiveBadge();
}

function updateLiveBadge() {
  const r = state.lastResult;
  if (!r || !state.model.nodes.length) {
    el.liveBadge.textContent = '—';
    el.liveBadge.className = 'badge';
    return;
  }
  if (r.stats.errors === 0) {
    el.liveBadge.textContent = r.stats.warnings ? `синтаксис ок · ${r.stats.warnings} зам.` : 'синтаксис ок';
    el.liveBadge.className = 'badge ok';
  } else {
    el.liveBadge.textContent = `${r.stats.errors} ошиб.`;
    el.liveBadge.className = 'badge err';
  }
}

function renderIssues() {
  const r = state.lastResult;
  el.issues.textContent = '';
  if (!r || !state.model.nodes.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Добавьте элементы и связи — замечания появятся здесь автоматически.';
    el.issues.appendChild(p);
    return;
  }

  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  const list = [...r.issues].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

  if (!list.length) {
    const div = document.createElement('div');
    div.className = 'issue ok';
    div.innerHTML = '<span class="rule">OK</span><span class="msg">Синтаксис соблюдён. Нажмите «Проверить», чтобы сверить с эталоном.</span>';
    el.issues.appendChild(div);
    return;
  }

  for (const i of list) {
    const div = document.createElement('div');
    div.className = `issue ${i.level}${(i.nodeIds?.length || i.edgeIds?.length) ? ' focusable' : ''}`;
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = i.rule;
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = i.message;
    div.append(rule, msg);
    if (i.nodeIds?.length || i.edgeIds?.length) {
      div.addEventListener('click', () => focusIssue(i));
    }
    el.issues.appendChild(div);
  }
}

function focusIssue(issue) {
  const ids = [...(issue.nodeIds || []), ...(issue.edgeIds || [])];
  if (!ids.length) return;
  const nodes = state.model.nodes.filter((n) => ids.includes(n.id));
  if (!nodes.length) return;
  state.selectedNode = nodes[0].id;
  render();
  const r = svg.getBoundingClientRect();
  const cx = nodes.reduce((a, n) => a + n.x, 0) / nodes.length;
  const cy = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
  state.panX = r.width / 2 - cx * state.zoom;
  state.panY = r.height / 2 - cy * state.zoom;
  applyTransform();
}

function doCheck() {
  const syntax = validate(state.model);
  const task = taskById(state.taskId);
  const cmp = compare(state.model, task.reference);
  state.checked = true;

  el.scoreBox.hidden = false;
  const pct = cmp.percent;
  el.scoreValue.textContent = `${pct}%`;
  el.scoreRing.style.setProperty('--p', pct);
  el.scoreRing.className = 'score-ring' + (pct >= 85 ? ' good' : pct >= 55 ? ' mid' : '');

  const syntaxOk = syntax.stats.errors === 0;
  el.scoreMeta.innerHTML = `
    <div><b>${cmp.matchedNodes}</b> / ${cmp.totalNodes} элементов</div>
    <div><b>${cmp.matchedEdges}</b> / ${cmp.totalEdges} связей</div>
    <div>Синтаксис: <b style="color:${syntaxOk ? 'var(--ok)' : 'var(--err)'}">${syntaxOk ? 'без ошибок' : syntax.stats.errors + ' ошибок'}</b></div>
  `;

  // объединяем замечания: сначала синтаксис, потом расхождения с эталоном
  const merged = [...syntax.issues];
  for (const i of cmp.issues) {
    if (i.level === 'warn' && /название отличается/.test(i.message)) continue;
    merged.push(i);
  }
  state.lastResult = { issues: merged, stats: syntax.stats };
  renderIssues();
  updateLiveBadge();
  render();

  // прогресс
  const best = Math.max(state.store.scores[state.taskId] || 0, pct);
  state.store.scores[state.taskId] = best;
  saveStore();
  updateProgress();

  if (pct >= 85 && syntaxOk) {
    el.scoreMeta.innerHTML += '<div style="color:var(--ok);margin-top:4px;font-weight:600">Задание зачтено ✓</div>';
  }
}

function updateProgress() {
  const done = TASKS.filter((t) => (state.store.scores[t.id] || 0) >= 85).length;
  el.progressChip.textContent = `${done} / ${TASKS.length} заданий`;
  el.progressChip.style.color = done === TASKS.length ? 'var(--ok)' : '';
}

/* ------------------------------------------------------------- свойства */

function updateProps() {
  const node = state.model.nodes.find((n) => n.id === state.selectedNode);
  if (!node) {
    el.props.hidden = true;
    return;
  }
  el.props.hidden = false;
  const meta = NODE_TYPES[node.type];
  el.propsType.textContent = `${meta.ru} · ${meta.title}`;
  if (document.activeElement !== el.propsLabel) el.propsLabel.value = node.label || '';
}

el.propsLabel.addEventListener('input', () => {
  const node = state.model.nodes.find((n) => n.id === state.selectedNode);
  if (!node) return;
  node.label = el.propsLabel.value;
  persistModel();
  runValidation();
  render();
});

$('#propsClose').addEventListener('click', () => {
  state.selectedNode = null;
  render();
});

$('#propsDelete').addEventListener('click', deleteSelection);

/* -------------------------------------------------------------- задание */

function loadTask(id) {
  state.taskId = id;
  const task = taskById(id);
  const saved = state.store.models[id];
  state.model = saved ? normalize(saved) : emptyModel();
  state.selectedNode = null;
  state.selectedEdge = null;
  state.connectFrom = null;
  state.checked = false;
  state.history = [];
  el.scoreBox.hidden = true;

  el.taskLevel.textContent = `Уровень ${task.level}`;
  el.taskTitle.textContent = task.title;
  el.taskSubtitle.textContent = task.subtitle;
  el.taskGoal.textContent = task.goal;
  el.taskText.textContent = task.text;
  el.taskTextRu.textContent = task.textRu;
  el.taskHints.textContent = '';
  for (const h of task.hints) {
    const li = document.createElement('li');
    li.textContent = h;
    el.taskHints.appendChild(li);
  }

  if (!state.model.nodes.length) {
    // стартовая подсказка: пустой холст с одним событием
    state.model.nodes.push({
      id: uid('e'), type: 'event', label: 'Ereignis ist eingetreten', x: 160, y: 240,
    });
    persistModel();
  }

  fitView();
  runValidation();
  render();
  updateProgress();
}

function fitView() {
  const r = svg.getBoundingClientRect();
  if (!state.model.nodes.length) {
    state.zoom = 1; state.panX = 40; state.panY = 40;
    return;
  }
  const b = boundsOf(state.model);
  const pad = 70;
  const zx = (r.width - pad * 2) / Math.max(b.w, 200);
  const zy = (r.height - pad * 2) / Math.max(b.h, 200);
  state.zoom = Math.min(1.15, Math.max(0.4, Math.min(zx, zy)));
  state.panX = r.width / 2 - (b.x + b.w / 2) * state.zoom;
  state.panY = r.height / 2 - (b.y + b.h / 2) * state.zoom;
}

/* -------------------------------------------------------------- палитра */

function buildPalette() {
  const order = ['event', 'function', 'and', 'or', 'xor', 'interface', 'org', 'data'];
  const glyph = {
    event: '⬡', function: '▭', and: '∧', or: '∨', xor: '×',
    interface: '⬠', org: '◯', data: '▤',
  };
  for (const type of order) {
    const meta = NODE_TYPES[type];
    const btn = document.createElement('button');
    btn.className = 'pal-item';
    btn.dataset.type = type;
    btn.draggable = true;
    btn.innerHTML = `<span class="glyph" style="color:var(--${type === 'interface' ? 'iface' : type})">${glyph[type]}</span><span>${meta.ru}</span>`;
    btn.addEventListener('click', () => {
      addNode(type, nextSpot(type));
    });
    btn.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/epk-type', type);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    el.palette.appendChild(btn);
  }

  svg.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
  svg.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const type = ev.dataTransfer.getData('text/epk-type');
    if (!type) return;
    const world = screenToWorld(ev.clientX, ev.clientY);
    addNode(type, { x: Math.round(world.x / 8) * 8, y: Math.round(world.y / 8) * 8 });
  });
}

function buildLegend() {
  const rows = [
    ['event', 'Событие — наступившее состояние, запускает или завершает функцию'],
    ['function', 'Функция — преобразование входа в выход, тратит время и деньги'],
    ['and', 'UND — все события / все ветви'],
    ['or', 'ODER — минимум одно, возможно все'],
    ['xor', 'XOR — ровно одно'],
    ['interface', 'Интерфейс процесса — вход из другого процесса или выход в него'],
    ['org', 'Орг. единица — кто выполняет функцию'],
    ['data', 'Данные/документ — что читается или создаётся'],
  ];
  for (const [type, text] of rows) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const color = type === 'interface' ? 'var(--iface)' : `var(--${type})`;
    sw.style.borderColor = color;
    sw.style.background = `color-mix(in srgb, ${color} 22%, transparent)`;
    const span = document.createElement('span');
    span.textContent = text;
    li.append(sw, span);
    el.legendList.appendChild(li);
  }
}

/* ---------------------------------------------------------------- кнопки */

$('#btnCheck').addEventListener('click', doCheck);
$('#btnUndo').addEventListener('click', undo);
$('#btnClear').addEventListener('click', () => {
  if (!confirm('Очистить модель? Действие можно отменить кнопкой «Отменить».')) return;
  pushHistory();
  state.model = emptyModel();
  state.selectedNode = null;
  state.selectedEdge = null;
  persistModel();
  runValidation();
  render();
});
$('#btnLayout').addEventListener('click', () => {
  pushHistory();
  state.model = autoLayout(state.model, { gapX: 260, gapY: 120 });
  persistModel();
  render();
  fitView();
  applyTransform();
});
$('#btnSolution').addEventListener('click', () => {
  const task = taskById(state.taskId);
  const laid = autoLayout(task.reference, { gapX: 250, gapY: 118 });
  el.modalTitle.textContent = `Эталон: ${task.title}`;
  el.modalBody.innerHTML = '';
  el.modalBody.appendChild(renderStaticSvg(laid));
  const note = document.createElement('p');
  note.style.cssText = 'font-size:12.5px;color:var(--text-dim);margin-top:10px';
  note.textContent = 'Сравнение идёт по типу элемента, названию (с учётом синонимов) и связям. Расположение элементов на оценку не влияет.';
  el.modalBody.appendChild(note);
  el.modal.hidden = false;
});

function renderStaticSvg(model) {
  const b = boundsOf(model);
  const pad = 40;
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  const root = mk('svg', {
    viewBox: `${b.x - pad} ${b.y - pad} ${w} ${h}`,
    style: 'background:#0d1117;border-radius:8px',
  });

  const defs = mk('defs');
  const marker = mk('marker', {
    id: 'arr-static', viewBox: '0 0 10 10', refX: '9', refY: '5',
    markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
  });
  marker.appendChild(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#7f8fa6' }));
  defs.appendChild(marker);
  root.appendChild(defs);

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const e of model.edges) {
    const a = byId.get(e.from);
    const bb = byId.get(e.to);
    if (!a || !bb) continue;
    const p = mk('path', {
      d: edgePath(a, bb),
      fill: 'none',
      stroke: e.kind === 'assoc' ? '#5d6d80' : '#7f8fa6',
      'stroke-width': e.kind === 'assoc' ? 1.5 : 1.9,
      'stroke-dasharray': e.kind === 'assoc' ? '5 4' : '',
      'marker-end': e.kind === 'assoc' ? '' : 'url(#arr-static)',
    });
    root.appendChild(p);
  }

  for (const node of model.nodes) {
    const g = mk('g', { class: `node ${node.type}` });
    const s = sizeOf(node);
    if (s.r) {
      g.appendChild(mk('circle', { class: 'shape', cx: node.x, cy: node.y, r: s.r }));
      const t = mk('text', { class: 'label', x: node.x, y: node.y + 1 });
      t.textContent = node.type === 'and' ? '∧' : node.type === 'or' ? '∨' : '×';
      g.appendChild(t);
    } else if (s.rx) {
      g.appendChild(mk('ellipse', { class: 'shape', cx: node.x, cy: node.y, rx: s.rx, ry: s.ry }));
      const lines = wrapLabel(node.label, 22);
      const t = mk('text', { class: 'label', x: node.x, y: node.y - (lines.length - 1) * 7 });
      lines.forEach((ln, i) => {
        const ts = mk('tspan', { x: node.x, dy: i === 0 ? 0 : 14 });
        ts.textContent = ln;
        t.appendChild(ts);
      });
      g.appendChild(t);
    } else {
      g.appendChild(mk('path', { class: 'shape', d: shapePath(node) }));
      const lines = wrapLabel(node.label, node.type === 'data' ? 17 : 22);
      const startY = node.y - ((lines.length - 1) * 14) / 2;
      const t = mk('text', { class: 'label', x: node.x, y: startY });
      lines.forEach((ln, i) => {
        const ts = mk('tspan', { x: node.x, dy: i === 0 ? 0 : 14 });
        ts.textContent = ln;
        t.appendChild(ts);
      });
      g.appendChild(t);
    }
    root.appendChild(g);
  }
  return root;
}

/* -------------------------------------------------------------- экспорт */

function buildExportSvg() {
  const model = state.model;
  if (!model.nodes.length) return null;
  const b = boundsOf(model);
  const pad = 50;
  const root = renderStaticSvg(model);
  root.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
  root.setAttribute('width', String(Math.round(b.w + pad * 2)));
  root.setAttribute('height', String(Math.round(b.h + pad * 2)));
  root.style.background = '#0d1117';

  const style = mk('style');
  style.textContent = `
    .node .shape { stroke-width: 1.8; }
    .node.event .shape { fill: rgba(126,231,135,.1); stroke: #7ee787; }
    .node.function .shape { fill: rgba(121,192,255,.12); stroke: #79c0ff; }
    .node.and .shape, .node.or .shape, .node.xor .shape { fill: rgba(210,168,255,.14); stroke: #d2a8ff; }
    .node.org .shape { fill: rgba(255,166,87,.12); stroke: #ffa657; }
    .node.data .shape { fill: rgba(255,216,102,.12); stroke: #ffd866; }
    .node.interface .shape { fill: rgba(86,212,221,.12); stroke: #56d4dd; }
    .node .label { font: 500 11.5px -apple-system, "Segoe UI", Roboto, sans-serif; fill: #e6edf3; text-anchor: middle; dominant-baseline: middle; }
    .node.and .label, .node.or .label, .node.xor .label { font-size: 15px; font-weight: 700; fill: #d2a8ff; }
  `;
  root.insertBefore(style, root.firstChild);
  return { svg: root, w: b.w + pad * 2, h: b.h + pad * 2 };
}

$('#btnExportSvg').addEventListener('click', () => {
  const built = buildExportSvg();
  if (!built) return flashHint('Сначала постройте модель.');
  const src = new XMLSerializer().serializeToString(built.svg);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${src}`], { type: 'image/svg+xml' });
  download(blob, `epk-${state.taskId}.svg`);
});

$('#btnExportPng').addEventListener('click', () => {
  const built = buildExportSvg();
  if (!built) return flashHint('Сначала постройте модель.');
  const src = new XMLSerializer().serializeToString(built.svg);
  const img = new Image();
  const scale = 2;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = built.w * scale;
    canvas.height = built.h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => blob && download(blob, `epk-${state.taskId}.png`), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* --------------------------------------------------------------- режимы */

document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    state.connectFrom = null;
    svg.className.baseVal = `mode-${state.mode}`;
    el.canvasHint.textContent = {
      select: 'Клик по элементу — выделить. Тяните элемент, чтобы переместить. Порт справа — провести связь.',
      connect: 'Кликните исходный элемент, затем целевой — связь создастся.',
      assoc: 'Кликните орг. единицу или данные, затем функцию — пунктирная привязка.',
    }[state.mode];
    render();
  });
});

/* ---------------------------------------------------------------- зум */

function zoomBy(factor) {
  const r = svg.getBoundingClientRect();
  const mx = r.width / 2;
  const my = r.height / 2;
  const prev = state.zoom;
  const next = Math.min(2.6, Math.max(0.35, prev * factor));
  state.panX = mx - ((mx - state.panX) / prev) * next;
  state.panY = my - ((my - state.panY) / prev) * next;
  state.zoom = next;
  applyTransform();
}

$('#zoomIn').addEventListener('click', () => zoomBy(1.15));
$('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.15));
$('#zoomFit').addEventListener('click', () => { fitView(); applyTransform(); });

/* ------------------------------------------------------------ вкладки */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $('#view-editor').hidden = view !== 'editor';
    $('#view-theory').hidden = view !== 'theory';
    if (view === 'editor') { fitView(); applyTransform(); }
  });
});

/* ------------------------------------------------------------- клавиши */

document.addEventListener('keydown', (ev) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing) return;

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (state.selectedNode || state.selectedEdge) {
      ev.preventDefault();
      deleteSelection();
    }
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    undo();
  }
  if (ev.key === 'Escape') {
    state.selectedNode = null;
    state.selectedEdge = null;
    state.connectFrom = null;
    el.modal.hidden = true;
    render();
  }
  if (ev.key === 'Enter' && state.mode === 'connect') {
    state.connectFrom = null;
    render();
  }
});

/* ------------------------------------------------------------- модалка */

$('#modalClose').addEventListener('click', () => { el.modal.hidden = true; });
el.modal.addEventListener('click', (ev) => { if (ev.target === el.modal) el.modal.hidden = true; });

/* --------------------------------------------------------------- старт */

function buildTaskSelect() {
  for (const t of TASKS) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.level}. ${t.title} — ${t.subtitle}`;
    el.taskSelect.appendChild(opt);
  }
  el.taskSelect.value = state.taskId;
  el.taskSelect.addEventListener('change', () => loadTask(el.taskSelect.value));
}

window.addEventListener('resize', () => { applyTransform(); });

buildTaskSelect();
buildPalette();
buildLegend();
loadTask(state.taskId);

// отладочный доступ к состоянию (для проверки в браузере и в тестах)
window.__epk = {
  state, validate, compare, TASKS, render, loadTask, doCheck, autoLayout,
  exportSvgString() {
    const built = buildExportSvg();
    return built ? new XMLSerializer().serializeToString(built.svg) : null;
  },
  solutionSvg(taskId) {
    const t = taskById(taskId);
    return new XMLSerializer().serializeToString(renderStaticSvg(autoLayout(t.reference, { gapX: 250, gapY: 118 })));
  },
};
