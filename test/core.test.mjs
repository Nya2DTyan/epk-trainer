import { validate, compare, autoLayout, emptyModel, normalize } from '../js/core.js';
import { TASKS } from '../js/tasks.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

console.log('=== 1. Эталоны: проверка синтаксиса ===');
for (const t of TASKS) {
  const ref = normalize(t.reference);
  const laid = autoLayout(ref);
  const v = validate(laid);
  const errs = v.issues.filter((i) => i.level === 'error');
  console.log(`\n[${t.id}] nodes=${v.stats.nodes} edges=${v.stats.edges} errors=${errs.length} warns=${v.stats.warnings}`);
  for (const e of errs) console.log('   ERROR', e.rule, e.message);
  ok(errs.length === 0, `${t.id}: эталон проходит проверку без ошибок`);
}

console.log('\n=== 2. Эталон против самого себя ===');
for (const t of TASKS) {
  const r = compare(t.reference, t.reference);
  ok(r.percent === 100, `${t.id}: 100% (получено ${r.percent}%)`);
}

console.log('\n=== 3. Пустая модель ===');
{
  const v = validate(emptyModel());
  ok(v.issues.length > 0, 'пустая модель даёт замечание');
  const c = compare(emptyModel(), TASKS[0].reference);
  ok(c.percent === 0, `сравнение с пустой = 0% (получено ${c.percent}%)`);
}

console.log('\n=== 4. Типичные ошибки студентов ===');
const base = TASKS[0].reference;
{
  // дубликат той же связи
  const m = { nodes: base.nodes, edges: [
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'e2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R7' && /дважды/.test(i.message)), 'дубликат связи → R7');
}
{
  // обратная связь без контрольной функции
  const m = { nodes: base.nodes, edges: [
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'e2', kind: 'flow' },
    { from: 'e2', to: 'f1', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R10'), 'обратная связь распознана → R10');
}
{
  // событие с двумя выходами без оператора
  const m = { nodes: [...base.nodes, { id: 'e3', type: 'event', label: 'Extra ist da' }], edges: [
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'e1', to: 'e3', kind: 'flow' },
    { from: 'f1', to: 'e2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R8'), 'событие с двумя выходами → R8');
}
{
  // XOR-split без join
  const m = { nodes: [
    { id: 'e1', type: 'event', label: 'A ist da' },
    { id: 'f1', type: 'function', label: 'x prüfen' },
    { id: 'o1', type: 'xor', label: 'XOR' },
    { id: 'e2', type: 'event', label: 'B ist da' },
    { id: 'e3', type: 'event', label: 'C ist da' },
    { id: 'f2', type: 'function', label: 'y bearbeiten' },
  ], edges: [
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'o1', kind: 'flow' },
    { from: 'o1', to: 'e2', kind: 'flow' },
    { from: 'o1', to: 'e3', kind: 'flow' },
    { from: 'e2', to: 'f2', kind: 'flow' },
    { from: 'e3', to: 'f2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R5'), 'ветви без join → R5');
}
{
  // split XOR + join UND
  const m = { nodes: [
    { id: 'e1', type: 'event', label: 'A ist da' },
    { id: 'o1', type: 'xor', label: 'XOR' },
    { id: 'e2', type: 'event', label: 'B ist da' },
    { id: 'e3', type: 'event', label: 'C ist da' },
    { id: 'o2', type: 'and', label: 'UND' },
    { id: 'f1', type: 'function', label: 'x bearbeiten' },
    { id: 'e4', type: 'event', label: 'D ist da' },
  ], edges: [
    { from: 'e1', to: 'o1', kind: 'flow' },
    { from: 'o1', to: 'e2', kind: 'flow' },
    { from: 'o1', to: 'e3', kind: 'flow' },
    { from: 'e2', to: 'o2', kind: 'flow' },
    { from: 'e3', to: 'o2', kind: 'flow' },
    { from: 'o2', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'e4', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R5' && /не совпадают/.test(i.message)), 'XOR-split + UND-join → R5');
}
{
  // орг. единица в контрольном потоке
  const m = { nodes: [...base.nodes, { id: 'g1', type: 'org', label: 'Vertrieb' }], edges: [
    ...base.edges, { from: 'f1', to: 'g1', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R4'), 'орг. единица в потоке → R4');
}
{
  // недостижимый элемент
  const m = { nodes: [...base.nodes, { id: 'x1', type: 'event', label: 'Waise ist da' }, { id: 'x2', type: 'function', label: 'warten' }], edges: [
    ...base.edges, { from: 'x1', to: 'x2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R6'), 'недостижимый фрагмент → R6');
}
{
  // оператор 1-в-1
  const m = { nodes: [
    { id: 'e1', type: 'event', label: 'A ist da' },
    { id: 'o1', type: 'or', label: 'ODER' },
    { id: 'f1', type: 'function', label: 'x tun' },
    { id: 'e2', type: 'event', label: 'B ist da' },
  ], edges: [
    { from: 'e1', to: 'o1', kind: 'flow' },
    { from: 'o1', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'e2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R3'), 'оператор 1→1 → R3');
}
{
  // событие названо глаголом
  const m = { nodes: [
    { id: 'e1', type: 'event', label: 'Material liefern' },
    { id: 'f1', type: 'function', label: 'Qualitätsprüfung durchführen' },
    { id: 'e2', type: 'event', label: 'Qualität ist geprüft' },
  ], edges: [
    { from: 'e1', to: 'f1', kind: 'flow' },
    { from: 'f1', to: 'e2', kind: 'flow' },
  ]};
  const v = validate(m);
  ok(v.issues.some((i) => i.rule === 'R9'), 'событие-действие → R9');
}

console.log('\n=== 5. Сравнение с эталоном: частичные модели ===');
{
  const m = { nodes: base.nodes.slice(0, 2), edges: [{ from: 'e1', to: 'f1', kind: 'flow' }] };
  const c = compare(m, base);
  ok(c.percent > 0 && c.percent < 100, `неполная модель: ${c.percent}% (0 < x < 100)`);
  ok(c.missing === 1, `не хватает 1 элемента (получено ${c.missing})`);
}
{
  const m = { nodes: base.nodes.map((n) => ({ ...n })), edges: base.edges.map((e) => ({ ...e })) };
  m.nodes[0].label = 'Material ist angeliefert';
  const c = compare(m, base);
  ok(c.percent === 100, `синоним названия принимается: ${c.percent}%`);
}
{
  const m = { nodes: base.nodes.map((n) => ({ ...n })), edges: [] };
  const c = compare(m, base);
  ok(c.percent < 60, `все узлы без связей: ${c.percent}%`);
}

console.log('\n=== 6. autoLayout ===');
for (const t of TASKS) {
  const l = autoLayout(t.reference);
  const xs = l.nodes.map((n) => n.x);
  ok(xs.every((x) => Number.isFinite(x)), `${t.id}: координаты конечны`);
  const uniq = new Set(l.nodes.map((n) => `${Math.round(n.x)}:${Math.round(n.y)}`));
  ok(uniq.size === l.nodes.length, `${t.id}: нет наложений (${uniq.size}/${l.nodes.length})`);
}

console.log(`\n${fail === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ПРОВАЛОВ: ' + fail}`);
process.exit(fail ? 1 : 0);
