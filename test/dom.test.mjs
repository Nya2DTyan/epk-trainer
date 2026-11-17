/* Интерфейсный тест в jsdom: загрузка страницы, отрисовка, проверка,
   переключение заданий, экспорт SVG. Запускается на собранном бандле. */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bundle = fs.readFileSync('/tmp/app.bundle.js', 'utf8');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;
window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 100, height: 40 }; };
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, x: 0, y: 0 };
};
window.SVGElement.prototype.getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
window.confirm = () => true;
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

window.eval(bundle);

const doc = window.document;
const epk = window.__epk;

console.log('=== 1. Загрузка страницы ===');
ok(!errors.length, `нет ошибок при инициализации (${errors.join('; ') || 'чисто'})`);
ok(!!epk, 'модуль отдал состояние в window.__epk');
ok(doc.querySelectorAll('.pal-item').length === 8, `палитра: 8 элементов (${doc.querySelectorAll('.pal-item').length})`);
ok(doc.querySelectorAll('#taskSelect option').length === epk.TASKS.length, 'список заданий заполнен');
ok(doc.querySelectorAll('#legendList li').length === 8, 'легенда заполнена');

console.log('\n=== 2. Первое задание загружено ===');
ok(epk.state.model.nodes.length === 1, `стартовое событие добавлено (${epk.state.model.nodes.length})`);
ok(doc.querySelectorAll('#nodes .node').length === 1, 'один элемент на холсте');
ok(doc.querySelector('#taskTitle').textContent.includes('Materialprüfung'), 'заголовок задания подставлен');
ok(doc.querySelector('#taskText').textContent.length > 20, 'текст процесса подставлен');

console.log('\n=== 3. Добавление элементов кликом по палитре ===');
const click = (elm) => elm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const pal = (type) => doc.querySelector(`.pal-item[data-type="${type}"]`);

click(pal('function'));
click(pal('event'));
ok(epk.state.model.nodes.length === 3, `стало 3 элемента (${epk.state.model.nodes.length})`);
ok(doc.querySelectorAll('#nodes .node').length === 3, 'все три отрисованы');
ok(doc.querySelectorAll('#nodes .node.function').length === 1, 'функция отрисована своим классом');

console.log('\n=== 4. Свойства и переименование ===');
epk.state.selectedNode = epk.state.model.nodes[1].id;
epk.render();
ok(!doc.querySelector('#props').hidden, 'панель свойств открылась');
const input = doc.querySelector('#propsLabel');
input.value = 'Qualitätsprüfung durchführen';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
ok(epk.state.model.nodes[1].label === 'Qualitätsprüfung durchführen', 'название применилось к модели');
ok(doc.querySelector('#issues').textContent.length > 0, 'замечания пересчитались');

console.log('\n=== 5. Проверка: пустая модель не зачитывается ===');
epk.doCheck();
ok(!doc.querySelector('#scoreBox').hidden, 'блок оценки показался');
const pct1 = parseInt(doc.querySelector('#scoreValue').textContent, 10);
ok(pct1 < 60, `неполная модель даёт низкий балл (${pct1}%)`);

console.log('\n=== 6. Эталон загружается и проходит проверку ===');
const task = epk.TASKS[0];
const laid = epk.state.model;
// подставляем эталон как модель пользователя
laid.nodes = task.reference.nodes.map((n, i) => ({ ...n, x: 120 + i * 220, y: 240 }));
laid.edges = task.reference.edges.map((e, i) => ({ ...e, id: 'x' + i }));
epk.render();
epk.doCheck();
const pct2 = parseInt(doc.querySelector('#scoreValue').textContent, 10);
ok(pct2 === 100, `эталон даёт 100% (${pct2}%)`);
ok(doc.querySelector('#liveBadge').textContent.includes('синтаксис ок'), 'бейдж синтаксиса зелёный');
ok(doc.querySelector('#scoreMeta').textContent.includes('3'), 'в метрике видно число элементов');

console.log('\n=== 7. Ошибка ловится в интерфейсе ===');
laid.nodes.push({ id: 'bad', type: 'event', label: 'Material liefern', x: 700, y: 400 });
epk.render();
epk.doCheck();
const issuesText = doc.querySelector('#issues').textContent;
ok(/R9|R7|R6/.test(issuesText), 'замечание по новому элементу появилось');
ok(doc.querySelectorAll('#nodes .node.flagged').length >= 1, 'проблемный элемент подсвечен');

console.log('\n=== 8. Переключение задания ===');
const sel = doc.querySelector('#taskSelect');
sel.value = 'kreditantrag';
sel.dispatchEvent(new window.Event('change', { bubbles: true }));
ok(epk.state.taskId === 'kreditantrag', 'задание переключилось');
ok(doc.querySelector('#taskTitle').textContent.includes('Kreditantrag'), 'заголовок обновился');
ok(doc.querySelectorAll('#taskHints li').length >= 3, 'подсказки обновились');
ok(doc.querySelector('#scoreBox').hidden, 'блок оценки скрыт на новом задании');

console.log('\n=== 9. Автораскладка и эталон в модалке ===');
const before = epk.state.model.nodes.map((n) => `${n.x},${n.y}`).join(';');
click(doc.querySelector('#btnLayout'));
const after = epk.state.model.nodes.map((n) => `${n.x},${n.y}`).join(';');
ok(before !== after, 'автораскладка изменила координаты');

click(doc.querySelector('#btnSolution'));
ok(!doc.querySelector('#modal').hidden, 'модалка открылась');
const svgInModal = doc.querySelector('#modalBody svg');
ok(!!svgInModal, 'в модалке отрисован SVG эталона');
ok(svgInModal.querySelectorAll('.node').length === epk.TASKS.find((t) => t.id === 'kreditantrag').reference.nodes.length, 'все элементы эталона нарисованы');
ok(svgInModal.querySelectorAll('path[marker-end]').length > 0, 'связи со стрелками нарисованы');
click(doc.querySelector('#modalClose'));
ok(doc.querySelector('#modal').hidden, 'модалка закрылась');

console.log('\n=== 10. Вкладка теории ===');
click(doc.querySelector('.tab[data-view="theory"]'));
ok(!doc.querySelector('#view-theory').hidden, 'теория показана');
ok(doc.querySelector('#view-editor').hidden, 'редактор скрыт');
ok(doc.querySelectorAll('#view-theory .card').length === 8, `8 карточек правил (${doc.querySelectorAll('#view-theory .card').length})`);
click(doc.querySelector('.tab[data-view="editor"]'));
ok(!doc.querySelector('#view-editor').hidden, 'возврат в редактор');

console.log('\n=== 11. Сохранение в localStorage ===');
const stored = JSON.parse(window.localStorage.getItem('epk-trainer-v1'));
ok(!!stored, 'запись в localStorage есть');
ok(!!stored.models.kreditantrag, 'модель задания сохранена');
ok(stored.scores && stored.scores.materialpruefung === 100, 'балл сохранён');

console.log('\n=== 12. Ошибки JS за весь прогон ===');
ok(errors.length === 0, `ошибок нет (${errors.join('; ') || 'чисто'})`);

console.log(`\n${fail === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ПРОВАЛОВ: ' + fail}`);
process.exit(fail ? 1 : 0);
