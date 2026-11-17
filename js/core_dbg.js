/* =========================================================================
   EPK-Trainer — ядро
   Модель графа, проверка синтаксиса eEPK по правилам из учебного материала
   (Saueressig: Modellierungsmethoden — eEPK, слайды 17–61), сравнение с
   эталонным решением и автоматическая раскладка.
   Модуль не зависит от DOM — его можно тестировать в node.
   ========================================================================= */

export const NODE_TYPES = {
  event:     { title: 'Ereignis',             ru: 'Событие',              shape: 'hex' },
  function:  { title: 'Funktion',             ru: 'Функция',              shape: 'rect' },
  and:       { title: 'UND-Verknüpfung',      ru: 'И (AND)',              shape: 'op', sym: '∧' },
  or:        { title: 'ODER-Verknüpfung',     ru: 'ИЛИ (OR)',             shape: 'op', sym: '∨' },
  xor:       { title: 'XOR-Verknüpfung',      ru: 'Исключающее ИЛИ',      shape: 'op', sym: '×' },
  org:       { title: 'Organisationseinheit', ru: 'Орг. единица',         shape: 'ellipse' },
  data:      { title: 'Datenobjekt / Beleg',  ru: 'Данные / документ',    shape: 'doc' },
  interface: { title: 'Prozessschnittstelle', ru: 'Интерфейс процесса',   shape: 'iface' },
};

export const OPERATORS = new Set(['and', 'or', 'xor']);
export const CONTROL   = new Set(['event', 'function', 'and', 'or', 'xor', 'interface']);
export const ATTACH    = new Set(['org', 'data']);

export const NODE_W = 190;
export const NODE_H = 72;
export const OP_R   = 26;

/* Допустимые пары «источник → цель» в контрольном потоке.
   Правило: на событие следует функция, на функцию — событие;
   операторы соединяют либо несколько событий, либо несколько функций. */
const ALLOWED_FLOW = new Set([
  'event>function',
  'event>and', 'event>or', 'event>xor',
  'function>event',
  'function>and', 'function>or', 'function>xor',
  'and>event', 'and>function',
  'or>event',  'or>function',
  'xor>event', 'xor>function',
  'interface>function',
  'function>interface',
]);

export const RULE_TEXT = {
  R1: 'Процесс начинается и заканчивается событием (или интерфейсом процесса)',
  R2: 'После события идёт функция, после функции — событие',
  R3: 'Оператор — либо split (1 вход, ≥2 выхода), либо join (≥2 входа, 1 выход)',
  R4: 'Орг. единицы и данные/документы соединяются только с функциями',
  R5: 'Ветви split сводятся join-оператором того же типа',
  R6: 'Все элементы достижимы из начального события',
  R7: 'Нет висячих элементов',
  R8: 'У события и функции ровно один вход и один выход',
  R9: 'Именование: событие — состояние, функция — инфинитив',
  R10: 'Обратные связи (Rückschleifen)',
};

/* ---------------------------------------------------------------- утилиты */

let _seq = 0;
export function uid(prefix = 'n') {
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

export function normalize(model) {
  const nodes = (model?.nodes || []).map((n) => ({ ...n }));
  const edges = (model?.edges || []).map((e, i) => ({
    id: e.id || `e${i + 1}`,
    from: e.from,
    to: e.to,
    kind: e.kind === 'assoc' ? 'assoc' : 'flow',
  }));
  return { nodes, edges };
}

export function emptyModel() {
  return { nodes: [], edges: [] };
}

export function nodeById(model, id) {
  return model.nodes.find((n) => n.id === id);
}

export function isOperator(type) {
  return OPERATORS.has(type);
}

/* ------------------------------------------------------- служебные графы */

function buildGraph(model) {
  const flow  = model.edges.filter((e) => e.kind !== 'assoc');
  const assoc = model.edges.filter((e) => e.kind === 'assoc');
  const out = new Map();
  const inc = new Map();
  for (const n of model.nodes) { out.set(n.id, []); inc.set(n.id, []); }
  for (const e of flow) {
    if (!out.has(e.from) || !inc.has(e.to)) continue;
    out.get(e.from).push(e);
    inc.get(e.to).push(e);
  }
  return { flow, assoc, out, inc };
}

/* Обратные рёбра ищем обходом в глубину: ребро, ведущее в вершину,
   которая ещё находится в стеке обхода, — это Rückschleife. */
function findBackEdges(model, out) {
  const color = new Map();
  const back = new Set();
  const stack = [];
  const visit = (startId) => {
    const frames = [{ id: startId, i: 0 }];
    color.set(startId, 1);
    stack.push(startId);
    while (frames.length) {
      const fr = frames[frames.length - 1];
      const edges = out.get(fr.id) || [];
      if (fr.i >= edges.length) {
        color.set(fr.id, 2);
        frames.pop();
        stack.pop();
        continue;
      }
      const e = edges[fr.i++];
      const c = color.get(e.to) || 0;
      if (c === 1) back.add(e.id);
      else if (c === 0) { color.set(e.to, 1); stack.push(e.to); frames.push({ id: e.to, i: 0 }); }
    }
  };
  for (const n of model.nodes) if (!color.get(n.id)) visit(n.id);
  return back;
}

function reachableFrom(startIds, out, skipEdges) {
  const seen = new Set(startIds);
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift();
    for (const e of out.get(id) || []) {
      if (skipEdges?.has(e.id)) continue;
      if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return seen;
}

/* ------------------------------------------------------------- проверка */

export function validate(rawModel) {
  const model = normalize(rawModel);
  const issues = [];
  const add = (level, rule, message, nodeIds = [], edgeIds = []) =>
    issues.push({ level, rule, message, nodeIds, edgeIds });

  const { nodes } = model;
  if (!nodes.length) {
    add('error', 'R1', 'Модель пуста: начните с начального события.');
    return { issues, stats: { nodes: 0, edges: 0, errors: 1, warnings: 0 } };
  }

  const { flow, assoc, out, inc } = buildGraph(model);
  const back = findBackEdges(model, out);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const outFlow = (id) => (out.get(id) || []).filter((e) => !back.has(e.id));
  const inFlow  = (id) => (inc.get(id) || []).filter((e) => !back.has(e.id));

  const starts = nodes.filter((n) => inFlow(n.id).length === 0 && CONTROL.has(n.type));
  const ends   = nodes.filter((n) => outFlow(n.id).length === 0 && CONTROL.has(n.type));

  /* --- R7 / R8: висячие элементы и степени вершин ---------------------- */
  for (const n of nodes) {
    const inD = inFlow(n.id).length;
    const outD = outFlow(n.id).length;
    const inAll = (inc.get(n.id) || []).length;
    const outAll = (out.get(n.id) || []).length;

    if (ATTACH.has(n.type)) {
      if (inAll + outAll > 0) {
        add('error', 'R4',
          `«${n.label || n.type}» — это орг. единица/данные: их нельзя включать в контрольный поток, только привязывать к функции.`,
          [n.id]);
      }
      continue;
    }

    if (inAll === 0 && outAll === 0) {
      add('error', 'R7', `Элемент «${n.label || n.type}» ни с чем не соединён.`, [n.id]);
      continue;
    }

    if (inD === 0 && outD === 0 && back.size) {
      add('error', 'R7', `Элемент «${n.label || n.type}» участвует только в обратной связи.`, [n.id]);
      continue;
    }

    if (n.type === 'event' || n.type === 'interface') {
      if (inD > 1) {
        add('error', 'R8',
          `У события «${n.label}» ${inD} входа. Событие имеет ровно один вход — несколько ветвей сводятся оператором.`,
          [n.id]);
      }
      if (outD > 1) {
        add('error', 'R8',
          `У события «${n.label}» ${outD} выхода. Разветвление делается оператором, а не самим событием.`,
          [n.id]);
      }
      if (n.type === 'interface' && inD + outD !== 1) {
        add('error', 'R1',
          `Интерфейс процесса «${n.label}» должен иметь ровно одну связь (вход или выход).`, [n.id]);
      }
    }

    if (n.type === 'function') {
      if (inD !== 1) {
        add(inD === 0 ? 'error' : 'error', 'R8',
          `У функции «${n.label}» ${inD} входа. Функция запускается ровно одним событием/оператором.`,
          [n.id]);
      }
      if (outD !== 1) {
        add('error', 'R8',
          `У функции «${n.label}» ${outD} выхода. Функция даёт ровно одно событие-результат.`,
          [n.id]);
      }
    }
  }

  /* --- R1: начало и конец -------------------------------------------- */
  if (!starts.length) {
    add('error', 'R1', 'Не найдено начальное событие (элемент без входа).');
  } else if (starts.length > 1) {
    add('warn', 'R1',
      `Найдено ${starts.length} начальных элементов. Обычно процесс начинается с одного события.`,
      starts.map((n) => n.id));
  }
  if (!ends.length) {
    add('error', 'R1', 'Не найдено конечное событие (элемент без выхода).');
  }

  /* --- R2: чередование событий и функций ------------------------------ */
  for (const e of flow) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const key = `${a.type}>${b.type}`;
    if (!ALLOWED_FLOW.has(key)) {
      let msg;
      if (a.type === 'event' && b.type === 'event')
        msg = `Два события подряд: «${a.label}» → «${b.label}». Между событиями должна быть функция.`;
      else if (a.type === 'function' && b.type === 'function')
        msg = `Две функции подряд: «${a.label}» → «${b.label}». Между функциями должно быть событие.`;
      else if (OPERATORS.has(a.type) && OPERATORS.has(b.type))
        msg = 'Два оператора подряд: операторы нельзя связывать напрямую, между ними должен быть элемент.';
      else
        msg = `Недопустимая связь «${a.label || a.type}» → «${b.label || b.type}».`;
      add('error', 'R2', msg, [a.id, b.id], [e.id]);
    }
  }

  /* --- R3: арность операторов ---------------------------------------- */
  for (const n of nodes) {
    if (!OPERATORS.has(n.type)) continue;
    const inD = inFlow(n.id).length;
    const outD = outFlow(n.id).length;
    if (inD === 0 || outD === 0) {
      add('error', 'R3', `Оператор ${n.type.toUpperCase()} не имеет ${inD === 0 ? 'входа' : 'выхода'}.`, [n.id]);
      continue;
    }
    if (inD === 1 && outD === 1) {
      add('error', 'R3', `Оператор ${n.type.toUpperCase()} с одним входом и одним выходом не нужен — уберите его.`, [n.id]);
    }
    if (inD >= 2 && outD >= 2) {
      add('error', 'R3',
        `Оператор ${n.type.toUpperCase()} одновременно сводит ${inD} входа и разветвляет ${outD} выхода — так нельзя: разделите split и join.`,
        [n.id]);
    }
  }

  /* --- R4: привязки орг. единиц и данных ----------------------------- */
  for (const e of assoc) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ok = (ATTACH.has(a.type) && b.type === 'function') ||
               (ATTACH.has(b.type) && a.type === 'function');
    if (!ok) {
      add('error', 'R4',
        `Связь «${a.label || a.type}» — «${b.label || b.type}»: орг. единицы и данные/документы привязываются только к функциям.`,
        [a.id, b.id], [e.id]);
    }
  }
  for (const n of nodes) {
    if (!ATTACH.has(n.type)) continue;
    const links = assoc.filter((e) => e.from === n.id || e.to === n.id);
    if (links.length === 0) {
      add('warn', 'R4', `«${n.label || n.type}» ни к чему не привязан — соедините с функцией.`, [n.id]);
    }
    if (links.length > 1) {
      add('warn', 'R4', `«${n.label || n.type}» привязан к нескольким функциям — обычно достаточно одной.`, [n.id]);
    }
  }

  /* --- R5: соответствие split ↔ join --------------------------------- */
  for (const s of nodes) {
    if (!OPERATORS.has(s.type)) continue;
    const branches = outFlow(s.id).map((e) => e.to);
    if (branches.length < 2) continue;

    const reach = branches.map((b) => reachableFrom([b], out, back));
    const common = nodes.filter((n) => reach.every((r) => r.has(n.id)));
    if (!common.length) continue; // ветви расходятся к разным концам — допустимо

    // ближайший общий узел (минимальное суммарное расстояние)
    const dist = (fromId, toId) => { console.log('DIST', fromId, toId, typeof fromId, JSON.stringify(out.get(fromId)));
      const seen = new Set([fromId]);
      let frontier = [fromId];
      let d = 0;
      while (frontier.length) {
        if (frontier.includes(toId)) return d;
        const next = [];
        for (const id of frontier) {
          for (const e of out.get(id) || []) {
            if (back.has(e.id) || seen.has(e.to)) continue;
            seen.add(e.to);
            next.push(e.to);
          }
        }
        frontier = next;
        d += 1;
      }
      return Infinity;
    };
    let best = null;
    let bestCost = Infinity;
    for (const c of common) {
      const cost = branches.reduce((acc, b) => acc + dist(b, c), 0);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (!best) continue;

    if (!OPERATORS.has(best.type)) {
      add('error', 'R5',
        `Ветви ${s.type.toUpperCase()}-split сходятся в «${best.label}» без join-оператора. Поставьте ${s.type.toUpperCase()}-join.`,
        [s.id, best.id]);
      continue;
    }
    if (best.type !== s.type) {
      add('error', 'R5',
        `Split ${s.type.toUpperCase()} и join ${best.type.toUpperCase()} не совпадают: ветви, разведённые ${s.type.toUpperCase()}, сводятся только ${s.type.toUpperCase()}-join.`,
        [s.id, best.id]);
    }
    if (inFlow(best.id).length < 2) {
      add('error', 'R5', `Join «${best.label}» должен иметь минимум два входа.`, [best.id]);
    }
  }

  /* --- R6: достижимость ---------------------------------------------- */
  if (starts.length) {
    const seen = reachableFrom(starts.map((n) => n.id), out, null);
    for (const n of nodes) {
      if (CONTROL.has(n.type) && !seen.has(n.id)) {
        add('error', 'R6', `Элемент «${n.label || n.type}» недостижим из начального события.`, [n.id]);
      }
    }
  }

  /* --- R10: обратные связи ------------------------------------------- */
  if (back.size) {
    const loopNodes = new Set();
    for (const e of flow) if (back.has(e.id)) { loopNodes.add(e.from); loopNodes.add(e.to); }
    const hasControlFunction = [...loopNodes].some((id) => byId.get(id)?.type === 'function');
    add(hasControlFunction ? 'info' : 'warn', 'R10',
      hasControlFunction
        ? 'Обнаружена обратная связь (Rückschleife) — это допустимо, если цикл осмыслен.'
        : 'Обратная связь без функции внутри цикла: по материалу Rückschleife должна содержать контрольную функцию.',
      [...loopNodes]);
  }

  /* --- R9: имена ------------------------------------------------------ */
  const seenLabels = new Map();
  for (const n of nodes) {
    const label = (n.label || '').trim();
    if (!label) {
      add('error', 'R9', `У элемента (${NODE_TYPES[n.type]?.ru || n.type}) нет названия.`, [n.id]);
      continue;
    }
    const key = label.toLowerCase();
    if (seenLabels.has(key)) {
      add('warn', 'R9', `Название «${label}» встречается несколько раз.`, [n.id, seenLabels.get(key)]);
    } else seenLabels.set(key, n.id);

    if (n.type === 'event' || n.type === 'interface') {
      const hasState = /\b(ist|sind|wurde|wurden|liegt|liegen|hat|haben|kann|können|nicht)\b/i.test(label);
      const looksVerb = /(en|ern|eln)$/i.test(label.split(/\s+/).pop() || '');
      if (!hasState && looksVerb) {
        add('warn', 'R9',
          `Событие «${label}» описывает действие. Событие — это состояние: «… ist geprüft», «… liegt vor».`,
          [n.id]);
      }
    }
    if (n.type === 'function') {
      const last = (label.split(/\s+/).pop() || '');
      if (!/(en|ern|eln)$/i.test(last)) {
        add('warn', 'R9', `Функцию называют в инфинитиве: «${label}» → например «… prüfen».`, [n.id]);
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warn').length;
  return { issues, stats: { nodes: nodes.length, edges: model.edges.length, errors, warnings, backEdges: back.size } };
}

/* --------------------------------------------------- сравнение с эталоном */

export function normalizeLabel(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const tx = new Set(x.split(' '));
  const ty = new Set(y.split(' '));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter += 1;
  const jac = inter / (tx.size + ty.size - inter || 1);
  return Math.max(lev, jac * 0.95);
}

function bestLabelScore(node, refNode) {
  const candidates = [refNode.label, ...(refNode.alts || [])];
  return Math.max(...candidates.map((c) => similarity(node.label, c)));
}

/**
 * Сравнение модели пользователя с эталоном.
 * Сопоставление узлов — по типу и похожести названия, затем проверяются рёбра.
 */
export function compare(model, reference) {
  const m = normalize(model);
  const ref = normalize(reference);
  const issues = [];
  const add = (level, message, nodeIds = [], edgeIds = []) =>
    issues.push({ level, rule: 'SOL', message, nodeIds, edgeIds });

  const pairs = [];
  for (const rn of ref.nodes) {
    for (const un of m.nodes) {
      if (un.type !== rn.type) continue;
      pairs.push({ rn, un, score: bestLabelScore(un, rn) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedRef = new Set();
  const usedUser = new Set();
  const map = new Map(); // refNodeId -> userNodeId

  for (const p of pairs) {
    if (p.score < 0.45) continue;
    if (usedRef.has(p.rn.id) || usedUser.has(p.un.id)) continue;
    usedRef.add(p.rn.id);
    usedUser.add(p.un.id);
    map.set(p.rn.id, p.un.id);
    if (p.score < 0.72) {
      add('warn', `«${p.un.label}» соответствует эталонному «${p.rn.label}», но название отличается.`, [p.un.id]);
    }
  }

  const missing = ref.nodes.filter((n) => !usedRef.has(n.id));
  const extra = m.nodes.filter((n) => !usedUser.has(n.id));

  for (const n of missing) {
    add('error', `Не хватает элемента: ${NODE_TYPES[n.type]?.ru || n.type} «${n.label}».`);
  }
  for (const n of extra) {
    add('warn', `Лишний элемент: ${NODE_TYPES[n.type]?.ru || n.type} «${n.label || '—'}».`, [n.id]);
  }

  const userEdgeKey = (a, b, kind) => `${a}|${b}|${kind}`;
  const userEdges = new Set(m.edges.map((e) => userEdgeKey(e.from, e.to, e.kind)));

  let matchedEdges = 0;
  for (const re of ref.edges) {
    const uf = map.get(re.from);
    const ut = map.get(re.to);
    if (!uf || !ut) continue;
    const kind = re.kind === 'assoc' ? 'assoc' : 'flow';
    if (userEdges.has(userEdgeKey(uf, ut, kind))) matchedEdges += 1;
    else {
      const a = ref.nodes.find((n) => n.id === re.from);
      const b = ref.nodes.find((n) => n.id === re.to);
      add('error',
        `Нет связи «${a?.label || '?'}» → «${b?.label || '?'}»${kind === 'assoc' ? ' (привязка)' : ''}.`,
        [uf, ut]);
    }
  }

  const refEdgeCount = ref.edges.length || 1;
  const nodeScore = map.size / (ref.nodes.length || 1);
  const edgeScore = matchedEdges / refEdgeCount;
  const penalty = Math.min(0.25, extra.length * 0.03);
  const score = Math.max(0, Math.min(1, 0.45 * nodeScore + 0.55 * edgeScore - penalty));

  return {
    issues,
    score,
    percent: Math.round(score * 100),
    missing: missing.length,
    extra: extra.length,
    matchedNodes: map.size,
    totalNodes: ref.nodes.length,
    matchedEdges,
    totalEdges: ref.edges.length,
  };
}

/* ------------------------------------------------------------- раскладка */

export function autoLayout(rawModel, opts = {}) {
  const model = normalize(rawModel);
  const { out, inc } = buildGraph(model);
  const back = findBackEdges(model, out);
  const rank = new Map(model.nodes.map((n) => [n.id, 0]));

  // длиннейший путь по не-обратным рёбрам (алгоритм Кана)
  const indeg = new Map(model.nodes.map((n) => [n.id, 0]));
  for (const e of model.edges) {
    if (e.kind === 'assoc' || back.has(e.id)) continue;
    if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const queue = model.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of out.get(id) || []) {
      if (back.has(e.id)) continue;
      const r = Math.max(rank.get(e.to) ?? 0, (rank.get(id) ?? 0) + 1);
      rank.set(e.to, r);
      indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }

  const columns = new Map();
  for (const n of model.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(n);
  }

  const gapX = opts.gapX || 250;
  const gapY = opts.gapY || 118;
  const maxRows = Math.max(...[...columns.values()].map((c) => c.length), 1);
  const height = Math.max(opts.minHeight || 520, maxRows * gapY + 120);

  const pos = new Map();
  for (const [r, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const total = list.length;
    list.forEach((n, i) => {
      const y = height / 2 + (i - (total - 1) / 2) * gapY;
      pos.set(n.id, { x: 120 + r * gapX, y });
    });
  }

  // привязанные элементы (орг. единицы, данные) — рядом со своей функцией
  for (const n of model.nodes) {
    if (!ATTACH.has(n.type)) continue;
    const link = model.edges.find((e) => e.kind === 'assoc' && (e.from === n.id || e.to === n.id));
    if (!link) continue;
    const fnId = link.from === n.id ? link.to : link.from;
    const base = pos.get(fnId);
    if (!base) continue;
    const sameFn = model.nodes.filter((m) => ATTACH.has(m.type) &&
      model.edges.some((e) => e.kind === 'assoc' && ((e.from === m.id && e.to === fnId) || (e.to === m.id && e.from === fnId))));
    const idx = sameFn.findIndex((m) => m.id === n.id);
    pos.set(n.id, { x: base.x - 40 + (idx % 2) * 30, y: base.y - 120 - Math.floor(idx / 2) * 84 });
  }

  return {
    nodes: model.nodes.map((n) => ({ ...n, ...(pos.get(n.id) || { x: 120, y: 120 }) })),
    edges: model.edges,
  };
}

export function boundsOf(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of model.nodes) {
    const w = NODE_W, h = NODE_H;
    minX = Math.min(minX, n.x - w / 2);
    maxX = Math.max(maxX, n.x + w / 2);
    minY = Math.min(minY, n.y - h / 2);
    maxY = Math.max(maxY, n.y + h / 2);
  }
  if (!model.nodes.length) return { x: 0, y: 0, w: 900, h: 600 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
