// Document operations: layers, selection, clipboard, canvas, inserting images/icons.
import { S, T, mk, cx2d, clamp, rInter, rInt, rPad, emit, toast } from './state.js';
import {
  activeLayer, newLayer, insertLayer, begin, end, abort, changed, drawToLayer, layerRegion, clearRegion, flatten, contentBounds, docBounds,
  paperRect, selSet, setSelCanvas, selRect, selClear, rasterize, transformLayer, imageLayerFrom, groups, drawLayerContent, workRect, key, H
} from './doc.js';
import { visibleRect, fitView, viewChanged } from './view.js';
import { commitPending, startFloat, setTool } from './tools.js';
import { blurCanvas } from './filters.js';
import { loadImage } from './store.js';
import { iconSvg } from './icons.js';

const L = () => activeLayer();
const layersChanged = () => { emit('layers'); S.dirty = true; };

// ---------------- layers ----------------
export function addLayer(type = 'raster') {
  commitPending();
  begin('Lapisan baru');
  insertLayer(newLayer(type));
  end(); layersChanged();
}
export function dupLayer(l = L()) {
  if (!l) return;
  commitPending();
  begin('Duplikat lapisan');
  const n = newLayer(l.type, l.name + ' salinan');
  Object.assign(n, { opacity: l.opacity, blend: l.blend, visible: l.visible, alphaLock: l.alphaLock, clip: l.clip });
  for (const [k, t] of l.tiles) { const c = mk(T, T); cx2d(c).drawImage(t, 0, 0); n.tiles.set(k, c); }
  if (l.data) { n.data = JSON.parse(JSON.stringify(l.data, (k, v) => k === 'src' ? undefined : v)); if (l.data.src) n.data.src = l.data.src; }
  n.img = l.img;
  S.doc.active = l.id;
  insertLayer(n);
  end(); layersChanged();
}
export function delLayer(l = L()) {
  if (!l) return;
  commitPending();
  const d = S.doc, i = d.layers.indexOf(l);
  begin('Hapus lapisan');
  d.layers.splice(i, 1);
  if (!d.layers.length) d.layers.push(newLayer('raster', 'Lapisan 1'));
  d.active = d.layers[Math.max(0, i - 1)].id;
  end(); layersChanged();
}
export function moveLayer(l, to) {
  const d = S.doc, i = d.layers.indexOf(l);
  to = clamp(to, 0, d.layers.length - 1);
  if (i < 0 || i === to) return;
  commitPending();
  begin('Urutan lapisan');
  d.layers.splice(i, 1); d.layers.splice(to, 0, l);
  end(); layersChanged();
}
export function setLayerProp(l, k, v, label) {
  if (!l || l[k] === v) return;
  begin(label || 'Properti lapisan');
  l[k] = v; l.ver++;
  end(); layersChanged();
}
export function mergeDown(l = L()) {
  const d = S.doc, i = d.layers.indexOf(l);
  if (i <= 0) { toast('Tidak ada lapisan di bawahnya'); return; }
  commitPending();
  const below = d.layers[i - 1];
  if (below.locked) { toast('Lapisan bawah terkunci'); return; }
  begin('Gabung ke bawah');
  if (below.type !== 'raster') rasterize(below);
  const b = contentBounds(l);
  if (b && l.visible) {
    const c = layerRegion(l, b);
    drawToLayer(below, c, b.x, b.y, { op: l.clip ? 'source-atop' : l.blend, alpha: l.opacity, noSel: true });
  }
  d.layers.splice(i, 1);
  d.active = below.id;
  end(); layersChanged();
}
export function flattenLayers(onlyVisible) {
  commitPending();
  const d = S.doc;
  const r = rInt(workRect());
  begin(onlyVisible ? 'Gabung terlihat' : 'Ratakan');
  const keep = onlyVisible ? d.layers.filter(l => !l.visible) : [];
  const c = flatten(r, 1, { bg: !onlyVisible, pattern: false, layers: d.layers });
  const n = newLayer('raster', onlyVisible ? 'Gabungan' : 'Lapisan 1');
  drawToLayer(n, c, r.x, r.y, { op: 'source-over', prune: true, noSel: true });
  d.layers = onlyVisible ? [...keep, n] : [n];
  d.active = n.id;
  end(); layersChanged();
}
export function rasterizeLayer(l = L()) {
  if (!l || l.type === 'raster') return;
  commitPending();
  begin('Ubah jadi piksel'); rasterize(l); end(); layersChanged();
}
export function clearLayer(l = L()) {
  if (!l) return;
  begin('Bersihkan');
  if (S.sel) { if (l.type !== 'raster') rasterize(l); clearRegion(l, selRect(), S.sel); }
  else if (l.type === 'raster') { const b = contentBounds(l); if (b) clearRegion(l, b); }
  else { const d = S.doc, i = d.layers.indexOf(l); d.layers.splice(i, 1, newLayer('raster', l.name)); d.active = d.layers[i].id; }
  end(); layersChanged(); emit('stroke');
}
export function fillLayer(color = S.color) {
  const l = L();
  if (!l) return;
  if (l.locked) { toast('Lapisan terkunci 🔒'); return; }
  commitPending();
  begin('Isi warna');
  if (l.type !== 'raster') rasterize(l);
  const r = rInt(S.sel ? selRect() : (paperRect() || visibleRect()));
  const c = mk(r.w, r.h), g = cx2d(c); g.fillStyle = color; g.fillRect(0, 0, r.w, r.h);
  drawToLayer(l, c, r.x, r.y);
  end(); emit('stroke');
}

// ---------------- selection ----------------
export function selectAll() {
  commitPending();
  const r = rInt(paperRect() || rPad(docBounds() || visibleRect(), 0));
  selSet(r, g => g.fillRect(r.x, r.y, r.w, r.h));
}
export function deselect() { selClear(); }
export function invertSel() {
  const base = rInt(paperRect() || rPad(docBounds() || visibleRect(), 200));
  const s = S.sel;
  selSet(base, g => {
    g.fillRect(base.x, base.y, base.w, base.h);
    if (s) { g.globalCompositeOperation = 'destination-out'; g.drawImage(s.c, s.x, s.y); }
  });
}
export function selectLayerAlpha(l = L()) {
  const b = l && contentBounds(l);
  if (!b) { toast('Lapisan kosong'); return; }
  const c = layerRegion(l, b);
  selSet(b, g => g.drawImage(c, b.x, b.y));
}
export function modifySel(kind, n) {
  const s = S.sel;
  if (!s || !n) return;
  const pad = Math.ceil(n * 2) + 2;
  const c = mk(s.c.width + pad * 2, s.c.height + pad * 2);
  cx2d(c).drawImage(s.c, pad, pad);
  let b = blurCanvas(c, kind === 'feather' ? n : n / 1.5);
  if (kind !== 'feather') {
    const g = cx2d(b, { willReadFrequently: true }), im = g.getImageData(0, 0, b.width, b.height), d = im.data;
    const t = kind === 'grow' ? 6 : 250;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= t ? 255 : 0;
    g.putImageData(im, 0, 0);
  }
  setSelCanvas(b, s.x - pad, s.y - pad);
}
export function deleteSel() {
  const l = L();
  if (!l) return;
  if (l.locked) { toast('Lapisan terkunci 🔒'); return; }
  if (!S.sel) { clearLayer(l); return; }
  begin('Hapus isi');
  if (l.type !== 'raster') rasterize(l);
  clearRegion(l, selRect(), S.sel);
  end(); emit('stroke');
}

// ---------------- clipboard ----------------
function selectionCanvas(l, merged) {
  const r = S.sel ? rInt(selRect()) : rInt(merged ? workRect() : (contentBounds(l) || { x: 0, y: 0, w: 0, h: 0 }));
  if (!r.w || !r.h) return null;
  const c = merged ? flatten(r, 1, { bg: false }) : layerRegion(l, r);
  if (S.sel) { const g = cx2d(c); g.globalCompositeOperation = 'destination-in'; g.drawImage(S.sel.c, S.sel.x - r.x, S.sel.y - r.y); }
  return { c, x: r.x, y: r.y };
}
export async function copySel(merged) {
  commitPending();
  const l = L();
  if (!l && !merged) return;
  const clip = selectionCanvas(l, merged);
  if (!clip) { toast('Tidak ada yang disalin'); return; }
  S.clip = clip;
  toast(merged ? 'Disalin (gabungan)' : 'Disalin');
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const blob = await new Promise(r => clip.c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      S.clipStamp = Date.now();
    }
  } catch (e) { }
}
export async function cutSel() {
  await copySel(false);
  deleteSel();
}
export function pasteCanvas(c, x, y, name = 'Tempelan') {
  commitPending();
  const v = visibleRect();
  if (x == null || x + c.width < v.x || y + c.height < v.y || x > v.x + v.w || y > v.y + v.h) {
    x = Math.round(v.x + v.w / 2 - c.width / 2); y = Math.round(v.y + v.h / 2 - c.height / 2);
  }
  begin('Tempel');
  const l = insertLayer(newLayer('raster', name));
  drawToLayer(l, c, x, y, { op: 'source-over', noSel: true });
  end('Tempel');
  layersChanged();
  setTool('move');
  emit('stroke');
}
export async function paste() {
  // prefer the system clipboard when it holds an image newer than our own copy
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find(t => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          if (S.clip && S.clipStamp && Date.now() - S.clipStamp < 600000 && blob.size && S.clipSize === blob.size) break;
          await insertImageBlob(blob, 'Tempelan', true);
          return;
        }
      }
    }
  } catch (e) { }
  if (S.clip) pasteCanvas(S.clip.c, S.clip.x, S.clip.y);
  else toast('Papan klip kosong');
}
export function selToLayer(cut) {
  commitPending();
  const l = L();
  const clip = l && selectionCanvas(l, false);
  if (!clip) return;
  begin(cut ? 'Potong ke lapisan' : 'Salin ke lapisan');
  if (cut && l.type === 'raster' && S.sel) clearRegion(l, selRect(), S.sel);
  const n = insertLayer(newLayer('raster', l.name + (cut ? ' (potong)' : ' (salin)')));
  drawToLayer(n, clip.c, clip.x, clip.y, { op: 'source-over', noSel: true });
  end(); layersChanged(); emit('stroke');
}

// ---------------- canvas ----------------
function allLayers(fn) { for (const l of S.doc.layers) fn(l); }
export function rotateCanvas(deg) {
  commitPending();
  const d = S.doc, p = paperRect() || rInt(docBounds() || { x: 0, y: 0, w: 1, h: 1 });
  const m = new DOMMatrix();
  if (deg === 180) m.translateSelf(p.x + p.w, p.y + p.h).rotateSelf(180).translateSelf(-p.x, -p.y);
  else if (deg === 90) m.translateSelf(p.x + p.h, p.y).rotateSelf(90).translateSelf(-p.x, -p.y);
  else m.translateSelf(p.x, p.y + p.w).rotateSelf(-90).translateSelf(-p.x, -p.y);
  begin('Putar kanvas');
  allLayers(l => transformLayer(l, m));
  if (!d.infinite && deg !== 180) { const w = d.w; d.w = d.h; d.h = w; }
  selClear();
  end(); layersChanged(); fitView(); emit('stroke');
}
export function flipCanvas(h) {
  commitPending();
  const p = paperRect() || rInt(docBounds() || { x: 0, y: 0, w: 1, h: 1 });
  const m = h ? new DOMMatrix([-1, 0, 0, 1, 2 * p.x + p.w, 0]) : new DOMMatrix([1, 0, 0, -1, 0, 2 * p.y + p.h]);
  begin(h ? 'Balik horizontal' : 'Balik vertikal');
  allLayers(l => transformLayer(l, m));
  selClear();
  end(); layersChanged(); emit('stroke');
}
export function flipLayer(h) {
  const l = L();
  if (!l) return;
  commitPending();
  const b = contentBounds(l);
  if (!b) return;
  const s = S.sel ? rInter(selRect(), b) : b;
  if (S.sel && l.type === 'raster') { // flip only the selected pixels
    startFloat();
    if (S.float) { if (h) S.float.box.fx *= -1; else S.float.box.fy *= -1; S.dirty = true; }
    return;
  }
  const m = h ? new DOMMatrix([-1, 0, 0, 1, 2 * s.x + s.w, 0]) : new DOMMatrix([1, 0, 0, -1, 0, 2 * s.y + s.h]);
  begin('Balik lapisan'); transformLayer(l, m); end(); layersChanged(); emit('stroke');
}
// resize paper; anchor: [ax, ay] in {0, .5, 1}
export function resizeCanvas(w, h, ax = .5, ay = .5) {
  commitPending();
  const d = S.doc;
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const dx = Math.round((w - d.w) * ax), dy = Math.round((h - d.h) * ay);
  begin('Ukuran kanvas');
  if (dx || dy) { const m = new DOMMatrix([1, 0, 0, 1, dx, dy]); allLayers(l => transformLayer(l, m)); }
  d.w = w; d.h = h; d.infinite = false;
  selClear();
  end(); layersChanged(); fitView(); emit('stroke');
}
export function scaleImage(w, h) {
  commitPending();
  const d = S.doc;
  const k = w / d.w, k2 = h / d.h;
  begin('Skala gambar');
  const m = new DOMMatrix([k, 0, 0, k2, 0, 0]);
  allLayers(l => {
    if (l.type === 'raster' || Math.abs(k - k2) < 1e-6) transformLayer(l, m);
    else { l.data.cx *= k; l.data.cy *= k2; if (l.type === 'image') { l.data.w *= k; l.data.h *= k2; } else l.data.size *= Math.sqrt(k * k2); }
  });
  d.w = Math.round(w); d.h = Math.round(h);
  selClear();
  end(); layersChanged(); fitView(); emit('stroke');
}
export function cropTo(r) {
  if (!r) return;
  r = rInt(r);
  commitPending();
  const d = S.doc;
  begin('Pangkas');
  const m = new DOMMatrix([1, 0, 0, 1, -r.x, -r.y]);
  allLayers(l => {
    if (l.type === 'raster') { // drop pixels outside
      const b = contentBounds(l);
      if (b) {
        const keep = rInter(b, r);
        const c = keep && layerRegion(l, keep);
        clearRegion(l, b);
        if (keep) drawToLayer(l, c, keep.x, keep.y, { op: 'source-over', noSel: true });
      }
    }
    transformLayer(l, m);
  });
  d.w = r.w; d.h = r.h; d.infinite = false;
  selClear();
  end(); layersChanged(); fitView(); emit('stroke');
}
export function cropToSelection() { if (!S.sel) { toast('Buat seleksi dulu'); return; } cropTo(selRect()); }
export function cropToContent() { const b = docBounds(); if (!b) { toast('Kanvas masih kosong'); return; } cropTo(rPad(b, 0)); }
export function setInfinite(on) {
  commitPending();
  const d = S.doc;
  if (d.infinite === on) return;
  begin(on ? 'Kanvas tak terbatas' : 'Kanvas kertas');
  if (on) d.infinite = true;
  else {
    const b = docBounds();
    if (b) { const r = rInt(rPad(b, 40)); const m = new DOMMatrix([1, 0, 0, 1, -r.x, -r.y]); allLayers(l => transformLayer(l, m)); d.w = r.w; d.h = r.h; }
    d.infinite = false;
  }
  end(); layersChanged(); fitView();
}
export function setBg(patch) {
  begin('Latar kertas');
  Object.assign(S.doc, patch);
  end(); S.dirty = true; emit('layers');
}

// ---------------- insert ----------------
export async function insertImageBlob(blob, name, asPaste) {
  commitPending();
  let src = blob;
  let img = await loadImage(blob);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const MAX = 4096;
  if (Math.max(iw, ih) > MAX && !/svg/.test(blob.type)) { // keep documents light
    const s = MAX / Math.max(iw, ih), c = mk(iw * s, ih * s);
    cx2d(c).drawImage(img, 0, 0, c.width, c.height);
    src = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
    img = await loadImage(src);
  }
  const v = visibleRect(), p = paperRect();
  const area = p ? (rInter(v, p) || p) : v;
  const l = imageLayerFrom(img, name || 'Foto', src, area.w * .8, area.h * .8);
  l.data.cx = area.x + area.w / 2; l.data.cy = area.y + area.h / 2;
  begin(asPaste ? 'Tempel gambar' : 'Sisipkan gambar');
  insertLayer(l);
  end(); layersChanged();
  setTool('move');
  emit('stroke');
  return l;
}
export async function insertIcon(name, color = S.color) {
  const svg = iconSvg(name, color);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const l = await insertImageBlob(blob, name);
  const s = Math.min(l.data.w, l.data.h, 260 / S.view.z);
  l.data.w = l.data.h = s; S.dirty = true;
  return l;
}
export function insertEmoji(ch) {
  commitPending();
  const v = visibleRect(), p = paperRect(), area = p ? (rInter(v, p) || p) : v;
  const l = newLayer('text', ch);
  l.data = { ...S.tools.text, text: ch, size: Math.round(Math.min(area.w, area.h) * .22), color: '#000000', rot: 0, stroke: 0, bgColor: null, cx: area.x + area.w / 2, cy: area.y + area.h / 2, font: 'Inter', lh: 1.15 };
  begin('Sisipkan emoji');
  insertLayer(l);
  end(); layersChanged(); setTool('move'); emit('stroke');
}

// palette extraction (median-cut-ish k-means on a downsample)
export function extractPalette(c, k = 8) {
  const s = Math.min(1, 120 / Math.max(c.width, c.height));
  const t = mk(c.width * s, c.height * s), g = cx2d(t, { willReadFrequently: true });
  g.drawImage(c, 0, 0, t.width, t.height);
  const d = g.getImageData(0, 0, t.width, t.height).data, px = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) px.push([d[i], d[i + 1], d[i + 2]]);
  if (!px.length) return [];
  let cents = [];
  for (let i = 0; i < k; i++) cents.push(px[Math.floor((i + .5) / k * px.length)].slice());
  for (let it = 0; it < 10; it++) {
    const sum = cents.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0, bd = 1e9;
      cents.forEach((c, j) => { const dd = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (dd < bd) { bd = dd; bi = j; } });
      const sm = sum[bi]; sm[0] += p[0]; sm[1] += p[1]; sm[2] += p[2]; sm[3]++;
    }
    cents = cents.map((c, j) => sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3], sum[j][3]] : c);
  }
  return cents.sort((a, b) => (b[3] || 0) - (a[3] || 0)).map(c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join(''));
}
