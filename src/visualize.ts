/**
 * Renders `dependency_graph.json` (produced by generate.ts) as a single self-contained
 * `graph.html` file: the graph data is embedded inline (no fetch, no CDN, works from a plain
 * double-click or `file://`), and a small force-directed layout draws nodes as circles
 * (colored/grouped by `service`) with directed, labeled edges between them.
 *
 * Usage: node --import tsx src/visualize.ts [path/to/dependency_graph.json] [out.html]
 */
import { readFileSync, writeFileSync } from "fs";

const IN_PATH = process.argv[2] ?? "dependency_graph.json";
const OUT_PATH = process.argv[3] ?? "graph.html";

const graph = JSON.parse(readFileSync(IN_PATH, "utf-8"));

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>dependency graph</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d12; color: #e6e6e6; font-family: ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #hud { position: fixed; top: 10px; left: 10px; z-index: 2; background: rgba(20,22,30,0.85); padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.5; max-width: 320px; }
  #hud b { color: #fff; }
  #search { width: 100%; margin-top: 6px; padding: 4px 6px; border-radius: 4px; border: 1px solid #444; background: #1a1d26; color: #eee; box-sizing: border-box; }
  svg { display: block; width: 100vw; height: 100vh; }
  .edge { stroke: #4a5568; stroke-opacity: 0.45; fill: none; }
  .edge.hi { stroke: #ffb347; stroke-opacity: 0.95; stroke-width: 2; }
  .edge-label { fill: #8892a0; font-size: 8px; pointer-events: none; }
  .node circle { stroke: #0b0d12; stroke-width: 1.5px; cursor: pointer; }
  .node text { fill: #d5d9e0; font-size: 9px; pointer-events: none; }
  .node.dim { opacity: 0.15; }
  .edge.dim { opacity: 0.05; }
</style>
</head>
<body>
<div id="hud">
  <div><b>dependency graph</b></div>
  <div id="stats"></div>
  <input id="search" placeholder="filter by tool id or service..." />
  <div style="margin-top:6px; opacity:0.7">drag to pan &middot; scroll to zoom &middot; click a node to highlight its edges</div>
</div>
<svg></svg>
<script>
const graph = ${JSON.stringify(graph).replace(/<\/script/gi, "<\\/script")};
const nodes = graph.nodes.map(n => ({ ...n }));
const edges = graph.edges.map(e => ({ ...e }));
const byId = new Map(nodes.map(n => [n.id, n]));

document.getElementById('stats').textContent =
  nodes.length + ' nodes, ' + edges.length + ' edges';

// color by service (stable hash -> hue)
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function colorFor(service) {
  if (!service) return '#6b7280';
  const hue = hash(service) % 360;
  return 'hsl(' + hue + ', 55%, 58%)';
}

const svg = document.querySelector('svg');
const NS = 'http://www.w3.org/2000/svg';
const width = window.innerWidth, height = window.innerHeight;
const viewport = document.createElementNS(NS, 'g');
svg.appendChild(viewport);

// simple force-directed layout (no deps): repel all nodes, spring edges, center pull
const N = nodes.length;
for (const n of nodes) {
  const angle = Math.random() * Math.PI * 2;
  const r = 200 + Math.random() * Math.min(width, height) * 0.4;
  n.x = width / 2 + Math.cos(angle) * r;
  n.y = height / 2 + Math.sin(angle) * r;
  n.vx = 0; n.vy = 0;
}
const idx = new Map(nodes.map((n, i) => [n.id, i]));
const edgeIdx = edges.map(e => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a !== undefined && b !== undefined);

const ITER = Math.min(220, Math.max(80, Math.floor(30000 / Math.max(N, 1))));
for (let iter = 0; iter < ITER; iter++) {
  const k = Math.sqrt((width * height) / Math.max(N, 1)) * 0.9;
  // repulsion (grid-bucketed would be better; N~900 is fine brute-force for a handful of passes)
  for (let i = 0; i < N; i++) {
    let fx = 0, fy = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
      let d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 90000) continue; // ignore far pairs for speed
      const d = Math.sqrt(d2);
      const f = (k * k) / d;
      fx += (dx / d) * f * 0.02;
      fy += (dy / d) * f * 0.02;
    }
    nodes[i].vx += fx; nodes[i].vy += fy;
  }
  for (const [a, b] of edgeIdx) {
    const dx = nodes[b].x - nodes[a].x, dy = nodes[b].y - nodes[a].y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - k) * 0.01;
    nodes[a].vx += (dx / d) * f; nodes[a].vy += (dy / d) * f;
    nodes[b].vx -= (dx / d) * f; nodes[b].vy -= (dy / d) * f;
  }
  for (const n of nodes) {
    n.vx += (width / 2 - n.x) * 0.0015;
    n.vy += (height / 2 - n.y) * 0.0015;
    n.x += n.vx *= 0.82;
    n.y += n.vy *= 0.82;
  }
}

const edgeEls = edges.map(e => {
  const el = document.createElementNS(NS, 'path');
  el.setAttribute('class', 'edge');
  viewport.appendChild(el);
  return { e, el };
});
const nodeEls = nodes.map(n => {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'node');
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('r', 4 + Math.min(10, edges.filter(e => e.from === n.id || e.to === n.id).length * 0.3));
  c.setAttribute('fill', colorFor(n.service));
  const t = document.createElementNS(NS, 'text');
  t.textContent = n.id;
  t.setAttribute('x', 7);
  t.setAttribute('y', 3);
  g.appendChild(c); g.appendChild(t);
  viewport.appendChild(g);
  g.addEventListener('click', () => highlight(n.id));
  return { n, g };
});

function render() {
  for (const { e, el } of edgeEls) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    el.setAttribute('d', 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y);
  }
  for (const { n, g } of nodeEls) {
    g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
  }
}
render();

let highlighted = null;
function highlight(id) {
  highlighted = highlighted === id ? null : id;
  for (const { e, el } of edgeEls) {
    const on = highlighted && (e.from === highlighted || e.to === highlighted);
    el.classList.toggle('hi', !!on);
    el.classList.toggle('dim', !!highlighted && !on);
  }
  for (const { n, g } of nodeEls) {
    const on = !highlighted || n.id === highlighted || edges.some(e =>
      (e.from === highlighted && e.to === n.id) || (e.to === highlighted && e.from === n.id));
    g.classList.toggle('dim', !on);
  }
}

document.getElementById('search').addEventListener('input', (ev) => {
  const q = ev.target.value.trim().toUpperCase();
  for (const { n, g } of nodeEls) {
    const match = !q || n.id.includes(q) || (n.service ?? '').toUpperCase().includes(q);
    g.classList.toggle('dim', !match);
  }
  for (const { e, el } of edgeEls) {
    const match = !q || e.from.includes(q) || e.to.includes(q) || (e.label ?? '').toUpperCase().includes(q);
    el.classList.toggle('dim', !match);
  }
});

// pan/zoom
let tx = 0, ty = 0, scale = 0.55, dragging = false, lastX = 0, lastY = 0;
function applyTransform() { viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')'); }
applyTransform();
svg.addEventListener('mousedown', (ev) => { dragging = true; lastX = ev.clientX; lastY = ev.clientY; });
window.addEventListener('mouseup', () => dragging = false);
window.addEventListener('mousemove', (ev) => {
  if (!dragging) return;
  tx += ev.clientX - lastX; ty += ev.clientY - lastY;
  lastX = ev.clientX; lastY = ev.clientY;
  applyTransform();
});
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.1 : 0.9;
  scale = Math.max(0.05, Math.min(4, scale * factor));
  applyTransform();
}, { passive: false });
</script>
</body>
</html>
`;

writeFileSync(OUT_PATH, html, "utf-8");
console.error(`wrote ${OUT_PATH} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
