/* Рендер эталонных решений в PNG — визуальная проверка читаемости схем. */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bundle = fs.readFileSync('/tmp/app.bundle.js', 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, x: 0, y: 0 });
window.SVGElement.prototype.getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
window.URL.createObjectURL = () => 'blob:fake';
window.eval(bundle);

const outDir = '/root/epk-trainer/preview';
fs.mkdirSync(outDir, { recursive: true });

const CSS = `
  .node .shape { stroke-width: 1.8; }
  .node.event .shape { fill: rgba(126,231,135,.10); stroke: #7ee787; }
  .node.function .shape { fill: rgba(121,192,255,.12); stroke: #79c0ff; }
  .node.and .shape, .node.or .shape, .node.xor .shape { fill: rgba(210,168,255,.14); stroke: #d2a8ff; }
  .node.org .shape { fill: rgba(255,166,87,.12); stroke: #ffa657; }
  .node.data .shape { fill: rgba(255,216,102,.12); stroke: #ffd866; }
  .node.interface .shape { fill: rgba(86,212,221,.12); stroke: #56d4dd; }
  .node .label { font-family: sans-serif; font-size: 11.5px; font-weight: 500; fill: #e6edf3; text-anchor: middle; dominant-baseline: middle; }
  .node.and .label, .node.or .label, .node.xor .label { font-size: 15px; font-weight: 700; fill: #d2a8ff; }
`;

for (const t of window.__epk.TASKS) {
  let svg = window.__epk.solutionSvg(t.id);
  svg = svg.replace('<defs>', `<defs><style>${CSS}</style>`);
  svg = svg.replace(/ style="background:#0d1117;border-radius:8px"/, ' style="background:#0d1117"');
  const svgPath = path.join(outDir, `${t.id}.svg`);
  fs.writeFileSync(svgPath, svg);
  try {
    execFileSync('python3', ['-c', `
import cairosvg, sys
cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2], scale=1.6, background_color='#0d1117')
`, svgPath, path.join(outDir, `${t.id}.png`)]);
    console.log('ok', t.id);
  } catch (e) {
    console.log('fail', t.id, String(e.message).slice(0, 200));
  }
}
