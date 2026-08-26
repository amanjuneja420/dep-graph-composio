/**
 * Renders `dependency_graph.json` (produced by generate.ts) as a single self-contained
 * `graph.html` file: the graph data is embedded inline (no fetch, no CDN, works from a plain
 * double-click or `file://`). Styled after Obsidian's graph view -- a live force-directed
 * simulation on canvas, individually draggable nodes, hover-to-highlight neighbors, and
 * nodes sized by how many edges touch them.
 *
 * The layout is PRE-COMPUTED here in Node (240 iterations, synchronously, before the HTML is
 * even written) rather than animated live in the browser at page-load time. An early version
 * ran that same settle animation client-side and it visibly looked stuck loading for several
 * seconds on an 893-node graph (~400k pairwise repulsion checks/frame). Precomputing it once
 * means the page opens already laid out; the live simulation in the browser only ever does
 * small local nudges after that (on drag / restart), never a full settle.
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
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #060708; color: #dfe3e8; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  #hud { position: fixed; top: 12px; left: 12px; z-index: 2; background: rgba(18,20,24,0.88); backdrop-filter: blur(6px); padding: 12px 16px; border-radius: 10px; font-size: 13px; line-height: 1.55; max-width: 300px; border: 1px solid rgba(255,255,255,0.08); }
  #hud b { color: #fff; font-size: 14px; }
  #search { width: 100%; margin-top: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid #3a3f47; background: #16181c; color: #eee; box-sizing: border-box; font-size: 13px; }
  #search:focus { outline: none; border-color: #6c8cff; }
  .hint { margin-top: 8px; opacity: 0.55; font-size: 11px; line-height: 1.5; }
  #tooltip { position: fixed; z-index: 3; pointer-events: none; background: rgba(18,20,24,0.95); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 6px 10px; font-size: 12px; display: none; max-width: 320px; }
  #tooltip b { color: #fff; }
  #legend { position: fixed; bottom: 12px; left: 12px; z-index: 2; background: rgba(18,20,24,0.88); border-radius: 10px; padding: 10px 14px; font-size: 11px; max-height: 40vh; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); }
  #legend .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; opacity: 0.85; }
  #legend .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #controls { position: fixed; top: 12px; right: 12px; z-index: 2; display: flex; gap: 6px; }
  #controls button { background: rgba(18,20,24,0.88); border: 1px solid rgba(255,255,255,0.12); color: #dfe3e8; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  #controls button:hover { background: rgba(40,44,50,0.95); }
</style>
</head>
<body>
<div id="hud">
  <div><b>dependency graph</b></div>
  <div id="stats" style="opacity:0.7; margin-top:2px;"></div>
  <input id="search" placeholder="filter by tool id or service..." />
  <div class="hint">drag canvas to pan &middot; scroll to zoom &middot; drag a node to reposition it &middot; hover a node to see its edges &middot; click to pin/unpin</div>
</div>
<div id="controls">
  <button id="reheat">restart layout</button>
</div>
<div id="legend"></div>
<div id="tooltip"></div>
<canvas></canvas>
<script>
const graph = ${JSON.stringify(graph).replace(/<\/script/gi, "<\\/script")};
const rawNodes = graph.nodes;
const rawEdges = graph.edges;

document.getElementById('stats').textContent = rawNodes.length + ' nodes, ' + rawEdges.length + ' edges';

// ---------------------------------------------------------------------------
// color by service
// ---------------------------------------------------------------------------
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function colorFor(service) {
  if (!service) return 'hsl(220, 8%, 55%)';
  const hue = hash(service) % 360;
  return 'hsl(' + hue + ', 62%, 62%)';
}
const services = [...new Set(rawNodes.map(n => n.service).filter(Boolean))].sort();
const legend = document.getElementById('legend');
const topServices = services
  .map(s => ({ s, n: rawNodes.filter(n => n.service === s).length }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 18);
legend.innerHTML = '<div style="opacity:0.6;margin-bottom:4px;">service (top ' + topServices.length + ')</div>' +
  topServices.map(({ s, n }) => '<div class="row"><span class="dot" style="background:' + colorFor(s) + '"></span>' + s + ' (' + n + ')</div>').join('');

// ---------------------------------------------------------------------------
// build sim state
// ---------------------------------------------------------------------------
const idIndex = new Map(rawNodes.map((n, i) => [n.id, i]));
const degree = new Array(rawNodes.length).fill(0);
const edgeIdx = [];
for (const e of rawEdges) {
  const a = idIndex.get(e.from), b = idIndex.get(e.to);
  if (a === undefined || b === undefined) continue;
  edgeIdx.push([a, b, e.label || '']);
  degree[a]++; degree[b]++;
}
const neighbors = rawNodes.map(() => new Set());
for (const [a, b] of edgeIdx) { neighbors[a].add(b); neighbors[b].add(a); }

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
let W = window.innerWidth, H = window.innerHeight, DPR = Math.min(2, window.devicePixelRatio || 1);
function resize() {
  W = window.innerWidth; H = window.innerHeight; DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
}
resize();
window.addEventListener('resize', resize);

function makeNodes() {
  return rawNodes.map((n, i) => {
    const angle = (i / rawNodes.length) * Math.PI * 2 + Math.random() * 0.3;
    const r = 80 + Math.sqrt(rawNodes.length) * 22 * Math.random();
    return {
      id: n.id, service: n.service, degree: degree[i],
      radius: 3 + Math.min(11, Math.sqrt(degree[i] + 1) * 2.2),
      x: Math.cos(angle) * r, y: Math.sin(angle) * r,
      vx: 0, vy: 0, fixed: false, color: colorFor(n.service),
    };
  });
}
let nodes = makeNodes();
const hubDegreeThreshold = [...degree].sort((a, b) => b - a)[Math.min(19, degree.length - 1)] || Infinity;

// Run the layout to (near-)completion synchronously, BEFORE the first paint, instead of
// animating the settle live. A live settle looks like the page is stuck "loading" for
// several seconds (and on slower machines, redoing ~400k pairwise force checks every single
// frame for that whole stretch is real, visible jank) -- pre-computing a fixed number of
// iterations up front means the graph appears already laid out immediately, and the live sim
// only ever has to do small local nudges after that (on drag / restart), not a full settle.
const PRELAYOUT_ITERATIONS = 240;
function prelayout() {
  alpha = 1;
  for (let i = 0; i < PRELAYOUT_ITERATIONS; i++) simTick(true);
  alpha = 0; // idle: the live render loop's simTick() becomes a no-op until something reheats it
}

// ---------------------------------------------------------------------------
// live force simulation
// ---------------------------------------------------------------------------
// "alpha" only gates WHETHER the sim keeps ticking (so it can go idle once settled, and
// wake back up on drag/restart) -- it does NOT scale force magnitudes. Forces below are all
// constant; only damping brings the system to rest.
//
// Repulsion is plain O(n^2) with a distance cutoff, not grid-bucketed: a grid-bucketed
// version capped each node's repulsion reach at a few hundred units, shorter than the
// initial layout's spread, so nodes further apart than that never repelled each other at
// all -- separate clusters just got dragged into one collapsed ball by the (unconditional)
// centering force with nothing to resist it. At ~900 nodes, ~400k pairwise checks/frame is
// cheap enough for 60fps in plain JS; this would need bucketing again on a catalog an order
// of magnitude bigger.
let alpha = 1;
const REPEL = 60000;
const REPEL_CUTOFF_D2 = 250000; // 500 units
const SPRING_LENGTH = 70;
const SPRING_STRENGTH = 0.02;
const CENTER_PULL = 0.0006;
const DAMPING = 0.82;

function simTick(force) {
  if (!force && alpha < 0.01) return;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const o = nodes[j];
      let ddx = n.x - o.x, ddy = n.y - o.y;
      let d2 = ddx * ddx + ddy * ddy || 0.01;
      if (d2 > REPEL_CUTOFF_D2) continue;
      const d = Math.sqrt(d2);
      // Clamp the denominator, not just the near-zero fallback above: 1/d^2 still spikes
      // hard for any small-but-nonzero separation (two nodes settling close together), and
      // that spike re-injects velocity every frame, which was keeping the whole simulation's
      // kinetic energy above the settle threshold indefinitely instead of decaying to rest.
      const f = REPEL / Math.max(d2, 400);
      const fx = (ddx / d) * f, fy = (ddy / d) * f;
      if (!n.fixed) { n.vx += fx; n.vy += fy; }
      if (!o.fixed) { o.vx -= fx; o.vy -= fy; }
    }
  }
  for (const [a, b] of edgeIdx) {
    const na = nodes[a], nb = nodes[b];
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - SPRING_LENGTH) * SPRING_STRENGTH;
    if (!na.fixed) { na.vx += (dx / d) * f; na.vy += (dy / d) * f; }
    if (!nb.fixed) { nb.vx -= (dx / d) * f; nb.vy -= (dy / d) * f; }
  }
  let kinetic = 0;
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += (0 - n.x) * CENTER_PULL;
    n.vy += (0 - n.y) * CENTER_PULL;
    n.x += n.vx *= DAMPING;
    n.y += n.vy *= DAMPING;
    kinetic += n.vx * n.vx + n.vy * n.vy;
  }
  // once the system is basically at rest, decay alpha fast so we stop ticking soon after
  alpha *= kinetic / nodes.length < 0.02 ? 0.9 : 0.999;
}

prelayout();

// ---------------------------------------------------------------------------
// camera (pan/zoom) + interaction
// ---------------------------------------------------------------------------
let camX = 0, camY = 0, zoom = Math.max(0.12, Math.min(0.6, 26 / Math.sqrt(rawNodes.length)));
function toScreen(x, y) { return [W / 2 + (x - camX) * zoom, H / 2 + (y - camY) * zoom]; }
function toWorld(sx, sy) { return [(sx - W / 2) / zoom + camX, (sy - H / 2) / zoom + camY]; }

let hovered = -1, pinned = -1, query = '';
let panning = false, panLastX = 0, panLastY = 0;
let draggingNode = -1;

function nodeAt(sx, sy) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const [x, y] = toScreen(nodes[i].x, nodes[i].y);
    const r = Math.max(nodes[i].radius * zoom, 5);
    if ((sx - x) ** 2 + (sy - y) ** 2 <= r * r) return i;
  }
  return -1;
}

canvas.addEventListener('mousedown', (ev) => {
  const i = nodeAt(ev.clientX, ev.clientY);
  if (i >= 0) { draggingNode = i; nodes[i].fixed = true; canvas.classList.add('dragging'); }
  else { panning = true; panLastX = ev.clientX; panLastY = ev.clientY; canvas.classList.add('dragging'); }
});
window.addEventListener('mousemove', (ev) => {
  if (draggingNode >= 0) {
    const [wx, wy] = toWorld(ev.clientX, ev.clientY);
    nodes[draggingNode].x = wx; nodes[draggingNode].y = wy;
    alpha = Math.max(alpha, 0.25);
    return;
  }
  if (panning) {
    camX -= (ev.clientX - panLastX) / zoom;
    camY -= (ev.clientY - panLastY) / zoom;
    panLastX = ev.clientX; panLastY = ev.clientY;
    return;
  }
  hovered = nodeAt(ev.clientX, ev.clientY);
  const tip = document.getElementById('tooltip');
  if (hovered >= 0) {
    const n = nodes[hovered];
    tip.style.display = 'block';
    tip.style.left = (ev.clientX + 14) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
    tip.innerHTML = '<b>' + n.id + '</b><br>' + (n.service ? 'service: ' + n.service + '<br>' : '') + n.degree + ' connection' + (n.degree === 1 ? '' : 's');
  } else {
    tip.style.display = 'none';
  }
});
window.addEventListener('mouseup', () => {
  if (draggingNode >= 0) nodes[draggingNode].fixed = (pinned === draggingNode);
  draggingNode = -1; panning = false;
  canvas.classList.remove('dragging');
});
canvas.addEventListener('click', (ev) => {
  if (panning || draggingNode >= 0) return; // was a drag, not a click
  const i = nodeAt(ev.clientX, ev.clientY);
  if (i === pinned) { nodes[i].fixed = false; pinned = -1; }
  else {
    if (pinned >= 0) nodes[pinned].fixed = false;
    if (i >= 0) { nodes[i].fixed = true; pinned = i; }
    else pinned = -1;
  }
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  zoom = Math.max(0.05, Math.min(6, zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
  const [sx, sy] = toScreen(wx, wy);
  camX += (sx - ev.clientX) / zoom;
  camY += (sy - ev.clientY) / zoom;
}, { passive: false });

document.getElementById('search').addEventListener('input', (ev) => { query = ev.target.value.trim().toUpperCase(); });
document.getElementById('reheat').addEventListener('click', () => {
  nodes = makeNodes();
  pinned = -1; hovered = -1;
  prelayout();
});

// ---------------------------------------------------------------------------
// render loop
// ---------------------------------------------------------------------------
const avgDegree = degree.reduce((a, b) => a + b, 0) / Math.max(degree.length, 1);
function draw() {
  simTick();
  ctx.save();
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#060708';
  ctx.fillRect(0, 0, W, H);

  const activeHover = hovered >= 0 ? hovered : pinned;
  const highlightSet = activeHover >= 0 ? neighbors[activeHover] : null;

  // edges
  for (const [a, b] of edgeIdx) {
    const isHi = highlightSet && (a === activeHover || b === activeHover);
    let dim = false;
    if (query) {
      const na = nodes[a], nb = nodes[b];
      const match = na.id.includes(query) || nb.id.includes(query) ||
        (na.service || '').toUpperCase().includes(query) || (nb.service || '').toUpperCase().includes(query);
      dim = !match;
    }
    const [x1, y1] = toScreen(nodes[a].x, nodes[a].y);
    const [x2, y2] = toScreen(nodes[b].x, nodes[b].y);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = isHi ? 'rgba(255,190,110,0.9)' : dim ? 'rgba(120,128,140,0.04)' : 'rgba(140,150,165,0.16)';
    ctx.lineWidth = isHi ? 1.6 : 0.7;
    ctx.stroke();
  }

  // nodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const [x, y] = toScreen(n.x, n.y);
    if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
    let dim = false;
    if (query) dim = !(n.id.includes(query) || (n.service || '').toUpperCase().includes(query));
    if (highlightSet) dim = dim || !(i === activeHover || highlightSet.has(i));
    const r = Math.max(n.radius * zoom, 2);

    if (i === activeHover) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,190,110,0.18)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(120,128,140,0.18)' : n.color;
    ctx.fill();
    if (n.fixed) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();
    }

    const isHubAtLowZoom = zoom < 0.5 && n.degree >= hubDegreeThreshold;
    const isQueryMatch = query && !dim;
    const showLabel = !dim && (zoom > 1.1 || i === activeHover || (highlightSet && highlightSet.has(i)) || isHubAtLowZoom || isQueryMatch);
    if (showLabel && r > 1.5) {
      ctx.font = (i === activeHover ? 'bold ' : '') + '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = i === activeHover ? '#fff' : 'rgba(223,227,232,0.75)';
      ctx.fillText(n.id, x + r + 4, y + 3);
    }
  }
  ctx.restore();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script>
</body>
</html>
`;

writeFileSync(OUT_PATH, html, "utf-8");
console.error(`wrote ${OUT_PATH} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
