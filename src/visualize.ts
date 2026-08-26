/**
 * Renders `dependency_graph.json` (produced by generate.ts) as a single self-contained
 * `graph.html` file: the graph data -- INCLUDING a precomputed force-directed layout -- is
 * embedded inline (no fetch, no CDN, works from a plain double-click or `file://`).
 *
 * The layout is computed here, in Node, at generation time, not in the browser at page-load
 * time. An earlier version ran the same force-directed iterations client-side, synchronously,
 * before first paint -- ~80 iterations x ~800k pairwise checks for an 893-node graph, which
 * blocks the main thread for long enough that the page visibly looks stuck loading. Doing the
 * same math once here (Node has no UI to block, so the cost is invisible) and shipping only
 * the final x/y coordinates means the browser has zero physics to run: it draws static SVG
 * and the page is interactive instantly. Panning/zooming/searching/highlighting all still work
 * -- there's just no per-frame simulation.
 *
 * Usage: node --import tsx src/visualize.ts [path/to/dependency_graph.json] [out.html]
 */
import { readFileSync, writeFileSync } from "fs";

const IN_PATH = process.argv[2] ?? "dependency_graph.json";
const OUT_PATH = process.argv[3] ?? "graph.html";

const graph = JSON.parse(readFileSync(IN_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// layout (computed here, in Node, once -- see file header)
// ---------------------------------------------------------------------------
type LaidOutNode = { id: string; service?: string; x: number; y: number; degree: number; r: number; label: boolean };

// Single source of truth for node circle radius (Node layout AND browser render both use
// this so the collision math below and what actually gets drawn never disagree).
function radiusFor(degree: number): number {
  return 3 + Math.min(8, Math.sqrt(degree + 1) * 1.7);
}

function computeLayout(nodes: { id: string; service?: string }[], edges: { from: string; to: string }[]) {
  const N = nodes.length;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const edgeIdx = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)] as const)
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);

  const degree = new Array(N).fill(0);
  for (const [a, b] of edgeIdx) { degree[a]++; degree[b]++; }
  const radius = degree.map(radiusFor);

  const extent = 320 + Math.sqrt(N) * 34; // scales with node count so it isn't a tight ball
  const x = new Array(N), y = new Array(N), vx = new Array(N).fill(0), vy = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + Math.random() * 0.4;
    const r = extent * (0.25 + 0.75 * Math.random());
    x[i] = Math.cos(angle) * r;
    y[i] = Math.sin(angle) * r;
  }

  const SPRING_LENGTH = 95;
  const ITERATIONS = 320;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const cool = 1 - iter / ITERATIONS; // simulated annealing: big moves early, fine settling late
    for (let i = 0; i < N; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = x[i] - x[j], dy = y[i] - y[j];
        const d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 250000) continue; // 500-unit cutoff keeps this fast without sacrificing spread
        const d = Math.sqrt(d2);
        // General long-range repulsion, PLUS a much sharper short-range push once circles
        // would actually overlap on screen (d < combined radius + padding) -- the general
        // 1/d^2 term alone is too soft at close range to reliably keep touching nodes apart,
        // which is what was producing visibly overlapping circles.
        let f = 16000 / d2;
        const minSep = radius[i] + radius[j] + 14;
        if (d < minSep) f += (minSep - d) * 40;
        fx += (dx / d) * f; fy += (dy / d) * f;
      }
      vx[i] += fx * cool; vy[i] += fy * cool;
    }
    for (const [a, b] of edgeIdx) {
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - SPRING_LENGTH) * 0.02;
      vx[a] += (dx / d) * f; vy[a] += (dy / d) * f;
      vx[b] -= (dx / d) * f; vy[b] -= (dy / d) * f;
    }
    for (let i = 0; i < N; i++) {
      vx[i] += -x[i] * 0.0007; vy[i] += -y[i] * 0.0007;
      x[i] += vx[i] *= 0.8;
      y[i] += vy[i] *= 0.8;
    }
  }

  const scale = Math.max(0.15, Math.min(0.85, 700 / extent));

  // Deterministic label decluttering: greedily pick nodes (highest degree first) to always
  // show a label for, but only accept one if its approximate on-screen text bounding box
  // (in the SAME projected `scale` the browser opens at) doesn't overlap an already-accepted
  // label's box. This is computed once, here, against exact final coordinates -- guaranteed
  // no overlap at the default view, unlike blindly labeling "top N by degree" regardless of
  // where those N nodes actually ended up relative to each other.
  const order = [...Array(N).keys()].sort((a, b) => degree[b] - degree[a]);
  const accepted: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const labelOk = new Array(N).fill(false);
  const MAX_LABELS = 40;
  for (const i of order) {
    if (accepted.length >= MAX_LABELS) break;
    const sx = x[i] * scale, sy = y[i] * scale;
    const fontPx = 9 * scale;
    const w = fontPx * 0.58 * nodes[i].id.length;
    const h = fontPx * 1.3;
    const box = { x0: sx + radius[i] * scale, y0: sy - h / 2, x1: sx + radius[i] * scale + w + 6, y1: sy + h / 2 };
    const overlaps = accepted.some(
      (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0,
    );
    if (!overlaps) { accepted.push(box); labelOk[i] = true; }
  }

  const laidOut: LaidOutNode[] = nodes.map((n, i) => ({
    id: n.id, service: n.service, x: Math.round(x[i]), y: Math.round(y[i]),
    degree: degree[i], r: Math.round(radius[i] * 10) / 10, label: labelOk[i],
  }));
  return { nodes: laidOut, scale };
}

const { nodes: laidOutNodes, scale: initialScale } = computeLayout(graph.nodes, graph.edges);

// ---------------------------------------------------------------------------
// HTML (browser side does rendering + interaction only, no physics)
// ---------------------------------------------------------------------------
const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>dependency graph</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0a0b0d; color: #e6e6e6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; overflow: hidden; }
  svg { display: block; width: 100vw; height: 100vh; cursor: grab; }
  svg.dragging { cursor: grabbing; }
  #hud { position: fixed; top: 12px; left: 12px; z-index: 2; background: rgba(18,20,24,0.88); backdrop-filter: blur(6px); padding: 12px 16px; border-radius: 10px; font-size: 13px; line-height: 1.55; max-width: 300px; border: 1px solid rgba(255,255,255,0.08); }
  #hud b { color: #fff; font-size: 14px; }
  #search { width: 100%; margin-top: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid #3a3f47; background: #16181c; color: #eee; box-sizing: border-box; font-size: 13px; }
  #search:focus { outline: none; border-color: #6c8cff; }
  .hint { margin-top: 8px; opacity: 0.55; font-size: 11px; line-height: 1.5; }
  #legend { position: fixed; bottom: 12px; left: 12px; z-index: 2; background: rgba(18,20,24,0.88); border-radius: 10px; padding: 10px 14px; font-size: 11px; max-height: 40vh; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); }
  #legend .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; opacity: 0.85; }
  #legend .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .edge { stroke: #4a5568; stroke-opacity: 0.28; fill: none; stroke-width: 0.7; }
  .edge.hi { stroke: #ffb347; stroke-opacity: 0.95; stroke-width: 1.6; }
  .edge.dim { stroke-opacity: 0.03; }
  .node circle { stroke: #0a0b0d; stroke-width: 1.2px; cursor: pointer; }
  .node text { fill: #dfe3e8; font-size: 9px; pointer-events: none; opacity: 0; transition: opacity 0.1s; }
  .node.label text, .node:hover text, .node.hi text, .node.match text { opacity: 0.9; }
  .node.hi text { fill: #fff; font-weight: 600; }
  .node.dim circle { opacity: 0.15; }
  .node.dim text { opacity: 0 !important; }
</style>
</head>
<body>
<div id="hud">
  <div><b>dependency graph</b></div>
  <div id="stats" style="opacity:0.7; margin-top:2px;"></div>
  <input id="search" placeholder="filter by tool id or service..." />
  <div class="hint">drag to pan &middot; scroll to zoom &middot; click a node to highlight its edges &middot; labels appear on hover / for hub nodes / on search match</div>
</div>
<div id="legend"></div>
<svg><g id="viewport"></g></svg>
<script>
const nodes = ${JSON.stringify(laidOutNodes)};
const rawEdges = ${JSON.stringify(graph.edges)};
const byId = new Map(nodes.map(n => [n.id, n]));

document.getElementById('stats').textContent = nodes.length + ' nodes, ' + rawEdges.length + ' edges';

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function colorFor(service) {
  if (!service) return 'hsl(220, 8%, 55%)';
  return 'hsl(' + (hash(service) % 360) + ', 60%, 62%)';
}

const services = [...new Set(nodes.map(n => n.service).filter(Boolean))];
const topServices = services
  .map(s => ({ s, n: nodes.filter(n => n.service === s).length }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 18);
document.getElementById('legend').innerHTML =
  '<div style="opacity:0.6;margin-bottom:4px;">service (top ' + topServices.length + ')</div>' +
  topServices.map(({ s, n }) => '<div class="row"><span class="dot" style="background:' + colorFor(s) + '"></span>' + s + ' (' + n + ')</div>').join('');

const NS = 'http://www.w3.org/2000/svg';
const svg = document.querySelector('svg');
const viewport = document.getElementById('viewport');

const edgeEls = rawEdges.map(e => {
  const a = byId.get(e.from), b = byId.get(e.to);
  const el = document.createElementNS(NS, 'path');
  el.setAttribute('class', 'edge');
  if (a && b) el.setAttribute('d', 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y);
  viewport.appendChild(el);
  return { e, el };
});
const nodeEls = nodes.map(n => {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'node' + (n.label ? ' label' : ''));
  g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('r', String(n.r));
  c.setAttribute('fill', colorFor(n.service));
  const t = document.createElementNS(NS, 'text');
  t.textContent = n.id;
  t.setAttribute('x', String(n.r + 4)); t.setAttribute('y', '3');
  g.appendChild(c); g.appendChild(t);
  viewport.appendChild(g);
  g.addEventListener('click', (ev) => { ev.stopPropagation(); highlight(n.id); });
  return { n, g };
});

let highlighted = null;
function highlight(id) {
  highlighted = highlighted === id ? null : id;
  for (const { e, el } of edgeEls) {
    const on = highlighted && (e.from === highlighted || e.to === highlighted);
    el.classList.toggle('hi', !!on);
    el.classList.toggle('dim', !!highlighted && !on);
  }
  for (const { n, g } of nodeEls) {
    const on = !highlighted || n.id === highlighted || rawEdges.some(e =>
      (e.from === highlighted && e.to === n.id) || (e.to === highlighted && e.from === n.id));
    g.classList.toggle('dim', !on);
    g.classList.toggle('hi', n.id === highlighted);
  }
}
svg.addEventListener('click', () => { if (highlighted) highlight(highlighted); });

document.getElementById('search').addEventListener('input', (ev) => {
  const q = ev.target.value.trim().toUpperCase();
  for (const { n, g } of nodeEls) {
    const match = !!q && (n.id.includes(q) || (n.service ?? '').toUpperCase().includes(q));
    g.classList.toggle('dim', !!q && !match);
    g.classList.toggle('match', match);
  }
  for (const { e, el } of edgeEls) {
    const match = !q || e.from.includes(q) || e.to.includes(q) || (e.label ?? '').toUpperCase().includes(q);
    el.classList.toggle('dim', !!q && !match);
  }
});

// pan/zoom -- initial scale must match the value computeLayout() used in src/visualize.ts to
// pick non-overlapping labels; it's embedded as a literal (not recomputed here) so the two
// can never drift out of sync.
let tx = 0, ty = 0, scale = ${initialScale};
let dragging = false, lastX = 0, lastY = 0, moved = false;
function applyTransform() { viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')'); }
tx = window.innerWidth / 2; ty = window.innerHeight / 2;
applyTransform();
svg.addEventListener('mousedown', (ev) => { dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; svg.classList.add('dragging'); });
window.addEventListener('mouseup', () => { dragging = false; svg.classList.remove('dragging'); });
window.addEventListener('mousemove', (ev) => {
  if (!dragging) return;
  tx += ev.clientX - lastX; ty += ev.clientY - lastY;
  lastX = ev.clientX; lastY = ev.clientY;
  moved = true;
  applyTransform();
});
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY < 0 ? 1.12 : 0.89;
  scale = Math.max(0.03, Math.min(6, scale * factor));
  applyTransform();
}, { passive: false });
</script>
</body>
</html>
`;

writeFileSync(OUT_PATH, html, "utf-8");
console.error(`wrote ${OUT_PATH} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
