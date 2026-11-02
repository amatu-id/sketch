// Document model: tiled raster layers, text/image layers, history, compositing.
import { S, T, mk, cx2d, uid, rUnion, rInter, rPad, rInt, emit, clamp } from './state.js';

export const key = (tx, ty) => tx + ',' + ty;
export const unkey = k => k.split(',').map(Number);

export const BLENDS = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Gelapkan'], ['lighten', 'Terangkan'], ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'],
  ['hue', 'Hue'], ['saturation', 'Saturasi'], ['color', 'Warna'], ['luminosity', 'Luminositas']
];

export function newLayer(type = 'raster', name) {
  const d = S.doc;
  const n = d ? d.layers.length + 1 : 1;
  return {
    id: uid(), type, name: name || (type === 'text' ? 'Teks' : type === 'image' ? 'Gambar' : 'Lapisan ' + n),
    visible: true, opacity: 1, blend: 'source-over', locked: false, alphaLock: false, clip: false,
    tiles: new Map(), ver: 0, data: null
  };
}

export function newDoc(o = {}) {
  const d = {
    id: uid(), name: o.name || 'Tanpa judul', w: o.w || 1240, h: o.h || 1754, infinite: !!o.infinite,
    dpi: o.dpi || 150, bg: o.bg || '#ffffff', bgOn: o.bgOn !== false, paper: o.paper || 'plain', paperSp: o.paperSp || 40,
    layers: [], active: null, created: Date.now(), updated: Date.now(), view: null
  };
  return d;
}

export const activeLayer = () => S.doc && S.doc.layers.find(l => l.id === S.doc.active);
export const layerById = id => S.doc.layers.find(l => l.id === id);
export const paperRect = () => S.doc && !S.doc.infinite ? { x: 0, y: 0, w: S.doc.w, h: S.doc.h } : null;

// ---------------- history ----------------
export const H = { undo: [], redo: [], tx: null, limit: 80 };

function propsOf(l) {
  return {
    name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked,
    alphaLock: l.alphaLock, clip: l.clip, data: l.data ? JSON.parse(JSON.stringify(l.data, (k, v) => k === 'src' ? undefined : v)) : null
  };
}
function structSnap() {
  const d = S.doc;
  return { layers: d.layers.slice(), props: d.layers.map(propsOf), active: d.active, w: d.w, h: d.h, infinite: d.infinite, bg: d.bg, bgOn: d.bgOn, paper: d.paper, paperSp: d.paperSp };
}
function structRestore(s) {
  const d = S.doc;
  d.layers = s.layers.slice();
  s.layers.forEach((l, i) => {
    const p = s.props[i], src = l.data && l.data.src;
    Object.assign(l, p);
    if (p.data) { l.data = JSON.parse(JSON.stringify(p.data)); if (src) l.data.src = src; }
    l.ver++;
  });
  Object.assign(d, { active: s.active, w: s.w, h: s.h, infinite: s.infinite, bg: s.bg, bgOn: s.bgOn, paper: s.paper, paperSp: s.paperSp });
}
const sameStruct = (a, b) => a.layers.length === b.layers.length && a.layers.every((l, i) => l === b.layers[i]) &&
  JSON.stringify([a.props, a.active, a.w, a.h, a.infinite, a.bg, a.bgOn, a.paper, a.paperSp]) === JSON.stringify([b.props, b.active, b.w, b.h, b.infinite, b.bg, b.bgOn, b.paper, b.paperSp]);

function swapPatch(p) {
  for (const [k, c] of p.before) {
    const cur = p.layer.tiles.get(k) || null;
    if (c) p.layer.tiles.set(k, c); else p.layer.tiles.delete(k);
    p.before.set(k, cur);
  }
  p.layer.ver++;
}

export function begin(label) {
  if (H.tx) { H.tx.depth++; return; }
  H.tx = { label, s0: structSnap(), patches: new Map(), depth: 1 };
}
export function touch(layer, k) {
  const tx = H.tx;
  if (!tx) return;
  let p = tx.patches.get(layer.id);
  if (!p) tx.patches.set(layer.id, p = { layer, before: new Map() });
  if (p.before.has(k)) return;
  const t = layer.tiles.get(k);
  p.before.set(k, t ? cloneCanvas(t) : null);
}
export function end(label) {
  const tx = H.tx;
  if (!tx) return;
  if (--tx.depth > 0) return;
  H.tx = null;
  const s1 = structSnap();
  const patches = [...tx.patches.values()];
  if (!patches.length && sameStruct(tx.s0, s1)) return;
  H.undo.push({ label: label || tx.label, s0: tx.s0, s1, patches });
  if (H.undo.length > H.limit) H.undo.shift();
  H.redo.length = 0;
  changed();
}
// roll back an open transaction (cancelled transform etc.)
export function abort() {
  const tx = H.tx;
  if (!tx) return;
  H.tx = null;
  tx.patches.forEach(swapPatch);
  structRestore(tx.s0);
  changed(true);
}
export function undo() {
  if (H.tx || !H.undo.length) return false;
  const e = H.undo.pop();
  e.patches.forEach(swapPatch); structRestore(e.s0);
  H.redo.push(e); changed(); return e.label;
}
export function redo() {
  if (H.tx || !H.redo.length) return false;
  const e = H.redo.pop();
  structRestore(e.s1); e.patches.forEach(swapPatch);
  H.undo.push(e); changed(); return e.label;
}
export function changed(noSave) {
  S.dirty = true; S.ovDirty = true;
  if (S.doc) S.doc.updated = Date.now();
  emit('changed', { noSave });
}

// ---------------- tiles ----------------
export function cloneCanvas(c) {
  const n = mk(c.width, c.height);
  cx2d(n).drawImage(c, 0, 0);
  return n;
}
export function tileW(layer, tx, ty) {
  const k = key(tx, ty);
  touch(layer, k);
  let t = layer.tiles.get(k);
  if (!t) { t = mk(T, T); layer.tiles.set(k, t); }
  t._blob = null;
  layer.ver++;
  return t;
}
export function tilesIn(r) {
  const out = [];
  if (!r) return out;
  const x0 = Math.floor(r.x / T), y0 = Math.floor(r.y / T), x1 = Math.floor((r.x + r.w - 1e-6) / T), y1 = Math.floor((r.y + r.h - 1e-6) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}
export function tileEmpty(t) {
  const d = cx2d(t, { willReadFrequently: true }).getImageData(0, 0, T, T).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}
export function pruneTiles(layer, keys) {
  for (const k of keys || [...layer.tiles.keys()]) {
    const t = layer.tiles.get(k);
    if (t && tileEmpty(t)) { touch(layer, k); layer.tiles.delete(k); }
  }
}

// draw a world-positioned canvas into a raster layer, honoring alpha lock, selection and paper clip
export function drawToLayer(layer, src, x, y, o = {}) {
  const op = o.op || (layer.alphaLock ? 'source-atop' : 'source-over');
  const r = { x, y, w: src.width * (o.scale || 1), h: src.height * (o.scale || 1) };
  const clipR = paperRect();
  const area = clipR ? rInter(r, clipR) : r;
  if (!area) return;
  let s = src, sx = x, sy = y;
  if (S.sel && !o.noSel) { // mask source by selection
    s = mk(src.width, src.height);
    const c = cx2d(s);
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    const k = o.scale || 1;
    c.drawImage(S.sel.c, (S.sel.x - x) / k, (S.sel.y - y) / k, S.sel.c.width / k, S.sel.c.height / k);
  }
  const needExisting = op === 'destination-out' || op === 'source-atop' || op === 'destination-in';
  const keys = [];
  for (const [tx, ty] of tilesIn(area)) {
    const k = key(tx, ty);
    if (needExisting && !layer.tiles.has(k)) continue;
    const t = tileW(layer, tx, ty), c = cx2d(t);
    c.save();
    if (clipR) { c.beginPath(); c.rect(clipR.x - tx * T, clipR.y - ty * T, clipR.w, clipR.h); c.clip(); }
    c.globalCompositeOperation = op;
    c.globalAlpha = o.alpha == null ? 1 : o.alpha;
    c.imageSmoothingEnabled = o.smooth !== false;
    c.drawImage(s, sx - tx * T, sy - ty * T, r.w, r.h);
    c.restore();
    keys.push(k);
  }
  if (op === 'destination-out' || o.prune) pruneTiles(layer, keys);
}

// read a world rect of one layer into a canvas
export function layerRegion(layer, r, scale = 1) {
  const c = mk(r.w * scale, r.h * scale), g = cx2d(c);
  g.setTransform(scale, 0, 0, scale, -r.x * scale, -r.y * scale);
  drawLayerContent(g, layer, r, 0);
  return c;
}
export function clearRegion(layer, r, mask) {
  for (const [tx, ty] of tilesIn(r)) {
    const k = key(tx, ty);
    if (!layer.tiles.has(k)) continue;
    const c = cx2d(tileW(layer, tx, ty));
    if (mask) {
      c.save(); c.globalCompositeOperation = 'destination-out';
      c.drawImage(mask.c, mask.x - tx * T, mask.y - ty * T); c.restore();
    } else c.clearRect(r.x - tx * T, r.y - ty * T, r.w, r.h);
  }
  pruneTiles(layer, tilesIn(r).map(([a, b]) => key(a, b)).filter(k => layer.tiles.has(k)));
}

// ---------------- bounds ----------------
export function rotRectAABB(cx, cy, w, h, rot) {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const W = w * c + h * s, Hh = w * s + h * c;
  return { x: cx - W / 2, y: cy - Hh / 2, w: W, h: Hh };
}
const measureCtx = cx2d(mk(4, 4));
export function fontStr(d, size) {
  return (d.italic ? 'italic ' : '') + (d.bold ? '700 ' : '400 ') + (size || d.size) + 'px "' + d.font + '", ' + (/Mono/.test(d.font) ? 'monospace' : /Serif|Playfair|Lora/.test(d.font) ? 'serif' : 'sans-serif');
}
export function textBox(l) {
  const d = l.data;
  measureCtx.font = fontStr(d);
  const lines = String(d.text || '').split('\n');
  let w = 0;
  for (const ln of lines) w = Math.max(w, measureCtx.measureText(ln || ' ').width);
  w = Math.max(w, d.size * 0.4) + (d.stroke || 0) * 2 + (d.bgColor ? d.size * 0.5 : 0);
  const h = lines.length * d.size * d.lh + (d.stroke || 0) * 2 + (d.bgColor ? d.size * 0.3 : 0);
  return { cx: d.cx, cy: d.cy, w, h, rot: d.rot || 0, fx: 1, fy: 1 };
}
export function objBox(l) {
  if (l.type === 'text') return textBox(l);
  if (l.type === 'image') { const d = l.data; return { cx: d.cx, cy: d.cy, w: d.w, h: d.h, rot: d.rot || 0, fx: d.fx || 1, fy: d.fy || 1 }; }
  return null;
}
export function tileBounds(layer) {
  let r = null;
  for (const k of layer.tiles.keys()) { const [tx, ty] = unkey(k); r = rUnion(r, { x: tx * T, y: ty * T, w: T, h: T }); }
  return r;
}
// exact pixel bounds (cached on layer.ver)
export function contentBounds(layer) {
  if (layer.type !== 'raster') { const b = objBox(layer); return b && rInt(rotRectAABB(b.cx, b.cy, b.w, b.h, b.rot)); }
  if (layer._cb && layer._cbv === layer.ver) return layer._cb;
  let r = null;
  for (const [k, t] of layer.tiles) {
    const [tx, ty] = unkey(k);
    const d = cx2d(t, { willReadFrequently: true }).getImageData(0, 0, T, T).data;
    let x0 = T, y0 = T, x1 = -1, y1 = -1;
    for (let y = 0; y < T; y++) {
      const row = y * T * 4;
      for (let x = 0; x < T; x++) if (d[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
    if (x1 >= 0) r = rUnion(r, { x: tx * T + x0, y: ty * T + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  layer._cb = r; layer._cbv = layer.ver;
  return r;
}
export function docBounds(onlyVisible = true) {
  let r = null;
  for (const l of S.doc.layers) if (!onlyVisible || l.visible) r = rUnion(r, contentBounds(l));
  return r;
}
// area that "the drawing" occupies: the paper, or the content (+ margin) on an infinite canvas
export function workRect(fallback) {
  const p = paperRect();
  if (p) return p;
  const b = docBounds();
  return b ? rPad(b, 0) : (fallback || { x: -500, y: -500, w: 1000, h: 1000 });
}

// ---------------- drawing layers ----------------
export function drawText(g, l) {
  const d = l.data, b = textBox(l), lines = String(d.text || '').split('\n');
  g.save();
  g.translate(d.cx, d.cy); g.rotate(d.rot || 0);
  if (d.bgColor) {
    g.fillStyle = d.bgColor;
    const r = d.size * 0.18;
    g.beginPath(); g.roundRect ? g.roundRect(-b.w / 2, -b.h / 2, b.w, b.h, r) : g.rect(-b.w / 2, -b.h / 2, b.w, b.h); g.fill();
  }
  g.font = fontStr(d);
  g.textBaseline = 'middle';
  g.textAlign = d.align === 'center' ? 'center' : d.align === 'right' ? 'right' : 'left';
  const pad = (d.stroke || 0) + (d.bgColor ? d.size * 0.25 : 0);
  const x = d.align === 'center' ? 0 : d.align === 'right' ? b.w / 2 - pad : -b.w / 2 + pad;
  const lh = d.size * d.lh, y0 = -b.h / 2 + (d.stroke || 0) + (d.bgColor ? d.size * 0.15 : 0) + lh / 2;
  g.lineJoin = 'round';
  lines.forEach((ln, i) => {
    const y = y0 + i * lh;
    if (d.stroke > 0) { g.strokeStyle = d.strokeColor || '#fff'; g.lineWidth = d.stroke * 2; g.strokeText(ln, x, y); }
    g.fillStyle = d.color; g.fillText(ln, x, y);
    if (d.underline) { const w = g.measureText(ln).width, ux = d.align === 'center' ? x - w / 2 : d.align === 'right' ? x - w : x; g.fillRect(ux, y + d.size * 0.42, w, Math.max(1, d.size / 14)); }
  });
  g.restore();
}
export function drawImageLayer(g, l) {
  const d = l.data, im = l.img;
  if (!im || !(im.width || im.naturalWidth)) return;
  g.save();
  g.translate(d.cx, d.cy); g.rotate(d.rot || 0); g.scale(d.fx || 1, d.fy || 1);
  if (d.filter && 'filter' in g) g.filter = d.filter;
  g.drawImage(im, -d.w / 2, -d.h / 2, d.w, d.h);
  g.restore();
}
// draw one tile; on axis-aligned views snap its edges to device pixels so neighbours meet without seams
export function drawTile(g, t, x, y, e) {
  const m = g.getTransform();
  if (!e || m.b || m.c) { g.drawImage(t, x, y, T + e, T + e); return; }
  const X0 = Math.round(m.a * x + m.e), X1 = Math.round(m.a * (x + T) + m.e);
  const Y0 = Math.round(m.d * y + m.f), Y1 = Math.round(m.d * (y + T) + m.f);
  const sx = m.a < 0 ? -1 : 1, sy = m.d < 0 ? -1 : 1;
  g.setTransform(sx, 0, 0, sy, 0, 0);
  g.drawImage(t, X0 * sx, Y0 * sy, (X1 - X0) * sx, (Y1 - Y0) * sy);
  g.setTransform(m);
}
// draw a layer's own content (no opacity/blend) into g, whose transform maps world -> g. e = tile overlap to hide seams
export function drawLayerContent(g, l, vis, e = 0) {
  if (l._preview) { g.drawImage(l._preview.c, l._preview.x, l._preview.y); return; }
  if (l.type === 'raster') {
    for (const [k, t] of l.tiles) {
      const [tx, ty] = unkey(k);
      const x = tx * T, y = ty * T;
      if (vis && (x > vis.x + vis.w || y > vis.y + vis.h || x + T < vis.x || y + T < vis.y)) continue;
      drawTile(g, t, x, y, e);
    }
  } else if (l.type === 'text') drawText(g, l);
  else if (l.type === 'image') drawImageLayer(g, l);
  const f = S.float;
  if (f && f.layer === l && f.c) {
    const b = f.box;
    g.save(); g.translate(b.cx, b.cy); g.rotate(b.rot); g.scale(b.fx, b.fy);
    g.drawImage(f.c, -b.w / 2, -b.h / 2, b.w, b.h);
    g.restore();
  }
}
// layers grouped with their clipping masks: [{base, clipped:[...]}]
export function groups(layers) {
  const out = [];
  for (const l of layers) {
    if (l.clip && out.length) out[out.length - 1].clipped.push(l);
    else out.push({ base: l, clipped: [] });
  }
  return out;
}

// flatten a world rect into a new canvas
export function flatten(r, scale = 1, o = {}) {
  const d = S.doc, c = mk(r.w * scale, r.h * scale), g = cx2d(c);
  const M = [scale, 0, 0, scale, -r.x * scale, -r.y * scale];
  g.setTransform(...M);
  if (o.bg !== false && d.bgOn) { g.fillStyle = d.bg; g.fillRect(r.x, r.y, r.w, r.h); }
  if (o.bg !== false && o.pattern !== false) drawPaperPattern(g, r, scale);
  const layers = o.layers || d.layers;
  for (const gr of groups(layers)) {
    const b = gr.base;
    if (!b.visible) continue;
    if (!gr.clipped.length) {
      g.globalAlpha = b.opacity; g.globalCompositeOperation = b.blend;
      drawLayerContent(g, b, r, 0);
    } else {
      const t = mk(c.width, c.height), tg = cx2d(t);
      tg.setTransform(...M);
      drawLayerContent(tg, b, r, 0);
      for (const cl of gr.clipped) {
        if (!cl.visible) continue;
        tg.globalCompositeOperation = 'source-atop'; tg.globalAlpha = cl.opacity;
        drawLayerContent(tg, cl, r, 0);
      }
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = b.opacity; g.globalCompositeOperation = b.blend;
      g.drawImage(t, 0, 0); g.restore();
    }
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  const p = paperRect();
  if (p && o.clipPaper !== false) { // nothing outside the paper
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = '#000';
    g.fillRect((p.x - r.x) * scale, (p.y - r.y) * scale, p.w * scale, p.h * scale);
    g.globalCompositeOperation = 'source-over';
  }
  return c;
}

// paper background patterns (part of the paper, so exported)
export function drawPaperPattern(g, r, scale = 1) {
  const d = S.doc;
  if (!d || d.paper === 'plain') return;
  const sp = d.paperSp || 40;
  const p = paperRect() || r;
  const a = rInter(r, p) || r;
  const lw = Math.max(1 / scale, 1);
  const col = d.paperColor || (isDark(d.bg) && d.bgOn ? 'rgba(255,255,255,.18)' : 'rgba(40,90,170,.22)');
  g.save();
  g.beginPath(); g.rect(a.x, a.y, a.w, a.h); g.clip();
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
  const x0 = Math.floor(a.x / sp) * sp, y0 = Math.floor(a.y / sp) * sp;
  const step = sp * scale < 4 ? sp * Math.ceil(4 / (sp * scale)) : sp;
  g.beginPath();
  if (d.paper === 'grid') {
    for (let x = x0; x <= a.x + a.w; x += step) { g.moveTo(x, a.y); g.lineTo(x, a.y + a.h); }
    for (let y = y0; y <= a.y + a.h; y += step) { g.moveTo(a.x, y); g.lineTo(a.x + a.w, y); }
    g.stroke();
  } else if (d.paper === 'lines') {
    for (let y = y0; y <= a.y + a.h; y += step) { g.moveTo(a.x, y); g.lineTo(a.x + a.w, y); }
    g.stroke();
    if (!d.infinite) { g.strokeStyle = 'rgba(220,60,60,.35)'; g.beginPath(); g.moveTo(p.x + sp * 2, a.y); g.lineTo(p.x + sp * 2, a.y + a.h); g.stroke(); }
  } else if (d.paper === 'dots') {
    const rr = Math.max(1.2, sp / 22);
    for (let y = y0; y <= a.y + a.h; y += step) for (let x = x0; x <= a.x + a.w; x += step) { g.moveTo(x + rr, y); g.arc(x, y, rr, 0, 7); }
    g.fill();
  } else if (d.paper === 'iso') {
    const hh = step * Math.sqrt(3) / 2, k = Math.tan(Math.PI / 6);
    const X0 = a.x, X1 = a.x + a.w;
    for (let c = Math.floor((a.y - X1 * k) / step) * step; c <= a.y + a.h - X0 * k; c += step) { g.moveTo(X0, c + X0 * k); g.lineTo(X1, c + X1 * k); }
    for (let c = Math.floor((a.y + X0 * k) / step) * step; c <= a.y + a.h + X1 * k; c += step) { g.moveTo(X0, c - X0 * k); g.lineTo(X1, c - X1 * k); }
    for (let x = Math.floor(a.x / hh) * hh; x <= a.x + a.w; x += hh) { g.moveTo(x, a.y); g.lineTo(x, a.y + a.h); }
    g.stroke();
  }
  g.restore();
}
export function isDark(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return ((n >> 16 & 255) * 0.3 + (n >> 8 & 255) * 0.59 + (n & 255) * 0.11) < 110;
}

// ---------------- selection mask ----------------
// S.sel = {x,y,c (alpha mask canvas), segs: Float32Array outline (world coords)}
export function selSet(r, drawFn, mode = 'new') {
  r = rInt(rPad(r, 2));
  const old = S.sel;
  let area = r;
  if (old && mode !== 'new') area = rUnion(area, { x: old.x, y: old.y, w: old.c.width, h: old.c.height });
  if (area.w * area.h > 64e6) { const s = Math.sqrt(64e6 / (area.w * area.h)); area = { x: area.x, y: area.y, w: area.w * s | 0, h: area.h * s | 0 }; }
  const c = mk(area.w, area.h), g = cx2d(c, { willReadFrequently: true });
  if (old && mode !== 'new') g.drawImage(old.c, old.x - area.x, old.y - area.y);
  const n = mk(area.w, area.h), ng = cx2d(n);
  ng.translate(-area.x, -area.y); ng.fillStyle = '#000';
  drawFn(ng);
  g.globalCompositeOperation = mode === 'sub' ? 'destination-out' : mode === 'inter' ? 'destination-in' : 'source-over';
  g.drawImage(n, 0, 0);
  setSelCanvas(c, area.x, area.y);
}
export function setSelCanvas(c, x, y) {
  // trim to content
  const g = cx2d(c, { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) if (d[(yy * c.width + xx) * 4 + 3] > 8) {
    if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; y1 = yy;
  }
  if (x1 < 0) { S.sel = null; S.ovDirty = true; emit('sel'); return; }
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(c.width - 1, x1 + 1); y1 = Math.min(c.height - 1, y1 + 1);
  const t = mk(x1 - x0 + 1, y1 - y0 + 1);
  cx2d(t).drawImage(c, -x0, -y0);
  S.sel = { x: x + x0, y: y + y0, c: t };
  S.sel.segs = outline(t, S.sel.x, S.sel.y);
  S.ovDirty = true; emit('sel');
}
export const selRect = () => S.sel && { x: S.sel.x, y: S.sel.y, w: S.sel.c.width, h: S.sel.c.height };
export function selClear() { if (S.sel) { S.sel = null; S.ovDirty = true; emit('sel'); } }
export function selHas(p) {
  const s = S.sel;
  if (!s) return true;
  const x = Math.floor(p.x - s.x), y = Math.floor(p.y - s.y);
  if (x < 0 || y < 0 || x >= s.c.width || y >= s.c.height) return false;
  return cx2d(s.c, { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3] > 100;
}
// marching squares on a downscaled mask -> line segments for the marching ants
function outline(c, ox, oy) {
  const k = Math.max(1, Math.max(c.width, c.height) / 900);
  const w = Math.ceil(c.width / k) + 2, h = Math.ceil(c.height / k) + 2;
  const t = mk(w, h), g = cx2d(t, { willReadFrequently: true });
  g.drawImage(c, 1, 1, c.width / k, c.height / k);
  const d = g.getImageData(0, 0, w, h).data;
  const on = (x, y) => d[(y * w + x) * 4 + 3] > 110;
  const segs = [];
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const a = on(x, y), b = on(x + 1, y), cc = on(x + 1, y + 1), dd = on(x, y + 1);
    const m = (a ? 8 : 0) | (b ? 4 : 0) | (cc ? 2 : 0) | (dd ? 1 : 0);
    if (m === 0 || m === 15) continue;
    const T_ = [x + .5, y], R = [x + 1, y + .5], B = [x + .5, y + 1], L = [x, y + .5];
    const add = (p, q) => segs.push(p[0], p[1], q[0], q[1]);
    switch (m) {
      case 1: case 14: add(L, B); break;
      case 2: case 13: add(B, R); break;
      case 3: case 12: add(L, R); break;
      case 4: case 11: add(T_, R); break;
      case 5: add(L, T_); add(B, R); break;
      case 6: case 9: add(T_, B); break;
      case 7: case 8: add(L, T_); break;
      case 10: add(T_, R); add(L, B); break;
    }
  }
  const f = new Float32Array(segs.length);
  for (let i = 0; i < segs.length; i += 2) { f[i] = ox + (segs[i] - 1) * k; f[i + 1] = oy + (segs[i + 1] - 1) * k; }
  return f;
}

// create an image layer from an image/bitmap
export function imageLayerFrom(img, name, src, maxW, maxH) {
  const l = newLayer('image', name || 'Gambar');
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  const s = Math.min(1, (maxW || iw) / iw, (maxH || ih) / ih);
  l.img = img;
  l.data = { cx: 0, cy: 0, w: iw * s, h: ih * s, rot: 0, fx: 1, fy: 1, src, iw, ih };
  return l;
}

export function insertLayer(l, above = true) {
  const d = S.doc, i = d.layers.findIndex(x => x.id === d.active);
  d.layers.splice(i < 0 ? d.layers.length : i + (above ? 1 : 0), 0, l);
  d.active = l.id;
  return l;
}

// rasterize text/image layer (in place) — call inside a transaction
export function rasterize(l) {
  if (l.type === 'raster') return;
  const b = contentBounds(l);
  if (b) {
    const c = mk(b.w, b.h), g = cx2d(c);
    g.translate(-b.x, -b.y);
    if (l.type === 'text') drawText(g, l); else drawImageLayer(g, l);
    l.type = 'raster';
    drawToLayer(l, c, b.x, b.y, { op: 'source-over', noSel: true });
  } else l.type = 'raster';
  l.data = null; l.img = null; l.ver++;
}

// transform every layer (rotate/flip/scale/offset canvas). m = DOMMatrix world->world
export function transformLayer(l, m) {
  if (l.type === 'raster') {
    const b = contentBounds(l);
    if (!b) return;
    const src = layerRegion(l, b);
    for (const k of [...l.tiles.keys()]) { touch(l, k); l.tiles.delete(k); }
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => m.transformPoint({ x, y }));
    const nx = Math.min(...pts.map(p => p.x)), ny = Math.min(...pts.map(p => p.y));
    const nr = rInt({ x: nx, y: ny, w: Math.max(...pts.map(p => p.x)) - nx, h: Math.max(...pts.map(p => p.y)) - ny });
    for (const [tx, ty] of tilesIn(nr)) {
      const t = tileW(l, tx, ty), g = cx2d(t);
      g.setTransform(1, 0, 0, 1, -tx * T, -ty * T);
      g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      g.drawImage(src, b.x, b.y);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    pruneTiles(l);
  } else {
    const d = l.data, p = m.transformPoint({ x: d.cx, y: d.cy });
    d.cx = p.x; d.cy = p.y;
    const sx = Math.hypot(m.a, m.b), det = m.a * m.d - m.b * m.c;
    const ang = Math.atan2(m.b, m.a);
    if (det < 0) { // mirrored: s·R(a)·diag(1,-1)·R(rot)·F = s·R(a-rot)·diag(fx,-fy)
      d.rot = ang - (d.rot || 0);
      if (l.type === 'image') d.fy = -(d.fy || 1);
    } else d.rot = (d.rot || 0) + ang;
    if (l.type === 'image') { d.w *= sx; d.h *= sx; } else d.size *= sx;
  }
  l.ver++;
}
export const cl = clamp;
