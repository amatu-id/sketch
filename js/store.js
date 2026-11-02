// Persistence (IndexedDB gallery + autosave), project files, image/PDF/PSD export & import.
import { S, T, mk, cx2d, emit, toast, rPad, rInt, uid } from './state.js';
import { newDoc, newLayer, key, unkey, flatten, workRect, paperRect, layerRegion, contentBounds, docBounds, groups, H, selRect, imageLayerFrom } from './doc.js';

const DB = 'amatu-sketch';
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listMeta() {
  const all = await tx('meta', 'readonly', s => req(s.getAll()));
  return (all || []).sort((a, b) => b.updated - a.updated);
}
export const toBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(b => r(b), type, q));

async function tileBlob(t) {
  if (!t._blob) t._blob = await toBlob(t);
  return t._blob;
}
export async function serialize(d, withThumb = true) {
  const layers = [];
  for (const l of d.layers) {
    const o = { id: l.id, name: l.name, type: l.type, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, alphaLock: l.alphaLock, clip: l.clip };
    if (l.type === 'raster') { o.tiles = []; for (const [k, t] of l.tiles) o.tiles.push([k, await tileBlob(t)]); }
    if (l.data) { const { src, ...rest } = l.data; o.data = JSON.parse(JSON.stringify(rest)); if (src) o.src = src; }
    layers.push(o);
  }
  const rec = {
    id: d.id, name: d.name, w: d.w, h: d.h, infinite: d.infinite, dpi: d.dpi, bg: d.bg, bgOn: d.bgOn, paper: d.paper, paperSp: d.paperSp,
    active: d.active, created: d.created, updated: d.updated, view: { ...S.view }, layers, v: 1
  };
  return rec;
}
export async function makeThumb(d = S.doc, max = 420) {
  const r = workRect({ x: 0, y: 0, w: 400, h: 300 });
  const s = Math.min(1, max / Math.max(r.w, r.h));
  const c = flatten(r, s);
  return toBlob(c, 'image/png');
}
let saving = false, again = false, saveT = null;
export async function saveNow() {
  const d = S.doc;
  if (!d) return;
  if (H.tx || S.stroke) { scheduleSave(800); return; }
  if (saving) { again = true; return; }
  saving = true; emit('save', 'saving');
  try {
    const rec = await serialize(d);
    const thumb = await makeThumb(d);
    const meta = { id: d.id, name: d.name, w: d.w, h: d.h, infinite: d.infinite, created: d.created, updated: d.updated, thumb, nLayers: d.layers.length };
    await tx('docs', 'readwrite', s => s.put(rec));
    await tx('meta', 'readwrite', s => s.put(meta));
    S.saved = d.updated;
    emit('save', 'saved');
  } catch (e) {
    console.error(e); emit('save', 'error');
    toast('Gagal menyimpan: ' + (e && e.message || e));
  }
  saving = false;
  if (again) { again = false; saveNow(); }
}
export function scheduleSave(ms = 1500) {
  clearTimeout(saveT);
  emit('save', 'pending');
  saveT = setTimeout(saveNow, ms);
}
export function flushSave() { if (saveT) { clearTimeout(saveT); saveT = null; return saveNow(); } }

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}
async function blobToCanvas(b) {
  const c = mk(T, T);
  try { const bm = await createImageBitmap(b); cx2d(c).drawImage(bm, 0, 0); bm.close && bm.close(); }
  catch (e) { const im = await loadImage(b); cx2d(c).drawImage(im, 0, 0); }
  c._blob = b;
  return c;
}
export async function deserialize(rec) {
  const d = newDoc(rec);
  Object.assign(d, { id: rec.id, name: rec.name, created: rec.created, updated: rec.updated, active: rec.active, view: rec.view });
  for (const o of rec.layers) {
    const l = newLayer(o.type, o.name);
    Object.assign(l, { id: o.id, visible: o.visible, opacity: o.opacity, blend: o.blend, locked: o.locked, alphaLock: o.alphaLock, clip: o.clip });
    if (o.tiles) await Promise.all(o.tiles.map(async ([k, b]) => l.tiles.set(k, await blobToCanvas(b))));
    if (o.data) l.data = o.data;
    if (o.src) { l.data.src = o.src; try { l.img = await loadImage(o.src); } catch (e) { } }
    d.layers.push(l);
  }
  if (!d.layers.find(l => l.id === d.active)) d.active = d.layers.length ? d.layers[d.layers.length - 1].id : null;
  return d;
}
export async function loadDoc(id) {
  const rec = await tx('docs', 'readonly', s => req(s.get(id)));
  return rec ? deserialize(rec) : null;
}
export async function deleteDoc(id) {
  await tx('docs', 'readwrite', s => s.delete(id));
  await tx('meta', 'readwrite', s => s.delete(id));
}
export async function renameDoc(id, name) {
  const m = await tx('meta', 'readonly', s => req(s.get(id)));
  const r = await tx('docs', 'readonly', s => req(s.get(id)));
  if (m) { m.name = name; await tx('meta', 'readwrite', s => s.put(m)); }
  if (r) { r.name = name; await tx('docs', 'readwrite', s => s.put(r)); }
}
export async function duplicateDoc(id) {
  const r = await tx('docs', 'readonly', s => req(s.get(id)));
  const m = await tx('meta', 'readonly', s => req(s.get(id)));
  if (!r) return;
  const nid = uid(), now = Date.now();
  await tx('docs', 'readwrite', s => s.put({ ...r, id: nid, name: r.name + ' (salinan)', created: now, updated: now }));
  await tx('meta', 'readwrite', s => s.put({ ...m, id: nid, name: m.name + ' (salinan)', created: now, updated: now }));
}
export async function metaThumbOf(id) {
  const m = await tx('meta', 'readonly', s => req(s.get(id)));
  return m;
}

// ---------------- project file (.sketch.json) ----------------
const b2d = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const d2b = async u => (await fetch(u)).blob();
export async function projectBlob(d = S.doc) {
  const rec = await serialize(d);
  for (const l of rec.layers) {
    if (l.tiles) for (const t of l.tiles) t[1] = await b2d(t[1]);
    if (l.src && typeof l.src !== 'string') l.src = await b2d(l.src);
  }
  return new Blob([JSON.stringify({ format: 'amatu-sketch', version: 1, doc: rec })], { type: 'application/json' });
}
export async function openProjectFile(file) {
  const j = JSON.parse(await file.text());
  if (j.format !== 'amatu-sketch') throw new Error('Bukan file Sketch Paint');
  const rec = j.doc;
  for (const l of rec.layers) {
    if (l.tiles) for (const t of l.tiles) t[1] = await d2b(t[1]);
    if (l.src && /^data:/.test(l.src)) l.src = await d2b(l.src);
  }
  rec.id = uid(); rec.updated = Date.now();
  return deserialize(rec);
}

// ---------------- export ----------------
export function exportArea(kind) {
  if (kind === 'sel' && S.sel) return rInt(selRect());
  if (kind === 'content') { const b = docBounds(); if (b) return rInt(rPad(b, 0)); }
  if (kind === 'view') { return null; }
  return rInt(workRect({ x: 0, y: 0, w: 800, h: 600 }));
}
export function renderExport(o) {
  const r = exportArea(o.area);
  let c = flatten(r, o.scale || 1, { bg: o.bg !== false });
  if (o.area === 'sel' && S.sel) {
    const g = cx2d(c); g.globalCompositeOperation = 'destination-in';
    g.drawImage(S.sel.c, (S.sel.x - r.x) * o.scale, (S.sel.y - r.y) * o.scale, S.sel.c.width * o.scale, S.sel.c.height * o.scale);
  }
  if (o.fmt === 'jpg') { // JPEG has no alpha
    const j = mk(c.width, c.height), g = cx2d(j);
    g.fillStyle = S.doc.bgOn ? S.doc.bg : '#ffffff'; g.fillRect(0, 0, j.width, j.height); g.drawImage(c, 0, 0); c = j;
  }
  return c;
}
export function loadScript(src, glob) {
  if (glob && window[glob]) return Promise.resolve(window[glob]);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(glob ? window[glob] : true);
    s.onerror = () => rej(new Error('Gagal memuat ' + src));
    document.head.appendChild(s);
  });
}
export async function exportBlob(o) {
  const d = S.doc;
  if (o.fmt === 'pdf') {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'jspdf');
    const c = renderExport({ ...o, fmt: 'jpg' });
    const r = exportArea(o.area);
    const mmW = r.w / d.dpi * 25.4, mmH = r.h / d.dpi * 25.4;
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: mmW > mmH ? 'l' : 'p', unit: 'mm', format: [mmW, mmH], compress: true });
    pdf.addImage(c.toDataURL('image/jpeg', .92), 'JPEG', 0, 0, mmW, mmH);
    return pdf.output('blob');
  }
  if (o.fmt === 'psd') return psdBlob(o);
  if (o.fmt === 'sketch') return projectBlob();
  const c = renderExport(o);
  return toBlob(c, o.fmt === 'jpg' ? 'image/jpeg' : o.fmt === 'webp' ? 'image/webp' : 'image/png', o.quality || .92);
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const safeName = s => (String(s || 'gambar').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'gambar').slice(0, 80);

const PSD_BLEND = { 'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'color dodge', 'color-burn': 'color burn', 'hard-light': 'hard light', 'soft-light': 'soft light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
const AGPSD = 'https://cdn.jsdelivr.net/npm/ag-psd@31.0.3/dist/bundle.js';
async function psdBlob(o) {
  const ag = await loadScript(AGPSD, 'agPsd');
  const d = S.doc, r = exportArea('page');
  const children = [];
  for (const l of d.layers) {
    const b = contentBounds(l);
    const area = b && (paperRect() ? rInt({ x: Math.max(b.x, r.x), y: Math.max(b.y, r.y), w: Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x), h: Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y) }) : b);
    const ok = area && area.w > 0 && area.h > 0;
    children.push({
      name: l.name, opacity: l.opacity, hidden: !l.visible, blendMode: PSD_BLEND[l.blend] || 'normal', clipping: !!l.clip,
      transparencyProtected: !!l.alphaLock, protected: l.locked ? { composite: true, position: true, transparency: true } : undefined,
      left: ok ? area.x - r.x : 0, top: ok ? area.y - r.y : 0, canvas: ok ? layerRegion(l, area) : mk(1, 1)
    });
  }
  if (d.bgOn) {
    const bgc = mk(r.w, r.h), g = cx2d(bgc); g.fillStyle = d.bg; g.fillRect(0, 0, r.w, r.h);
    children.unshift({ name: 'Latar', left: 0, top: 0, canvas: bgc });
  }
  const psd = { width: r.w, height: r.h, children, canvas: flatten(r, 1) };
  const buf = ag.writePsd(psd, { generateThumbnail: true });
  return new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
}
export async function importPsd(file) {
  const ag = await loadScript(AGPSD, 'agPsd');
  const psd = ag.readPsd(await file.arrayBuffer(), { skipThumbnail: true });
  const d = newDoc({ name: file.name.replace(/\.psd$/i, ''), w: psd.width, h: psd.height, bgOn: false });
  const inv = Object.fromEntries(Object.entries(PSD_BLEND).map(([a, b]) => [b, a]));
  const walk = (arr) => {
    for (const c of arr || []) {
      if (c.children) { walk(c.children); continue; }
      if (!c.canvas) continue;
      const l = newLayer('raster', c.name || 'Lapisan');
      l.opacity = c.opacity == null ? 1 : c.opacity; l.visible = !c.hidden; l.blend = inv[c.blendMode] || 'source-over'; l.clip = !!c.clipping;
      blit(l, c.canvas, c.left || 0, c.top || 0);
      d.layers.push(l);
    }
  };
  walk(psd.children);
  if (!d.layers.length && psd.canvas) { const l = newLayer('raster', 'Gambar'); blit(l, psd.canvas, 0, 0); d.layers.push(l); }
  d.active = d.layers.length ? d.layers[d.layers.length - 1].id : null;
  return d;
}
// write a canvas into a layer's tiles without history (used while building documents)
export function blit(l, c, x, y) {
  const x0 = Math.floor(x / T), y0 = Math.floor(y / T), x1 = Math.floor((x + c.width - 1) / T), y1 = Math.floor((y + c.height - 1) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const k = key(tx, ty);
    let t = l.tiles.get(k);
    if (!t) { t = mk(T, T); l.tiles.set(k, t); }
    cx2d(t).drawImage(c, x - tx * T, y - ty * T);
    t._blob = null;
  }
}
export { loadImage };
