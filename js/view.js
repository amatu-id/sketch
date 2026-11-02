// Viewport: world<->screen transform, compositing to the screen, overlay (guides, selection, cursor).
import { S, T, mk, cx2d, clamp, rInter, emit, $ } from './state.js';
import { groups, drawLayerContent, drawPaperPattern, paperRect, unkey, docBounds, drawTile } from './doc.js';

export let W = 800, Hh = 600, DPR = 1;
let cv, g, ov, og, stage;
const off = {};
let checker = null, wsColor = '#2a2a2e';

export function initView() {
  stage = $('#stage'); cv = $('#cv'); ov = $('#ov');
  g = cx2d(cv); og = cx2d(ov);
  new ResizeObserver(resize).observe(stage);
  resize();
  setInterval(() => { if (S.sel) { S.ants = ((S.ants || 0) + 1) % 1000; S.ovDirty = true; } }, 140);
  const loop = () => {
    if (S.dirty) { S.dirty = false; try { render(); } catch (e) { console.error(e); } }
    if (S.ovDirty) { S.ovDirty = false; try { drawOverlay(); } catch (e) { console.error(e); } }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
export function themeChanged() {
  wsColor = getComputedStyle(document.documentElement).getPropertyValue('--ws').trim() || '#2a2a2e';
  S.dirty = true;
}
function resize() {
  const r = stage.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = Math.max(50, r.width); Hh = Math.max(50, r.height);
  for (const c of [cv, ov]) { c.width = Math.round(W * DPR); c.height = Math.round(Hh * DPR); c.style.width = W + 'px'; c.style.height = Hh + 'px'; }
  for (const k in off) { off[k].width = cv.width; off[k].height = cv.height; }
  S.dirty = S.ovDirty = true;
  emit('view');
}
function offscreen(name) {
  let c = off[name];
  if (!c) c = off[name] = mk(cv.width, cv.height);
  return c;
}

// ---------------- transforms ----------------
export function vm(dpr = 1) {
  const v = S.view, m = new DOMMatrix();
  m.scaleSelf(dpr, dpr);
  m.translateSelf(W / 2, Hh / 2);
  if (v.flip) m.scaleSelf(-1, 1);
  m.rotateSelf(v.r * 180 / Math.PI);
  m.scaleSelf(v.z, v.z);
  m.translateSelf(-v.x, -v.y);
  return m;
}
export const w2s = p => vm().transformPoint({ x: p.x, y: p.y });
export function s2w(x, y) { return vm().inverse().transformPoint({ x, y }); }
export function clientToWorld(e) {
  const r = cv.getBoundingClientRect();
  return s2w(e.clientX - r.left, e.clientY - r.top);
}
export function clientToScreen(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
export function visibleRect() {
  const inv = vm().inverse();
  const ps = [[0, 0], [W, 0], [0, Hh], [W, Hh]].map(([x, y]) => inv.transformPoint({ x, y }));
  const x0 = Math.min(...ps.map(p => p.x)), y0 = Math.min(...ps.map(p => p.y));
  return { x: x0, y: y0, w: Math.max(...ps.map(p => p.x)) - x0, h: Math.max(...ps.map(p => p.y)) - y0 };
}
export function zoomAt(sx, sy, f) {
  const v = S.view, before = s2w(sx, sy);
  v.z = clamp(v.z * f, 0.02, 64);
  const after = s2w(sx, sy);
  v.x += before.x - after.x; v.y += before.y - after.y;
  viewChanged();
}
export function setZoom(z) { zoomAt(W / 2, Hh / 2, z / S.view.z); }
export function panBy(dx, dy) { // screen px
  const inv = vm().inverse();
  const a = inv.transformPoint({ x: 0, y: 0 }), b = inv.transformPoint({ x: dx, y: dy });
  S.view.x -= b.x - a.x; S.view.y -= b.y - a.y;
  viewChanged();
}
export function fitView(r) {
  const d = S.doc;
  if (!d) return;
  const sr = stage.getBoundingClientRect();
  if (Math.abs(sr.width - W) > 1 || Math.abs(sr.height - Hh) > 1) resize();
  r = r || paperRect() || docBounds() || { x: -W / 2, y: -Hh / 2, w: W, h: Hh };
  const pad = W < 700 ? 24 : 70;
  S.view.r = 0;
  S.view.z = clamp(Math.min((W - pad * 2) / r.w, (Hh - pad * 2) / r.h), 0.02, d.infinite ? 1 : 8);
  S.view.x = r.x + r.w / 2; S.view.y = r.y + r.h / 2;
  viewChanged();
}
export function viewChanged() { S.dirty = S.ovDirty = true; emit('view'); }

// ---------------- render ----------------
function checkerPat(ctx) {
  if (!checker) {
    const c = mk(16, 16), x = cx2d(c);
    x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#d8d8dc'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    checker = c;
  }
  return ctx.createPattern(checker, 'repeat');
}

export function render() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = wsColor; g.fillRect(0, 0, cv.width, cv.height);
  const d = S.doc;
  if (!d) return;
  const M = vm(DPR), vis = visibleRect(), z = S.view.z;
  const p = paperRect();
  g.setTransform(M);
  if (p) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 22 * DPR; g.shadowOffsetY = 4 * DPR;
    g.fillStyle = d.bgOn ? d.bg : '#fff'; g.fillRect(p.x, p.y, p.w, p.h);
    g.restore();
    g.save(); g.beginPath(); g.rect(p.x, p.y, p.w, p.h); g.clip();
  }
  const area = p ? rInter(vis, p) : vis;
  if (area) {
    if (d.bgOn) { g.fillStyle = d.bg; g.fillRect(area.x, area.y, area.w, area.h); }
    else { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = checkerPat(g); g.fillRect(0, 0, cv.width, cv.height); g.restore(); }
    drawPaperPattern(g, area, z * DPR);
  }
  g.imageSmoothingEnabled = z < 2.5;
  g.imageSmoothingQuality = 'high';
  const e = 1 / (z * DPR); // >0 = screen drawing: snap tiles to device pixels
  const strokeL = S.stroke && S.stroke.buf ? S.stroke.layer : null;
  for (const gr of groups(d.layers)) {
    const b = gr.base;
    if (!b.visible) continue;
    const clipped = gr.clipped.filter(c => c.visible);
    if (!clipped.length && b !== strokeL) {
      g.globalAlpha = b.opacity; g.globalCompositeOperation = b.blend;
      drawLayerContent(g, b, vis, e);
      continue;
    }
    const O = offscreen('grp'), o = cx2d(O);
    o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = 1; o.globalCompositeOperation = 'source-over';
    o.clearRect(0, 0, O.width, O.height);
    o.setTransform(M); o.imageSmoothingEnabled = g.imageSmoothingEnabled;
    drawLive(o, b, M, vis, e, strokeL);
    for (const c of clipped) {
      o.globalCompositeOperation = 'source-atop'; o.globalAlpha = c.opacity;
      drawLive(o, c, M, vis, e, strokeL);
    }
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = b.opacity; g.globalCompositeOperation = b.blend;
    g.drawImage(O, 0, 0); g.restore();
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  if (p) g.restore();
}
function drawLive(o, l, M, vis, e, strokeL) {
  if (l !== strokeL) { drawLayerContent(o, l, vis, e); return; }
  const st = S.stroke;
  const A = offscreen('a'), a = cx2d(A);
  a.setTransform(1, 0, 0, 1, 0, 0); a.globalAlpha = 1; a.globalCompositeOperation = 'source-over';
  a.clearRect(0, 0, A.width, A.height);
  a.setTransform(M); a.imageSmoothingEnabled = o.imageSmoothingEnabled;
  drawLayerContent(a, l, vis, e);
  const B = offscreen('b'), b = cx2d(B);
  b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-over'; b.globalAlpha = 1;
  b.clearRect(0, 0, B.width, B.height);
  b.setTransform(M); b.imageSmoothingEnabled = o.imageSmoothingEnabled;
  for (const [k, t] of st.buf) {
    const [tx, ty] = unkey(k);
    drawTile(b, t, tx * T, ty * T, e);
  }
  if (S.sel) { b.globalCompositeOperation = 'destination-in'; b.drawImage(S.sel.c, S.sel.x, S.sel.y); }
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.globalAlpha = st.alpha; a.globalCompositeOperation = st.op;
  a.drawImage(B, 0, 0);
  o.save(); o.setTransform(1, 0, 0, 1, 0, 0); o.drawImage(A, 0, 0); o.restore();
}

// ---------------- overlay ----------------
export function drawOverlay() {
  og.setTransform(1, 0, 0, 1, 0, 0);
  og.clearRect(0, 0, ov.width, ov.height);
  if (!S.doc) return;
  const M = vm(DPR), z = S.view.z, px = 1 / (z * DPR), vis = visibleRect();
  og.setTransform(M);
  og.lineCap = 'butt';
  const p = paperRect();
  const area = p ? rInter(vis, p) : vis;
  // pixel grid
  if (area && S.prefs.pixelGrid && z >= 10) {
    og.beginPath();
    for (let x = Math.floor(area.x); x <= area.x + area.w; x++) { og.moveTo(x, area.y); og.lineTo(x, area.y + area.h); }
    for (let y = Math.floor(area.y); y <= area.y + area.h; y++) { og.moveTo(area.x, y); og.lineTo(area.x + area.w, y); }
    og.strokeStyle = 'rgba(128,128,128,.35)'; og.lineWidth = px; og.stroke();
  }
  // guide grid
  if (S.grid && area) {
    let gs = S.gridSize;
    while (gs * z < 8) gs *= 2;
    og.beginPath();
    for (let x = Math.floor(area.x / gs) * gs; x <= area.x + area.w; x += gs) { og.moveTo(x, area.y); og.lineTo(x, area.y + area.h); }
    for (let y = Math.floor(area.y / gs) * gs; y <= area.y + area.h; y += gs) { og.moveTo(area.x, y); og.lineTo(area.x + area.w, y); }
    og.strokeStyle = 'rgba(0,150,255,.35)'; og.lineWidth = px; og.stroke();
  }
  // symmetry guides
  if (S.sym.on) drawSym(og, vis, px);
  // selection outline (marching ants)
  if (S.sel && S.sel.segs) {
    const s = S.sel.segs;
    og.beginPath();
    for (let i = 0; i < s.length; i += 4) { og.moveTo(s[i], s[i + 1]); og.lineTo(s[i + 2], s[i + 3]); }
    og.lineWidth = px * 1.4 * DPR;
    og.strokeStyle = '#fff'; og.setLineDash([]); og.stroke();
    og.strokeStyle = '#111'; og.setLineDash([4 * px * DPR, 4 * px * DPR]); og.lineDashOffset = -(S.ants || 0) * px * DPR; og.stroke();
    og.setLineDash([]);
  }
  if (S.paintOverlay) { og.save(); S.paintOverlay(og, M, px); og.restore(); }
  if (S.ruler.on) drawRuler(og);
  // brush cursor
  const c = S.cursor;
  if (c && c.r != null) {
    og.setTransform(M);
    if (c.r * z * DPR >= 4) {
      og.beginPath(); og.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      og.lineWidth = px * 2.4 * DPR; og.strokeStyle = 'rgba(255,255,255,.75)'; og.stroke();
      og.lineWidth = px * 1 * DPR; og.strokeStyle = 'rgba(0,0,0,.8)'; og.stroke();
    }
    const q = w2s(c), k = 6 * DPR;
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.beginPath(); og.moveTo(q.x * DPR - k, q.y * DPR); og.lineTo(q.x * DPR + k, q.y * DPR); og.moveTo(q.x * DPR, q.y * DPR - k); og.lineTo(q.x * DPR, q.y * DPR + k);
    og.lineWidth = 3 * DPR; og.strokeStyle = 'rgba(255,255,255,.7)'; og.stroke();
    og.lineWidth = 1 * DPR; og.strokeStyle = 'rgba(0,0,0,.85)'; og.stroke();
  }
}

export function symTransforms() {
  const s = S.sym, out = [];
  const cx = s.cx, cy = s.cy;
  if (s.mode === 'v') out.push(p => ({ x: 2 * cx - p.x, y: p.y, a: Math.PI - p.a }));
  else if (s.mode === 'h') out.push(p => ({ x: p.x, y: 2 * cy - p.y, a: -p.a }));
  else if (s.mode === 'q') {
    out.push(p => ({ x: 2 * cx - p.x, y: p.y, a: Math.PI - p.a }));
    out.push(p => ({ x: p.x, y: 2 * cy - p.y, a: -p.a }));
    out.push(p => ({ x: 2 * cx - p.x, y: 2 * cy - p.y, a: p.a + Math.PI }));
  } else if (s.mode === 'r') {
    const n = s.n;
    for (let i = 1; i < n; i++) {
      const t = i * Math.PI * 2 / n, c = Math.cos(t), sn = Math.sin(t);
      out.push(p => ({ x: cx + (p.x - cx) * c - (p.y - cy) * sn, y: cy + (p.x - cx) * sn + (p.y - cy) * c, a: p.a + t }));
    }
    if (s.mirror) for (let i = 0; i < n; i++) {
      const t = i * Math.PI * 2 / n, c = Math.cos(t), sn = Math.sin(t);
      out.push(p => { const mx = 2 * cx - p.x; return { x: cx + (mx - cx) * c - (p.y - cy) * sn, y: cy + (mx - cx) * sn + (p.y - cy) * c, a: Math.PI - p.a + t }; });
    }
  }
  return out;
}
function drawSym(o, vis, px) {
  const s = S.sym, L = Math.hypot(vis.w, vis.h) * 2;
  o.beginPath();
  const ray = (t, full) => { o.moveTo(s.cx - (full ? Math.cos(t) * L : 0), s.cy - (full ? Math.sin(t) * L : 0)); o.lineTo(s.cx + Math.cos(t) * L, s.cy + Math.sin(t) * L); };
  if (s.mode === 'v') ray(Math.PI / 2, true);
  else if (s.mode === 'h') ray(0, true);
  else if (s.mode === 'q') { ray(0, true); ray(Math.PI / 2, true); }
  else for (let i = 0; i < s.n; i++) ray(-Math.PI / 2 + i * Math.PI * 2 / s.n, false);
  o.strokeStyle = 'rgba(0,190,255,.7)'; o.lineWidth = px * 1.5 * DPR; o.setLineDash([8 * px * DPR, 6 * px * DPR]); o.stroke(); o.setLineDash([]);
  o.beginPath(); o.arc(s.cx, s.cy, 7 * px * DPR, 0, 7);
  o.fillStyle = 'rgba(0,190,255,.9)'; o.fill(); o.strokeStyle = '#fff'; o.lineWidth = px * 2 * DPR; o.stroke();
}

export const RULER_W = 46;
export function rulerGeom() {
  const r = S.ruler, A = w2s(r.a), B = w2s(r.b);
  const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const u = { x: (B.x - A.x) / L, y: (B.y - A.y) / L }, n = { x: -u.y, y: u.x };
  return { A, B, L, u, n };
}
function drawRuler(o) {
  const { A, B, L, u, n } = rulerGeom();
  o.setTransform(DPR, 0, 0, DPR, 0, 0);
  const Wd = RULER_W;
  o.beginPath();
  o.moveTo(A.x, A.y); o.lineTo(B.x, B.y); o.lineTo(B.x + n.x * Wd, B.y + n.y * Wd); o.lineTo(A.x + n.x * Wd, A.y + n.y * Wd); o.closePath();
  o.fillStyle = 'rgba(250,248,240,.78)'; o.fill();
  o.strokeStyle = 'rgba(40,40,40,.55)'; o.lineWidth = 1; o.stroke();
  // ticks in mm at document dpi
  const mm = S.doc.dpi / 25.4 * S.view.z; // screen px per mm
  const wl = Math.hypot(S.ruler.b.x - S.ruler.a.x, S.ruler.b.y - S.ruler.a.y);
  const totalMm = wl * 25.4 / S.doc.dpi;
  let every = 1;
  while (mm * every < 5) every *= every === 1 ? 5 : 2;
  o.beginPath();
  o.font = '10px Inter, system-ui, sans-serif'; o.fillStyle = '#333'; o.textAlign = 'center'; o.textBaseline = 'middle';
  for (let i = 0; i <= totalMm; i += every) {
    const x = A.x + u.x * i * mm, y = A.y + u.y * i * mm;
    const len = i % 10 === 0 ? 16 : i % 5 === 0 ? 10 : 6;
    o.moveTo(x, y); o.lineTo(x + n.x * len, y + n.y * len);
    if (i % 10 === 0 && mm * 10 > 22) { o.save(); o.translate(x + n.x * 27, y + n.y * 27); o.rotate(Math.atan2(u.y, u.x)); o.fillText(String(i / 10), 0, 0); o.restore(); }
  }
  o.strokeStyle = 'rgba(30,30,30,.75)'; o.lineWidth = 1; o.stroke();
  for (const P of [A, B]) {
    o.beginPath(); o.arc(P.x, P.y, 9, 0, 7); o.fillStyle = 'rgba(0,122,255,.9)'; o.fill(); o.strokeStyle = '#fff'; o.lineWidth = 2; o.stroke();
  }
  // angle + length label
  const ang = ((Math.atan2(S.ruler.b.y - S.ruler.a.y, S.ruler.b.x - S.ruler.a.x) * 180 / Math.PI) + 360) % 360;
  const mid = { x: (A.x + B.x) / 2 + n.x * (Wd + 14), y: (A.y + B.y) / 2 + n.y * (Wd + 14) };
  const txt = Math.round(ang * 10) / 10 + '° · ' + (totalMm >= 10 ? (totalMm / 10).toFixed(1) + ' cm' : totalMm.toFixed(1) + ' mm') + ' · ' + Math.round(wl) + ' px';
  o.font = '600 11px Inter, system-ui, sans-serif';
  const tw = o.measureText(txt).width + 14;
  o.fillStyle = 'rgba(20,20,24,.82)';
  o.beginPath(); o.roundRect ? o.roundRect(mid.x - tw / 2, mid.y - 10, tw, 20, 10) : o.rect(mid.x - tw / 2, mid.y - 10, tw, 20); o.fill();
  o.fillStyle = '#fff'; o.fillText(txt, mid.x, mid.y + 0.5);
}
export function canvasEl() { return cv; }
export function dpr() { return DPR; }
