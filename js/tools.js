// Pointer input + all canvas tools.
import { S, T, $, mk, cx2d, clamp, dist, hex2rgb, rgb2hex, rInter, rUnion, rPad, rInt, rHas, emit, toast, savePrefs } from './state.js';
import {
  activeLayer, newLayer, insertLayer, begin, end, abort, H, undo, redo, changed, drawToLayer, layerRegion, clearRegion, flatten,
  contentBounds, docBounds, paperRect, objBox, textBox, fontStr, selSet, setSelCanvas, selRect, selClear, selHas, key, rotRectAABB
} from './doc.js';
import { makeStroke, strokePoint, strokeFinish, strokeCommit, strokeRebuild, presetById, smudgeStart, smudgeMove, smudgeEnd } from './brush.js';
import { vm, w2s, s2w, clientToWorld, clientToScreen, visibleRect, zoomAt, panBy, viewChanged, canvasEl, rulerGeom, RULER_W, dpr } from './view.js';

const tools = {};
let cur = null; // tool object currently handling a drag
const pointers = new Map();
let gesture = null, panDrag = null, special = null, spaceDown = false, tempPick = null;
let lastHover = null;

export function setTool(name) {
  if (S.tool === name && tools[name]) { emit('tool'); return; }
  commitPending();
  const old = tools[S.tool];
  old && old.leave && old.leave();
  S.tool = name;
  const t = tools[name];
  t && t.enter && t.enter();
  S.cursor = null;
  updateCursor();
  S.ovDirty = true;
  emit('tool');
}
export function commitPending() {
  if (S.textEdit) finishText();
  if (S.float) commitFloat();
  if (S.shape) commitShape();
}
export function cancelPending() {
  if (S.textEdit) { finishText(); return true; }
  if (S.float) { cancelFloat(); return true; }
  if (S.shape) { S.shape = null; S.ovDirty = true; emit('tool'); return true; }
  if (S.sel) { selClear(); return true; }
  return false;
}
function updateCursor() {
  const c = canvasEl();
  if (!c) return;
  const t = S.tool;
  c.style.cursor = spaceDown || t === 'hand' ? (panDrag ? 'grabbing' : 'grab') :
    ['brush', 'eraser', 'smudge'].includes(t) ? 'none' : t === 'text' ? 'text' : t === 'move' ? 'default' : 'crosshair';
}

// ---------------- helpers ----------------
function paintTarget() {
  let l = activeLayer();
  if (!l) { l = insertLayer(newLayer('raster')); emit('layers'); return l; }
  if (l.locked) { toast('Lapisan terkunci 🔒 — buka kunci di panel Lapisan'); return null; }
  if (!l.visible) { toast('Lapisan sedang disembunyikan'); return null; }
  if (l.type !== 'raster') {
    const n = insertLayer(newLayer('raster'));
    toast('Lapisan baru dibuat di atas ' + (l.type === 'text' ? 'teks' : 'gambar'));
    emit('layers');
    return n;
  }
  return l;
}
function pressureOf(e, prev) {
  if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
  if (e.pointerType === 'mouse' && S.prefs.simPressure && prev) {
    const v = Math.hypot(e.clientX - prev.cx, e.clientY - prev.cy) / Math.max(1, e.timeStamp - prev.t);
    return clamp(1.05 - v * .45, .25, 1);
  }
  return 1;
}
function mkPt(e, prev) {
  const w = clientToWorld(e), s = clientToScreen(e);
  return { x: w.x, y: w.y, p: pressureOf(e, prev), sx: s.x, sy: s.y, cx: e.clientX, cy: e.clientY, t: e.timeStamp, shift: e.shiftKey, alt: e.altKey, e };
}
export function sampleColor(p, all = S.tools.pick.all) {
  const r = { x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 };
  const l = activeLayer();
  const c = all || !l ? flatten(r, 1, { clipPaper: false }) : layerRegion(l, r);
  const d = cx2d(c, { willReadFrequently: true }).getImageData(0, 0, 1, 1).data;
  if (!all && d[3] === 0) return null;
  if (all && d[3] === 0) return S.doc.bgOn ? S.doc.bg : null;
  return rgb2hex(d[0], d[1], d[2]);
}
export function setColor(hex, second) {
  if (!hex) return;
  if (second) S.color2 = hex; else S.color = hex;
  emit('color'); savePrefs();
}
export function pushRecent(hex) {
  S.recent = [hex, ...S.recent.filter(c => c !== hex)].slice(0, 12);
  emit('color'); savePrefs();
}
const ss = (px) => px / S.view.z; // screen px -> world

// ---------------- brush / eraser ----------------
function paintTool(kind) {
  let st = null, hold = null, anchor = null, lastE = null;
  return {
    down(p) {
      begin(kind === 'eraser' ? 'Hapus' : 'Kuas');
      const l = paintTarget();
      if (!l) { end(); return false; }
      const o = S.tools[kind], preset = presetById(o.preset);
      st = makeStroke({ layer: l, preset, size: o.size, opacity: o.opacity, color: S.color, erase: kind === 'eraser', dash: o.dash, dashLen: o.dashLen, dashGap: o.dashGap, smooth: o.smooth });
      st.start = { x: p.x, y: p.y };
      // ruler snapping
      if (S.ruler.on) {
        const { A, u, n } = rulerGeom();
        const d = (p.sx - A.x) * n.x + (p.sy - A.y) * n.y;
        if (d < 0 && d > -50) st.ruler = { off: d };
      }
      S.stroke = st;
      strokePoint(st, this.fix(p));
      anchor = p; lastE = p;
      S.dirty = true;
    },
    fix(p) {
      if (!st || !st.ruler) return p;
      const { A, u, n } = rulerGeom();
      const t = (p.sx - A.x) * u.x + (p.sy - A.y) * u.y;
      const q = s2w(A.x + u.x * t + n.x * st.ruler.off, A.y + u.y * t + n.y * st.ruler.off);
      return { ...p, x: q.x, y: q.y };
    },
    move(p, evs) {
      if (!st) return;
      if (st.snapped) {
        if (st.snapped.kind === 'line') {
          let b = { x: p.x, y: p.y };
          if (p.shift) b = snapAngle(st.snapped.a, b);
          st.snapped.b = b; strokeRebuild(st, [st.snapped.a, b]); S.dirty = true;
        }
        return;
      }
      for (const q of evs) strokePoint(st, this.fix(q));
      lastE = p;
      if (S.prefs.quickShape && !st.ruler && Math.hypot(p.sx - anchor.sx, p.sy - anchor.sy) > 4) {
        anchor = p; clearTimeout(hold);
        hold = setTimeout(() => this.snap(), 600);
      }
      S.dirty = true;
    },
    snap() {
      if (!st || st.snapped || S.stroke !== st) return;
      const sh = detectShape(st.pts);
      if (!sh) return;
      st.snapped = sh;
      strokeRebuild(st, sh.kind === 'line' ? [sh.a, sh.b] : sh.pts);
      toast(sh.kind === 'line' ? 'Garis lurus — geser untuk atur ujung' : sh.circle ? 'Lingkaran' : 'Elips', 1400);
      S.dirty = true;
    },
    up() {
      clearTimeout(hold);
      if (!st) return;
      if (!st.snapped) strokeFinish(st);
      strokeCommit(st, kind === 'eraser' ? 'Hapus' : 'Kuas');
      end(kind === 'eraser' ? 'Hapus' : 'Kuas');
      st = null; S.stroke = null; S.dirty = true;
      emit('stroke');
    },
    cancel() { clearTimeout(hold); if (st) { st = null; S.stroke = null; abort(); S.dirty = true; } },
    hover(p) { S.cursor = { x: p.x, y: p.y, r: S.tools[kind].size / 2 }; }
  };
}
function snapAngle(a, b) {
  const L = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 12)) * (Math.PI / 12);
  return { x: a.x + Math.cos(ang) * L, y: a.y + Math.sin(ang) * L };
}
function detectShape(pts) {
  if (pts.length < 4) return null;
  let len = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) len += dist(p, pts[i - 1]);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const a = pts[0], b = pts[pts.length - 1], big = Math.max(x1 - x0, y1 - y0);
  if (big < ss(16)) return null;
  if (dist(a, b) < big * .22 && len > big * 2.2) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, err = 0;
    for (const p of pts) err += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    err /= pts.length;
    if (err > .2) return null;
    const circle = Math.abs(rx - ry) / Math.max(rx, ry) < .14;
    if (circle) rx = ry = (rx + ry) / 2;
    const out = [];
    for (let i = 0; i <= 96; i++) { const t = i / 96 * Math.PI * 2; out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry }); }
    return { kind: 'ellipse', pts: out, circle };
  }
  if (dist(a, b) / len > .86) return { kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  return null;
}
tools.brush = paintTool('brush');
tools.eraser = paintTool('eraser');

// ---------------- smudge ----------------
tools.smudge = (() => {
  let st = null;
  return {
    down(p) {
      const l = activeLayer();
      if (!l || l.type !== 'raster') { toast('Jari hanya untuk lapisan piksel'); return false; }
      if (l.locked) { toast('Lapisan terkunci 🔒'); return false; }
      st = smudgeStart(l, p, S.tools.smudge.size, S.tools.smudge.strength);
    },
    move(p, evs) { if (!st) return; for (const q of evs) smudgeMove(st, q); S.dirty = true; },
    up() { if (st) { smudgeEnd(); st = null; emit('stroke'); } },
    cancel() { if (st) { st = null; abort(); S.dirty = true; } },
    hover(p) { S.cursor = { x: p.x, y: p.y, r: S.tools.smudge.size / 2 }; }
  };
})();

// ---------------- flood fill / magic wand ----------------
function fillRegion(p) {
  const pr = paperRect();
  if (pr) return pr;
  const v = visibleRect();
  let r = rUnion(docBounds(), v);
  r = rInt(rPad(r, 4));
  const M = 4096;
  if (r.w > M) r = { ...r, x: Math.round(clamp(p.x - M / 2, r.x, r.x + r.w - M)), w: M };
  if (r.h > M) r = { ...r, y: Math.round(clamp(p.y - M / 2, r.y, r.y + r.h - M)), h: M };
  return r;
}
function floodMask(p, refAll, tol, contig) {
  const r = fillRegion(p);
  if (!rHas(r, p)) return null;
  const l = activeLayer();
  const ref = refAll || !l ? flatten(r, 1, { bg: false }) : layerRegion(l, r);
  const w = ref.width, h = ref.height;
  const d = cx2d(ref, { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const sx = Math.floor(p.x - r.x), sy = Math.floor(p.y - r.y), si = (sy * w + sx) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const t = tol * 2.55;
  const match = i => {
    const a = d[i + 3];
    if (ta < 10 && a < 10) return true;
    // compare premultiplied so semi-transparent edges count as boundary
    const da = Math.abs(a - ta);
    if (da > t) return false;
    return Math.abs(d[i] * a / 255 - tr * ta / 255) <= t && Math.abs(d[i + 1] * a / 255 - tg * ta / 255) <= t && Math.abs(d[i + 2] * a / 255 - tb * ta / 255) <= t;
  };
  const m = new Uint8Array(w * h);
  if (!contig) { for (let i = 0; i < w * h; i++) if (match(i * 4)) m[i] = 1; }
  else {
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(); let x = stack.pop();
      while (x >= 0 && !m[y * w + x] && match((y * w + x) * 4)) x--;
      x++;
      let up = false, dn = false;
      while (x < w && !m[y * w + x] && match((y * w + x) * 4)) {
        m[y * w + x] = 1;
        if (y > 0) { const ok = !m[(y - 1) * w + x] && match(((y - 1) * w + x) * 4); if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false; }
        if (y < h - 1) { const ok = !m[(y + 1) * w + x] && match(((y + 1) * w + x) * 4); if (ok && !dn) { stack.push(x, y + 1); dn = true; } else if (!ok) dn = false; }
        x++;
      }
    }
  }
  return { m, w, h, r };
}
function dilate(f, n) {
  const { w, h } = f;
  let m = f.m;
  for (let k = 0; k < n; k++) {
    const o = new Uint8Array(m);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (m[i]) continue;
      if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w])) o[i] = 1;
    }
    m = o;
  }
  f.m = m;
}
function maskCanvas(f, color) {
  const c = mk(f.w, f.h), g = cx2d(c), im = g.createImageData(f.w, f.h), d = im.data;
  const [r, gg, b] = hex2rgb(color || '#000');
  for (let i = 0; i < f.m.length; i++) if (f.m[i]) { const j = i * 4; d[j] = r; d[j + 1] = gg; d[j + 2] = b; d[j + 3] = 255; }
  g.putImageData(im, 0, 0);
  return c;
}
export function doFill(p) {
  const o = S.tools.fill;
  begin('Isi warna');
  const l = paintTarget();
  if (!l) { end(); return; }
  const f = floodMask(p, o.ref === 'all', o.tol, o.contig);
  if (!f) { end(); toast('Klik di dalam kertas'); return; }
  if (o.expand) dilate(f, o.expand);
  drawToLayer(l, maskCanvas(f, S.color), f.r.x, f.r.y, { alpha: o.opacity });
  end('Isi warna');
  pushRecent(S.color);
  emit('stroke');
}
tools.fill = { down(p) { doFill(p); return false; } };

// ---------------- eyedropper ----------------
tools.picker = (() => {
  let old = null;
  return {
    down(p) { old = S.color; this.move(p); },
    move(p) {
      const c = sampleColor(p);
      if (c) { S.color = c; emit('color'); }
      S.loupe = { x: p.sx, y: p.sy, c: S.color, old };
      S.ovDirty = true;
    },
    up() { S.loupe = null; S.ovDirty = true; pushRecent(S.color); savePrefs(); if (tempPick) { const t = tempPick; tempPick = null; setTool(t); } }
  };
})();

// ---------------- gradient ----------------
function gradRegion() {
  const base = paperRect() || visibleRect();
  const s = selRect();
  return rInt(s ? (rInter(s, base) || s) : base);
}
function paintGradient(g, a, b, r) {
  const o = S.tools.gradient;
  let gr;
  if (o.kind === 'radial') gr = g.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, dist(a, b)));
  else gr = g.createLinearGradient(a.x, a.y, b.x, b.y);
  const [r2, g2, b2] = hex2rgb(S.color);
  gr.addColorStop(0, S.color);
  gr.addColorStop(1, o.toTransparent ? `rgba(${r2},${g2},${b2},0)` : S.color2);
  g.fillStyle = gr; g.fillRect(r.x, r.y, r.w, r.h);
}
tools.gradient = {
  down(p) { S.grad = { a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } }; },
  move(p) { if (S.grad) { S.grad.b = p.shift ? snapAngle(S.grad.a, p) : { x: p.x, y: p.y }; S.ovDirty = true; } },
  up() {
    const gd = S.grad; S.grad = null; S.ovDirty = true;
    if (!gd || dist(gd.a, gd.b) < ss(3)) return;
    begin('Gradien');
    const l = paintTarget();
    if (!l) { end(); return; }
    const r = gradRegion(), c = mk(r.w, r.h), g = cx2d(c);
    g.translate(-r.x, -r.y);
    paintGradient(g, gd.a, gd.b, r);
    drawToLayer(l, c, r.x, r.y, { alpha: S.tools.gradient.opacity });
    end('Gradien');
    emit('stroke');
  },
  overlay(o, M, px) {
    const gd = S.grad;
    if (!gd) return;
    const r = gradRegion();
    o.setTransform(M);
    o.save(); o.beginPath(); o.rect(r.x, r.y, r.w, r.h); o.clip();
    if (S.sel) { /* preview ignores mask shape, outline shows it */ }
    o.globalAlpha = .85 * S.tools.gradient.opacity; paintGradient(o, gd.a, gd.b, r); o.restore();
    handleLine(o, gd.a, gd.b, px);
  }
};
function handleLine(o, a, b, px) {
  const d = dpr();
  o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y);
  o.strokeStyle = '#fff'; o.lineWidth = 3 * px * d; o.stroke();
  o.strokeStyle = '#0a84ff'; o.lineWidth = 1.4 * px * d; o.stroke();
  for (const q of [a, b]) { o.beginPath(); o.arc(q.x, q.y, 6 * px * d, 0, 7); o.fillStyle = '#fff'; o.fill(); o.strokeStyle = '#0a84ff'; o.lineWidth = 2 * px * d; o.stroke(); }
}

// ---------------- shapes ----------------
export const SHAPES = [
  ['line', 'Garis'], ['arrow', 'Panah'], ['darrow', 'Panah 2 arah'], ['rect', 'Persegi'], ['roundrect', 'Persegi tumpul'], ['ellipse', 'Elips / lingkaran'],
  ['triangle', 'Segitiga'], ['rtriangle', 'Segitiga siku'], ['diamond', 'Belah ketupat'], ['polygon', 'Poligon'], ['star', 'Bintang'],
  ['heart', 'Hati'], ['bubble', 'Balon kata'], ['cross', 'Tanda tambah']
];
function shapeBox(sh) {
  const x = Math.min(sh.p0.x, sh.p1.x), y = Math.min(sh.p0.y, sh.p1.y);
  return { x, y, w: Math.abs(sh.p1.x - sh.p0.x), h: Math.abs(sh.p1.y - sh.p0.y) };
}
function shapePath(sh) {
  const o = S.tools.shape, P = new Path2D(), b = shapeBox(sh), { x, y, w, h } = b, cx = x + w / 2, cy = y + h / 2;
  const poly = pts => { pts.forEach((p, i) => i ? P.lineTo(p[0], p[1]) : P.moveTo(p[0], p[1])); P.closePath(); };
  switch (sh.kind) {
    case 'line': case 'arrow': case 'darrow': P.moveTo(sh.p0.x, sh.p0.y); P.lineTo(sh.p1.x, sh.p1.y); break;
    case 'rect': P.rect(x, y, w, h); break;
    case 'roundrect': { const r = Math.min(o.radius, w / 2, h / 2); P.roundRect ? P.roundRect(x, y, w, h, r) : P.rect(x, y, w, h); break; }
    case 'ellipse': P.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'triangle': poly([[cx, y], [x + w, y + h], [x, y + h]]); break;
    case 'rtriangle': poly([[x, y], [x, y + h], [x + w, y + h]]); break;
    case 'diamond': poly([[cx, y], [x + w, cy], [cx, y + h], [x, cy]]); break;
    case 'polygon': { const n = clamp(o.sides | 0, 3, 20), pts = []; for (let i = 0; i < n; i++) { const t = -Math.PI / 2 + i * Math.PI * 2 / n; pts.push([cx + Math.cos(t) * w / 2, cy + Math.sin(t) * h / 2]); } poly(pts); break; }
    case 'star': { const n = clamp(o.sides | 0, 3, 20), pts = []; for (let i = 0; i < n * 2; i++) { const t = -Math.PI / 2 + i * Math.PI / n, k = i % 2 ? .45 : 1; pts.push([cx + Math.cos(t) * w / 2 * k, cy + Math.sin(t) * h / 2 * k]); } poly(pts); break; }
    case 'heart':
      P.moveTo(cx, y + h * .28);
      P.bezierCurveTo(cx, y, x, y, x, y + h * .32);
      P.bezierCurveTo(x, y + h * .62, cx - w * .1, y + h * .78, cx, y + h);
      P.bezierCurveTo(cx + w * .1, y + h * .78, x + w, y + h * .62, x + w, y + h * .32);
      P.bezierCurveTo(x + w, y, cx, y, cx, y + h * .28); P.closePath(); break;
    case 'bubble': {
      const bh = h * .78, r = Math.min(w, bh) * .22;
      P.moveTo(x + r, y); P.lineTo(x + w - r, y); P.quadraticCurveTo(x + w, y, x + w, y + r); P.lineTo(x + w, y + bh - r); P.quadraticCurveTo(x + w, y + bh, x + w - r, y + bh);
      P.lineTo(x + w * .42, y + bh); P.lineTo(x + w * .2, y + h); P.lineTo(x + w * .26, y + bh); P.lineTo(x + r, y + bh);
      P.quadraticCurveTo(x, y + bh, x, y + bh - r); P.lineTo(x, y + r); P.quadraticCurveTo(x, y, x + r, y); P.closePath(); break;
    }
    case 'cross': { const t = Math.min(w, h) * .3; poly([[cx - t / 2, y], [cx + t / 2, y], [cx + t / 2, cy - t / 2], [x + w, cy - t / 2], [x + w, cy + t / 2], [cx + t / 2, cy + t / 2], [cx + t / 2, y + h], [cx - t / 2, y + h], [cx - t / 2, cy + t / 2], [x, cy + t / 2], [x, cy - t / 2], [cx - t / 2, cy - t / 2]]); break; }
  }
  return P;
}
export function dashArr(kind, w) {
  return kind === 'dash' ? [w * 3, w * 2] : kind === 'dot' ? [0.001, w * 2] : kind === 'dashdot' ? [w * 4, w * 2, 0.001, w * 2] : kind === 'long' ? [w * 7, w * 3] : [];
}
function arrowHead(g, a, b, w) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), L = Math.max(10, w * 4), s = .42;
  g.beginPath(); g.moveTo(b.x, b.y);
  g.lineTo(b.x - Math.cos(ang - s) * L, b.y - Math.sin(ang - s) * L);
  g.lineTo(b.x - Math.cos(ang + s) * L, b.y - Math.sin(ang + s) * L); g.closePath();
  g.setLineDash([]); g.fill();
}
function drawShape(g, sh) {
  const o = S.tools.shape, w = o.width;
  const line = ['line', 'arrow', 'darrow'].includes(sh.kind);
  g.save();
  g.lineJoin = 'round'; g.lineCap = o.dash === 'dot' || o.dash === 'dashdot' || line ? 'round' : 'butt';
  g.lineWidth = w;
  g.strokeStyle = S.color; g.fillStyle = o.mode === 'both' ? S.color2 : S.color;
  let a = sh.p0, b = sh.p1;
  if (line) {
    const L = Math.max(10, w * 4) * .8, ang = Math.atan2(b.y - a.y, b.x - a.x);
    const b2 = sh.kind !== 'line' && dist(a, b) > L ? { x: b.x - Math.cos(ang) * L, y: b.y - Math.sin(ang) * L } : b;
    const a2 = sh.kind === 'darrow' && dist(a, b) > L * 2 ? { x: a.x + Math.cos(ang) * L, y: a.y + Math.sin(ang) * L } : a;
    g.setLineDash(dashArr(o.dash, w));
    g.beginPath(); g.moveTo(a2.x, a2.y); g.lineTo(b2.x, b2.y); g.stroke();
    g.fillStyle = S.color;
    if (sh.kind !== 'line') arrowHead(g, a, b, w);
    if (sh.kind === 'darrow') arrowHead(g, b, a, w);
  } else {
    const P = shapePath(sh);
    if (o.mode !== 'stroke') g.fill(P);
    if (o.mode !== 'fill') { g.setLineDash(dashArr(o.dash, w)); g.stroke(P); }
  }
  g.restore();
}
function shapeHandles(sh) { return [sh.p0, sh.p1]; }
export function commitShape() {
  const sh = S.shape;
  S.shape = null; S.ovDirty = true;
  if (!sh) return;
  begin('Bentuk');
  const l = paintTarget();
  if (!l) { end(); return; }
  const pad = S.tools.shape.width * 5 + 4;
  const r = rInt(rPad(shapeBox(sh), pad));
  const c = mk(r.w, r.h), g = cx2d(c);
  g.translate(-r.x, -r.y);
  drawShape(g, sh);
  drawToLayer(l, c, r.x, r.y, { alpha: S.tools.shape.opacity });
  end('Bentuk');
  emit('stroke'); emit('tool');
}
tools.shape = (() => {
  let drag = null;
  return {
    down(p) {
      const sh = S.shape;
      if (sh) {
        const hs = shapeHandles(sh);
        for (let i = 0; i < 2; i++) { const q = w2s(hs[i]); if (Math.hypot(q.x - p.sx, q.y - p.sy) < 14) { drag = { h: i }; return; } }
        const b = rPad(shapeBox(sh), ss(10));
        if (rHas(b, p)) { drag = { h: 'move', p0: { ...sh.p0 }, p1: { ...sh.p1 }, s: { x: p.x, y: p.y } }; return; }
        commitShape();
      }
      S.shape = { kind: S.tools.shape.kind, p0: { x: p.x, y: p.y }, p1: { x: p.x, y: p.y }, o: { x: p.x, y: p.y } };
      drag = { h: 'new' };
      emit('tool');
    },
    move(p) {
      const sh = S.shape;
      if (!sh || !drag) return;
      if (drag.h === 'move') {
        const dx = p.x - drag.s.x, dy = p.y - drag.s.y;
        sh.p0 = { x: drag.p0.x + dx, y: drag.p0.y + dy }; sh.p1 = { x: drag.p1.x + dx, y: drag.p1.y + dy };
      } else {
        const line = ['line', 'arrow', 'darrow'].includes(sh.kind);
        const fixed = drag.h === 'new' ? sh.o : drag.h === 0 ? sh.p1 : sh.p0;
        let q = { x: p.x, y: p.y };
        if (p.shift) {
          if (line) q = snapAngle(fixed, q);
          else { const s = Math.max(Math.abs(q.x - fixed.x), Math.abs(q.y - fixed.y)); q = { x: fixed.x + Math.sign(q.x - fixed.x || 1) * s, y: fixed.y + Math.sign(q.y - fixed.y || 1) * s }; }
        }
        if (drag.h === 'new' && p.alt && !line) { sh.p0 = { x: 2 * fixed.x - q.x, y: 2 * fixed.y - q.y }; sh.p1 = q; }
        else if (drag.h === 0) sh.p0 = q; else sh.p1 = q;
      }
      S.ovDirty = true;
    },
    up() {
      const sh = S.shape;
      if (sh && drag && drag.h === 'new' && dist(sh.p0, sh.p1) < ss(4)) { S.shape = null; S.ovDirty = true; }
      drag = null; emit('tool');
    },
    overlay(o, M, px) {
      const sh = S.shape;
      if (!sh) return;
      o.setTransform(M);
      o.globalAlpha = S.tools.shape.opacity;
      drawShape(o, sh);
      o.globalAlpha = 1;
      const b = shapeBox(sh), d = dpr();
      if (!['line', 'arrow', 'darrow'].includes(sh.kind)) {
        o.setLineDash([4 * px * d, 4 * px * d]); o.strokeStyle = '#0a84ff'; o.lineWidth = px * d; o.strokeRect(b.x, b.y, b.w, b.h); o.setLineDash([]);
      }
      for (const q of shapeHandles(sh)) { o.beginPath(); o.arc(q.x, q.y, 6 * px * d, 0, 7); o.fillStyle = '#fff'; o.fill(); o.strokeStyle = '#0a84ff'; o.lineWidth = 2 * px * d; o.stroke(); }
    }
  };
})();

// ---------------- selection ----------------
function selMode(p) {
  if (p.shift && p.alt) return 'inter';
  if (p.shift) return 'add';
  if (p.alt) return 'sub';
  return S.tools.select.mode;
}
tools.select = (() => {
  let d = null;
  return {
    down(p) {
      const k = S.tools.select.kind;
      if (k === 'wand') {
        const f = floodMask(p, S.tools.pick.all !== false, S.tools.select.tol, true);
        if (!f) return false;
        const c = maskCanvas(f, '#000');
        selSet(f.r, g => g.drawImage(c, f.r.x, f.r.y), selMode(p));
        return false;
      }
      d = { kind: k, a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y }, pts: [{ x: p.x, y: p.y }], mode: selMode(p), s: p };
      S.selDrag = d;
    },
    move(p) {
      if (!d) return;
      let b = { x: p.x, y: p.y };
      if (p.shift && d.kind !== 'lasso' && d.mode !== 'add') { const s = Math.max(Math.abs(b.x - d.a.x), Math.abs(b.y - d.a.y)); b = { x: d.a.x + Math.sign(b.x - d.a.x || 1) * s, y: d.a.y + Math.sign(b.y - d.a.y || 1) * s }; }
      d.b = b;
      if (d.kind === 'lasso') d.pts.push(b);
      S.ovDirty = true;
    },
    up(p) {
      const q = d; d = null; S.selDrag = null; S.ovDirty = true;
      if (!q) return;
      if (Math.hypot(p.sx - q.s.sx, p.sy - q.s.sy) < 4) { if (q.mode === 'new') selClear(); return; }
      const path = selPath(q);
      let r;
      if (q.kind === 'lasso') { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const t of q.pts) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x); y1 = Math.max(y1, t.y); } r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
      else r = { x: Math.min(q.a.x, q.b.x), y: Math.min(q.a.y, q.b.y), w: Math.abs(q.b.x - q.a.x), h: Math.abs(q.b.y - q.a.y) };
      const pr = paperRect();
      if (pr) r = rInter(r, pr) || r;
      selSet(r, g => { if (pr) { g.save(); g.beginPath(); g.rect(pr.x, pr.y, pr.w, pr.h); g.clip(); } g.fill(path); if (pr) g.restore(); }, q.mode);
    },
    overlay(o, M, px) {
      const q = S.selDrag;
      if (!q) return;
      o.setTransform(M);
      const P = selPath(q), d = dpr();
      o.fillStyle = 'rgba(10,132,255,.08)'; o.fill(P);
      o.lineWidth = 1.2 * px * d; o.strokeStyle = '#fff'; o.stroke(P);
      o.setLineDash([5 * px * d, 4 * px * d]); o.strokeStyle = '#0a84ff'; o.stroke(P); o.setLineDash([]);
    }
  };
})();
function selPath(q) {
  const P = new Path2D();
  if (q.kind === 'lasso') { q.pts.forEach((t, i) => i ? P.lineTo(t.x, t.y) : P.moveTo(t.x, t.y)); P.closePath(); }
  else {
    const x = Math.min(q.a.x, q.b.x), y = Math.min(q.a.y, q.b.y), w = Math.abs(q.b.x - q.a.x), h = Math.abs(q.b.y - q.a.y);
    if (q.kind === 'ellipse') P.ellipse(x + w / 2, y + h / 2, Math.max(.5, w / 2), Math.max(.5, h / 2), 0, 0, Math.PI * 2); else P.rect(x, y, w, h);
  }
  return P;
}

// ---------------- transform gizmo (move tool) ----------------
function gizmoBox() {
  if (S.float) return S.float.box;
  const l = activeLayer();
  if (!l || !l.visible) return null;
  if (l.type !== 'raster') return objBox(l);
  const cb = contentBounds(l);
  const b = S.sel ? rInter(selRect(), cb || selRect()) : cb;
  return b && { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rot: 0, fx: 1, fy: 1 };
}
const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
function local2world(b, lx, ly) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  return { x: b.cx + lx * c - ly * s, y: b.cy + lx * s + ly * c };
}
function world2local(b, p) {
  const c = Math.cos(-b.rot), s = Math.sin(-b.rot), dx = p.x - b.cx, dy = p.y - b.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
function gizmoHit(b, p) {
  const rh = local2world(b, 0, -b.h / 2 - ss(28)), q = w2s(rh);
  if (Math.hypot(q.x - p.sx, q.y - p.sy) < 14) return 'rot';
  for (const [sx, sy] of HANDLES) {
    const w = w2s(local2world(b, sx * b.w / 2, sy * b.h / 2));
    if (Math.hypot(w.x - p.sx, w.y - p.sy) < 13) return [sx, sy];
  }
  const l = world2local(b, p);
  if (Math.abs(l.x) <= b.w / 2 + ss(6) && Math.abs(l.y) <= b.h / 2 + ss(6)) return 'move';
  // just outside the corners: rotate
  if (Math.abs(l.x) <= b.w / 2 + ss(30) && Math.abs(l.y) <= b.h / 2 + ss(30)) return 'rot';
  return null;
}
function applyBox(b, start) {
  if (S.float) { S.float.box = b; S.dirty = true; return; }
  const l = activeLayer();
  if (l.type === 'image') Object.assign(l.data, { cx: b.cx, cy: b.cy, w: b.w, h: b.h, rot: b.rot, fx: b.fx, fy: b.fy });
  else if (l.type === 'text') { l.data.cx = b.cx; l.data.cy = b.cy; l.data.rot = b.rot; if (start && b.h !== start.h) l.data.size = Math.max(4, start.size * b.h / start.h); }
  l.ver++;
  S.dirty = true;
}
export function startFloat() {
  const l = activeLayer();
  if (!l || l.type !== 'raster' || S.float) return !!S.float;
  if (l.locked) { toast('Lapisan terkunci 🔒'); return false; }
  const cb = contentBounds(l);
  const area = rInt(S.sel ? (rInter(selRect(), cb || selRect())) : cb || { x: 0, y: 0, w: 0, h: 0 });
  if (!area || area.w < 1 || area.h < 1) { toast('Lapisan ini masih kosong'); return false; }
  begin('Ubah');
  const c = layerRegion(l, area);
  if (S.sel) { const g = cx2d(c); g.globalCompositeOperation = 'destination-in'; g.drawImage(S.sel.c, S.sel.x - area.x, S.sel.y - area.y); }
  clearRegion(l, area, S.sel);
  S.float = { layer: l, c, box: { cx: area.x + area.w / 2, cy: area.y + area.h / 2, w: area.w, h: area.h, rot: 0, fx: 1, fy: 1 }, sel: S.sel };
  S.float.box0 = { ...S.float.box };
  S.sel = null;
  S.dirty = S.ovDirty = true;
  emit('tool');
  return true;
}
function drawBoxed(g, c, b) {
  g.save(); g.translate(b.cx, b.cy); g.rotate(b.rot); g.scale(b.fx, b.fy);
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, -b.w / 2, -b.h / 2, b.w, b.h); g.restore();
}
export function commitFloat() {
  const f = S.float;
  if (!f) return;
  S.float = null;
  const b = f.box, r = rInt(rotRectAABB(b.cx, b.cy, b.w, b.h, b.rot));
  if (r.w > 0 && r.h > 0) {
    const c = mk(r.w, r.h), g = cx2d(c);
    g.translate(-r.x, -r.y); drawBoxed(g, f.c, b);
    drawToLayer(f.layer, c, r.x, r.y, { op: 'source-over', noSel: true });
  }
  end('Ubah');
  if (f.sel) { // carry the selection along
    const b0 = f.box0, s = f.sel;
    const m = mk(r.w, r.h), g = cx2d(m);
    g.translate(-r.x, -r.y);
    const tmp = mk(b0.w, b0.h); cx2d(tmp).drawImage(s.c, s.x - (b0.cx - b0.w / 2), s.y - (b0.cy - b0.h / 2));
    drawBoxed(g, tmp, b);
    setSelCanvas(m, r.x, r.y);
  }
  S.dirty = S.ovDirty = true;
  emit('stroke'); emit('tool');
}
export function cancelFloat() {
  const f = S.float;
  if (!f) return;
  S.float = null;
  abort();
  S.sel = f.sel;
  S.dirty = S.ovDirty = true;
  emit('tool');
}
export function floatOp(op) {
  const l = activeLayer();
  if (!l) return;
  if (l.type === 'raster' && !S.float && !startFloat()) return;
  const b = { ...(gizmoBox() || {}) };
  if (!b.w) return;
  if (!S.float) begin('Ubah');
  if (op === 'fh') b.fx = -b.fx;
  if (op === 'fv') b.fy = -b.fy;
  if (op === 'r90') b.rot += Math.PI / 2;
  if (op === 'r-90') b.rot -= Math.PI / 2;
  if (op === 'reset' && S.float) Object.assign(b, S.float.box0);
  if (op === 'center') { const r = paperRect() || visibleRect(); b.cx = r.x + r.w / 2; b.cy = r.y + r.h / 2; }
  if (op === 'fit') { const r = paperRect() || visibleRect(), k = Math.min(r.w / b.w, r.h / b.h); b.w *= k; b.h *= k; b.cx = r.x + r.w / 2; b.cy = r.y + r.h / 2; b.rot = 0; }
  applyBox(b, l.type === 'text' ? { h: objBox(l).h, size: l.data.size } : null);
  if (!S.float) end('Ubah');
  S.ovDirty = true;
}
export function nudge(dx, dy) {
  const l = activeLayer();
  if (!l) return;
  if (l.type === 'raster' && !S.float && !startFloat()) return;
  const b = { ...gizmoBox() };
  b.cx += dx; b.cy += dy;
  if (!S.float) begin('Geser');
  applyBox(b);
  if (!S.float) end('Geser');
  S.ovDirty = true;
}
function pickLayerAt(p) {
  for (let i = S.doc.layers.length - 1; i >= 0; i--) {
    const l = S.doc.layers[i];
    if (!l.visible) continue;
    if (l.type !== 'raster') {
      const b = objBox(l), q = world2local(b, p);
      if (Math.abs(q.x) <= b.w / 2 && Math.abs(q.y) <= b.h / 2) return l;
    } else {
      const t = l.tiles.get(key(Math.floor(p.x / T), Math.floor(p.y / T)));
      if (t && cx2d(t, { willReadFrequently: true }).getImageData(((p.x % T) + T) % T | 0, ((p.y % T) + T) % T | 0, 1, 1).data[3] > 20) return l;
    }
  }
  return null;
}
tools.move = (() => {
  let d = null;
  return {
    enter() { S.ovDirty = true; },
    down(p) {
      let b = gizmoBox(), h = b && gizmoHit(b, p);
      if (!h) {
        if (S.float) { commitFloat(); return false; }
        const l = pickLayerAt(p);
        if (l && l.id !== S.doc.active) { S.doc.active = l.id; emit('layers'); b = gizmoBox(); h = b && gizmoHit(b, p); }
        if (!h) { S.ovDirty = true; return false; }
      }
      const l = activeLayer();
      if (l.locked) { toast('Lapisan terkunci 🔒'); return false; }
      if (l.type === 'raster' && !S.float && !startFloat()) return false;
      if (!S.float) begin('Ubah');
      b = gizmoBox();
      d = { h, b0: { ...b }, p0: { x: p.x, y: p.y }, text: l.type === 'text' ? { h: b.h, size: l.data.size } : null, keep: l.type !== 'raster' || true };
    },
    move(p) {
      if (!d) return;
      const b0 = d.b0, b = { ...b0 };
      if (d.h === 'move') { b.cx = b0.cx + p.x - d.p0.x; b.cy = b0.cy + p.y - d.p0.y; }
      else if (d.h === 'rot') {
        let a = b0.rot + Math.atan2(p.y - b0.cy, p.x - b0.cx) - Math.atan2(d.p0.y - b0.cy, d.p0.x - b0.cx);
        if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        b.rot = a;
      } else {
        let [sx, sy] = d.h;
        if (d.text && (!sx || !sy)) { sx = sx || 1; sy = sy || 1; }
        const anchorL = p.alt ? { x: 0, y: 0 } : { x: -sx * b0.w / 2, y: -sy * b0.h / 2 };
        const A = local2world(b0, anchorL.x, anchorL.y);
        const c = Math.cos(-b0.rot), s = Math.sin(-b0.rot), dx = p.x - A.x, dy = p.y - A.y;
        const q = { x: dx * c - dy * s, y: dx * s + dy * c };
        const k = p.alt ? 2 : 1;
        let w = sx ? Math.max(2, q.x * sx * k) : b0.w, h = sy ? Math.max(2, q.y * sy * k) : b0.h;
        if ((sx && sy && !p.shift) || d.text) { const f = Math.max(w / b0.w, h / b0.h); w = b0.w * f; h = b0.h * f; }
        b.w = w; b.h = h;
        const off = p.alt ? { x: 0, y: 0 } : { x: sx ? sx * w / 2 : 0, y: sy ? sy * h / 2 : 0 };
        const cc = Math.cos(b0.rot), sn = Math.sin(b0.rot);
        b.cx = A.x + off.x * cc - off.y * sn; b.cy = A.y + off.x * sn + off.y * cc;
      }
      applyBox(b, d.text);
      S.ovDirty = true;
    },
    up() { if (!d) return; d = null; if (!S.float) { end('Ubah'); emit('stroke'); } S.ovDirty = true; emit('tool'); },
    cancel() { if (d) { d = null; if (!S.float) abort(); } },
    overlay(o, M, px) {
      const b = gizmoBox();
      if (!b) return;
      drawGizmo(o, M, b, px);
    }
  };
})();
function drawGizmo(o, M, b, px) {
  const dd = dpr();
  o.setTransform(M);
  o.save(); o.translate(b.cx, b.cy); o.rotate(b.rot);
  o.strokeStyle = '#0a84ff'; o.lineWidth = 1.5 * px * dd;
  o.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  o.beginPath(); o.moveTo(0, -b.h / 2); o.lineTo(0, -b.h / 2 - ss(28)); o.stroke();
  o.restore();
  const hs = 5 * px * dd;
  for (const [sx, sy] of HANDLES) {
    const q = local2world(b, sx * b.w / 2, sy * b.h / 2);
    o.save(); o.translate(q.x, q.y); o.rotate(b.rot);
    o.fillStyle = '#fff'; o.fillRect(-hs, -hs, hs * 2, hs * 2); o.strokeStyle = '#0a84ff'; o.lineWidth = 1.5 * px * dd; o.strokeRect(-hs, -hs, hs * 2, hs * 2);
    o.restore();
  }
  const r = local2world(b, 0, -b.h / 2 - ss(28));
  o.beginPath(); o.arc(r.x, r.y, 6.5 * px * dd, 0, 7); o.fillStyle = '#0a84ff'; o.fill(); o.strokeStyle = '#fff'; o.lineWidth = 2 * px * dd; o.stroke();
}

// ---------------- text ----------------
const TEXT_DEF = () => ({ ...S.tools.text, text: '', color: S.color, rot: 0 });
function textAt(p) {
  for (let i = S.doc.layers.length - 1; i >= 0; i--) {
    const l = S.doc.layers[i];
    if (l.type !== 'text' || !l.visible) continue;
    const b = textBox(l), q = world2local(b, p);
    if (Math.abs(q.x) <= b.w / 2 + ss(4) && Math.abs(q.y) <= b.h / 2 + ss(4)) return l;
  }
  return null;
}
export function editText(l, fresh) {
  if (S.textEdit) finishText();
  if (!fresh) begin('Teks');
  S.doc.active = l.id;
  const b = textBox(l), tl = local2world(b, -b.w / 2, -b.h / 2);
  S.textEdit = { layer: l, anchor: tl };
  const ta = $('#ted');
  ta.value = l.data.text;
  ta.hidden = false;
  placeEditor();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  emit('layers'); emit('tool');
}
export function placeEditor() {
  const te = S.textEdit;
  if (!te) return;
  const l = te.layer, d = l.data, b = textBox(l), ta = $('#ted');
  // keep the top-left corner fixed while typing
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  d.cx = te.anchor.x + (b.w / 2) * c - (b.h / 2) * s;
  d.cy = te.anchor.y + (b.w / 2) * s + (b.h / 2) * c;
  const m = vm(1).translate(d.cx, d.cy).rotate(b.rot * 180 / Math.PI).translate(-b.w / 2, -b.h / 2);
  const pad = (d.stroke || 0) + (d.bgColor ? d.size * .25 : 0), padY = (d.stroke || 0) + (d.bgColor ? d.size * .15 : 0);
  Object.assign(ta.style, {
    transform: `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`, width: (b.w + d.size) + 'px', height: b.h + 'px',
    font: fontStr(d), lineHeight: d.size * d.lh + 'px', padding: `${padY}px ${pad}px`, textAlign: d.align, caretColor: d.color
  });
  S.dirty = S.ovDirty = true;
}
export function finishText() {
  const te = S.textEdit;
  if (!te) return;
  S.textEdit = null;
  const ta = $('#ted');
  ta.hidden = true; ta.blur();
  const l = te.layer;
  if (!String(l.data.text).trim()) {
    const i = S.doc.layers.indexOf(l);
    if (i >= 0) S.doc.layers.splice(i, 1);
    S.doc.active = (S.doc.layers[Math.max(0, i - 1)] || {}).id || null;
  } else if (l.name === 'Teks' || l._autoName) { l.name = String(l.data.text).split('\n')[0].slice(0, 24); l._autoName = true; }
  end('Teks');
  emit('layers'); emit('tool');
  S.dirty = S.ovDirty = true;
}
export function applyTextOpts(patch) {
  Object.assign(S.tools.text, patch);
  savePrefs();
  const l = S.textEdit ? S.textEdit.layer : activeLayer();
  if (!l || l.type !== 'text') return;
  if (!S.textEdit) begin('Format teks');
  const { color, ...rest } = patch;
  Object.assign(l.data, rest);
  if (color) l.data.color = color;
  l.ver++;
  if (!S.textEdit) end('Format teks'); else placeEditor();
  S.dirty = S.ovDirty = true;
}
tools.text = {
  down(p) {
    if (S.textEdit) { const l = textAt(p); if (l === S.textEdit.layer) return false; finishText(); return false; }
    const hit = textAt(p);
    if (hit) { if (hit.locked) { toast('Lapisan terkunci 🔒'); return false; } editText(hit); return false; }
    const l = newLayer('text', 'Teks');
    l._autoName = true;
    l.data = TEXT_DEF();
    begin('Teks');
    insertLayer(l);
    // anchor the top-left at the click
    const b = textBox(l);
    l.data.cx = p.x + b.w / 2; l.data.cy = p.y - l.data.size * l.data.lh / 2 + b.h / 2;
    editText(l, true);
    return false;
  },
  overlay(o, M, px) {
    const l = S.textEdit ? S.textEdit.layer : activeLayer();
    if (!l || l.type !== 'text') return;
    const b = textBox(l), dd = dpr();
    o.setTransform(M); o.translate(b.cx, b.cy); o.rotate(b.rot);
    o.setLineDash([4 * px * dd, 3 * px * dd]); o.strokeStyle = '#0a84ff'; o.lineWidth = px * dd;
    o.strokeRect(-b.w / 2 - ss(4), -b.h / 2 - ss(4), b.w + ss(8), b.h + ss(8)); o.setLineDash([]);
  }
};

tools.hand = { down() { return 'pan'; } };

// ---------------- overlay painter ----------------
S.paintOverlay = (o, M, px) => {
  for (const n of ['shape', 'gradient', 'select']) tools[n].overlay(o, M, px);
  if (S.tool === 'move') tools.move.overlay(o, M, px);
  if (S.tool === 'text' || S.textEdit) tools.text.overlay(o, M, px);
  if (S.loupe) {
    const L = S.loupe, d = dpr();
    o.setTransform(d, 0, 0, d, 0, 0);
    const x = L.x, y = L.y - 70, r = 38;
    o.lineWidth = 14;
    o.beginPath(); o.arc(x, y, r, Math.PI, 0); o.strokeStyle = L.c; o.stroke();
    o.beginPath(); o.arc(x, y, r, 0, Math.PI); o.strokeStyle = L.old || L.c; o.stroke();
    o.lineWidth = 1.5; o.strokeStyle = 'rgba(0,0,0,.35)';
    o.beginPath(); o.arc(x, y, r + 7, 0, 7); o.stroke(); o.beginPath(); o.arc(x, y, r - 7, 0, 7); o.stroke();
  }
};

// ---------------- input ----------------
function touches() { return [...pointers.values()].filter(p => p.type === 'touch'); }
function startGesture() {
  const ts = touches().slice(0, 2);
  const mid = { x: (ts[0].sx + ts[1].sx) / 2, y: (ts[0].sy + ts[1].sy) / 2 };
  const prev = gesture;
  gesture = {
    n: Math.max(touches().length, prev ? prev.n : 0), t0: prev ? prev.t0 : performance.now(), moved: prev ? prev.moved : 0,
    d0: Math.hypot(ts[1].sx - ts[0].sx, ts[1].sy - ts[0].sy) || 1,
    a0: Math.atan2(ts[1].sy - ts[0].sy, ts[1].sx - ts[0].sx),
    z0: S.view.z, r0: S.view.r, w: s2w(mid.x, mid.y), m0: mid
  };
}
function moveGesture() {
  const ts = touches().slice(0, 2);
  if (ts.length < 2) return;
  const mid = { x: (ts[0].sx + ts[1].sx) / 2, y: (ts[0].sy + ts[1].sy) / 2 };
  const d = Math.hypot(ts[1].sx - ts[0].sx, ts[1].sy - ts[0].sy) || 1, a = Math.atan2(ts[1].sy - ts[0].sy, ts[1].sx - ts[0].sx);
  const g = gesture;
  g.moved = Math.max(g.moved, Math.hypot(mid.x - g.m0.x, mid.y - g.m0.y), Math.abs(d - g.d0));
  S.view.z = clamp(g.z0 * d / g.d0, 0.02, 64);
  let dr = a - g.a0;
  if (S.view.flip) dr = -dr;
  let r = g.r0 + dr;
  const deg = ((r * 180 / Math.PI) % 360 + 360) % 360;
  if (Math.abs(dr) < 0.09 && !g.rotating) r = g.r0; else g.rotating = true;
  for (const s of [0, 90, 180, 270, 360]) if (Math.abs(deg - s) < 4) r = s * Math.PI / 180;
  S.view.r = r;
  const w = s2w(mid.x, mid.y);
  S.view.x += g.w.x - w.x; S.view.y += g.w.y - w.y;
  viewChanged();
}
function abortCurrent() {
  if (cur && cur.cancel) cur.cancel();
  cur = null;
}

export function initInput() {
  const cv = canvasEl();
  cv.addEventListener('pointerdown', e => {
    if (!S.doc) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) { }
    if (e.pointerType === 'pen' && !S.penSeen) { S.penSeen = true; emit('pen'); }
    const p = mkPt(e);
    pointers.set(e.pointerId, { type: e.pointerType, sx: p.sx, sy: p.sy, t: e.timeStamp });
    if (e.pointerType === 'touch' && touches().length >= 2) {
      if (cur) { abortCurrent(); }
      panDrag = null;
      startGesture();
      return;
    }
    if (gesture) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.id !== 'ted') document.activeElement.blur();
    const fingerNav = e.pointerType === 'touch' && S.penSeen && !S.prefs.fingerDraw;
    if (e.button === 1 || spaceDown || S.tool === 'hand' || fingerNav) { panDrag = { x: p.sx, y: p.sy }; updateCursor(); return; }
    if (e.button === 2) return;
    // ruler manipulation
    if (S.ruler.on) {
      const { A, B, u, n } = rulerGeom();
      const hitA = Math.hypot(p.sx - A.x, p.sy - A.y) < 16, hitB = Math.hypot(p.sx - B.x, p.sy - B.y) < 16;
      const t = (p.sx - A.x) * u.x + (p.sy - A.y) * u.y, dn = (p.sx - A.x) * n.x + (p.sy - A.y) * n.y;
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (hitA || hitB) { special = { kind: 'rulerEnd', end: hitA ? 'a' : 'b' }; return; }
      if (t > 0 && t < L && dn >= 0 && dn <= RULER_W) { special = { kind: 'rulerMove', p0: { x: p.x, y: p.y }, a: { ...S.ruler.a }, b: { ...S.ruler.b } }; return; }
    }
    if (S.sym.on) {
      const c = w2s({ x: S.sym.cx, y: S.sym.cy });
      if (Math.hypot(p.sx - c.x, p.sy - c.y) < 14) { special = { kind: 'sym' }; return; }
    }
    let tool = S.tool;
    if (e.altKey && ['brush', 'eraser', 'smudge', 'fill', 'gradient', 'shape'].includes(tool)) { tempPick = tool; tool = 'picker'; }
    const t = tools[tool];
    if (!t || !t.down) return;
    const r = t.down(p);
    if (r === 'pan') { panDrag = { x: p.sx, y: p.sy }; updateCursor(); return; }
    cur = r === false ? null : t;
    cur && (cur._prev = p);
    if (tool === 'picker' && !tempPick) cur = t;
    S.ovDirty = true;
  });
  cv.addEventListener('pointermove', e => {
    if (!S.doc) return;
    const pp = pointers.get(e.pointerId);
    const p = mkPt(e, cur && cur._prev);
    if (pp) { pp.sx = p.sx; pp.sy = p.sy; }
    if (gesture) { moveGesture(); return; }
    if (panDrag) { panBy(p.sx - panDrag.x, p.sy - panDrag.y); panDrag = { x: p.sx, y: p.sy }; return; }
    if (special) {
      if (special.kind === 'rulerEnd') { S.ruler[special.end] = e.shiftKey ? snapAngle(S.ruler[special.end === 'a' ? 'b' : 'a'], p) : { x: p.x, y: p.y }; }
      else if (special.kind === 'rulerMove') { const dx = p.x - special.p0.x, dy = p.y - special.p0.y; S.ruler.a = { x: special.a.x + dx, y: special.a.y + dy }; S.ruler.b = { x: special.b.x + dx, y: special.b.y + dy }; }
      else if (special.kind === 'sym') { S.sym.cx = p.x; S.sym.cy = p.y; }
      S.ovDirty = true; return;
    }
    if (cur && cur.move) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      let prev = cur._prev;
      const pts = (evs.length ? evs : [e]).map(ev => { const q = mkPt(ev, prev); prev = q; return q; });
      cur.move(p, pts);
      cur._prev = p;
    }
    const t = tools[S.tool];
    if (t && t.hover && e.pointerType !== 'touch') { t.hover(p); S.ovDirty = true; }
    lastHover = p;
    emit('pointer', p);
  });
  const up = e => {
    const pp = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (gesture) {
      if (!touches().length) {
        const g = gesture; gesture = null;
        if (performance.now() - g.t0 < 320 && g.moved < 12) {
          if (g.n === 2) { const l = undo(); l && toast('Urungkan: ' + l, 1000); }
          else if (g.n >= 3) { const l = redo(); l && toast('Ulangi: ' + l, 1000); }
        }
      } else if (touches().length >= 2) startGesture();
      return;
    }
    if (panDrag) { panDrag = null; updateCursor(); return; }
    if (special) { special = null; S.ovDirty = true; return; }
    if (cur) { const c = cur; cur = null; c.up && c.up(mkPt(e)); }
    else if (tempPick) { const t = tempPick; tempPick = null; setTool(t); }
    void pp;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); if (gesture && !touches().length) gesture = null; if (cur) { abortCurrent(); } panDrag = null; special = null; });
  cv.addEventListener('pointerleave', () => { S.cursor = null; S.ovDirty = true; });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    if (!S.doc) return;
    e.preventDefault();
    const s = clientToScreen(e);
    const notched = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || e.altKey || notched) {
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(s.x, s.y, Math.exp(-dy * (e.ctrlKey && !notched ? 0.012 : 0.0022)));
    } else panBy(-e.deltaX, -e.deltaY);
    if (lastHover) { const t = tools[S.tool]; const w = s2w(s.x, s.y); t && t.hover && t.hover({ ...lastHover, x: w.x, y: w.y }); }
  }, { passive: false });
  // Safari trackpad pinch
  let gs = 1;
  cv.addEventListener('gesturestart', e => { e.preventDefault(); gs = 1; });
  cv.addEventListener('gesturechange', e => { e.preventDefault(); const s = clientToScreen(e); zoomAt(s.x, s.y, e.scale / gs); gs = e.scale; });

  window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); } });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; updateCursor(); } });
  const ta = $('#ted');
  ta.addEventListener('input', () => { if (!S.textEdit) return; S.textEdit.layer.data.text = ta.value; S.textEdit.layer.ver++; placeEditor(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); finishText(); }
    e.stopPropagation();
  });
  updateCursor();
}
export const isTyping = e => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
export { tools };
