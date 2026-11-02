// Interface: toolbar, options bar, panels, menus, dialogs, shortcuts.
import { S, T, $, $$, mk, cx2d, clamp, hex2rgb, rgb2hex, rgb2hsv, hsv2rgb, on, emit, toast, savePrefs, rInter, rInt, uid } from './state.js';
import {
  H, undo, redo, activeLayer, BLENDS, contentBounds, docBounds, paperRect, drawLayerContent, flatten, workRect, selRect, layerById, begin, end, objBox, rasterize, clearRegion, drawToLayer
} from './doc.js';
import { PRESETS, CATS, presetById, previewStroke } from './brush.js';
import { setTool, commitPending, cancelPending, sampleColor, setColor, pushRecent, SHAPES, dashArr, applyTextOpts, finishText, editText, floatOp, nudge, startFloat, commitFloat, cancelFloat, commitShape, isTyping, doFill } from './tools.js';
import { vm, zoomAt, setZoom, fitView, viewChanged, visibleRect, s2w, w2s, W as VW, canvasEl, themeChanged } from './view.js';
import * as ops from './ops.js';
import { FILTERS, applyFilter } from './filters.js';
import { ic, ICONS, EMOJI } from './icons.js';
import { exportBlob, download, safeName, renderExport, exportArea, saveNow, toBlob } from './store.js';

export const App = {}; // filled by main.js: newDocument, openDocument, toGallery, openFile, importAsNew

// ---------------- tiny DOM helpers ----------------
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const K = s => isMac ? s : s.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+');

// popovers
let popAnchor = null;
export function closePop() { $('#pop').innerHTML = ''; popAnchor = null; $$('#menus .open').forEach(b => b.classList.remove('open')); }
export function openPop(anchor, content, cls = '') {
  const same = popAnchor === anchor;
  closePop();
  if (same) return null;
  popAnchor = anchor;
  const box = h('div', { class: cls }, content);
  $('#pop').append(box);
  const r = anchor.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (anchor.closest('#tools')) { x = r.right + 8; y = r.top; }
  if (anchor.closest('#mbar')) { y = r.top - bh - 8; }
  x = clamp(x, 8, innerWidth - bw - 8);
  if (y + bh > innerHeight - 8) y = Math.max(8, r.top - bh - 6);
  box.style.left = x + 'px'; box.style.top = y + 'px';
  return box;
}
document.addEventListener('pointerdown', e => {
  if (!popAnchor) return;
  if (e.target.closest('#pop') || (popAnchor && popAnchor.contains(e.target))) return;
  closePop();
}, true);
export function openMenu(anchor, items) {
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(h('hr')); continue; }
    if (it.hd) { m.append(h('div', { class: 'hd' }, it.hd)); continue; }
    m.append(h('button', {
      disabled: it.dis, onclick: () => { closePop(); it.act && it.act(); }
    }, h('i', { class: 'ck' }, it.check ? '✓' : ''), h('span', {}, it.label), it.kbd ? h('kbd', {}, K(it.kbd)) : null));
  }
  return openPop(anchor, m, 'menu');
}
// modal dialogs
export function modal({ title, body, buttons = [], wide, onClose }) {
  const back = h('div', { class: 'back' });
  const close = () => { back.remove(); onClose && onClose(); };
  const foot = h('footer');
  for (const b of buttons) {
    foot.append(h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: async () => { const r = await (b.act && b.act(close)); if (r !== false) close(); } }, b.label));
  }
  const dlg = h('div', { class: 'dlg' + (wide ? ' wide' : '') },
    h('header', {}, h('h3', {}, title), h('button', { class: 'ib', html: ic('close'), onclick: close, title: 'Tutup' })),
    h('div', { class: 'bd' }, body), buttons.length ? foot : null);
  back.append(dlg);
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  $('#modal').append(back);
  return { close, el: dlg };
}
export function promptNum(title, label, val, cb, { min = 0, max = 9999, unit = 'px' } = {}) {
  const inp = h('input', { class: 'inp', type: 'number', value: val, min, max, style: { width: '120px' } });
  modal({ title, body: h('div', { class: 'fl' }, h('span', {}, label), h('div', { class: 'row' }, inp, unit)), buttons: [{ label: 'Batal' }, { label: 'OK', primary: true, act: () => cb(+inp.value) }] });
  setTimeout(() => inp.select(), 50);
}
export function confirmDlg(title, text, okLabel, cb, danger = true) {
  modal({ title, body: h('p', {}, text), buttons: [{ label: 'Batal' }, { label: okLabel, primary: !danger, danger, act: cb }] });
}

// ---------------- controls ----------------
function rangeCtl(label, min, max, step, get, set, o = {}) {
  const pow = o.pow || 1;
  const toT = v => Math.pow((v - min) / (max - min), 1 / pow) * 1000, fromT = t => min + Math.pow(t / 1000, pow) * (max - min);
  const r = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: toT(get()), style: o.w ? { width: o.w + 'px' } : null });
  const n = h('input', { class: 'num', type: 'number', min, max, step, value: fmt(get()) });
  function fmt(v) { return o.pct ? Math.round(v * 100) : Math.round(v / step) * step; }
  const apply = (v, fin) => { v = clamp(v, min, max); set(v, fin); n.value = fmt(v); };
  r.addEventListener('input', () => apply(+(fromT(+r.value)).toFixed(4)));
  r.addEventListener('change', () => apply(+(fromT(+r.value)).toFixed(4), true));
  n.addEventListener('change', () => { const v = o.pct ? +n.value / 100 : +n.value; apply(v, true); r.value = toT(clamp(v, min, max)); });
  const g = h('div', { class: 'rng' }, label ? h('label', { class: 'l' }, label) : null, r, n, o.pct ? '%' : (o.unit || ''));
  g.sync = () => { r.value = toT(get()); n.value = fmt(get()); };
  return g;
}
function segCtl(opts, get, set) {
  const s = h('div', { class: 'seg' });
  const draw = () => { s.innerHTML = ''; for (const [v, lab, title] of opts) s.append(h('button', { class: get() === v ? 'on' : '', title: title || '', html: lab, onclick: () => { set(v); draw(); } })); };
  draw();
  return s;
}
function selectCtl(opts, get, set, cls = 'sel') {
  const s = h('select', { class: cls, onchange: () => set(s.value) }, opts.map(([v, l]) => h('option', { value: v, selected: get() === v }, l)));
  return s;
}
const sep = () => h('div', { class: 'sep' });
const grp = (...k) => h('div', { class: 'grp' }, ...k);
const lab = t => h('label', { class: 'l' }, t);

// ---------------- toolbar ----------------
const TOOLS = [
  ['brush', 'brush', 'Kuas & pensil (B)'], ['eraser', 'eraser', 'Penghapus (E)'], ['smudge', 'smudge', 'Jari / campur warna (S)'],
  ['fill', 'fill', 'Ember isi warna (G)'], ['gradient', 'gradient', 'Gradien (⇧G)'], ['picker', 'picker', 'Pipet warna (I) · tahan ⌥ saat menggambar'],
  ['shape', 'shape', 'Bentuk: garis, panah, kotak, segitiga… (U)'], ['text', 'text', 'Teks (T)'], ['select', 'select', 'Seleksi (M · L laso · W tongkat)'],
  ['move', 'move', 'Pindah & ubah ukuran/putar (V)'], ['hand', 'hand', 'Geser tampilan (H / tahan Spasi)']
];
function buildTools(box, mobile) {
  box.innerHTML = '';
  for (const [id, icon, title] of TOOLS) {
    if (mobile && id === 'hand') continue;
    box.append(h('button', { class: 'ib' + (S.tool === id ? ' on' : ''), 'data-tool': id, title: K(title), html: ic(id === 'select' ? selIcon() : icon, 21), onclick: e => { if (S.tool === id && ['brush', 'eraser'].includes(id)) brushLib(e.currentTarget); else if (S.tool === id && id === 'shape') shapePicker(e.currentTarget); else setTool(id); } }));
  }
  box.append(h('hr'));
  box.append(h('button', { class: 'ib' + (S.ruler.on ? ' on' : ''), title: K('Penggaris (R)'), html: ic('ruler', 21), onclick: toggleRuler }));
  box.append(h('button', { class: 'ib' + (S.sym.on ? ' on' : ''), title: 'Simetri / cermin', html: ic('sym', 21), onclick: e => symPop(e.currentTarget) }));
  box.append(h('button', { class: 'ib', title: 'Sisipkan foto, ikon, emoji', html: ic('image', 21), onclick: e => insertMenu(e.currentTarget) }));
  if (mobile) {
    box.append(h('hr'));
    box.append(h('button', { class: 'ib', title: 'Lapisan', html: ic('layers', 21), onclick: () => openSheet('layers') }));
  }
  box.append(colorChips());
}
const selIcon = () => ({ lasso: 'lasso', wand: 'wand' })[S.tools.select.kind] || 'select';
function colorChips() {
  const c1 = h('button', { class: 'c1', style: { background: S.color }, title: 'Warna utama (klik untuk memilih)', onclick: () => openSheet('color') });
  const c2 = h('button', { class: 'c2', style: { background: S.color2 }, title: 'Warna kedua (X untuk tukar)', onclick: swapColors });
  const sw = h('button', { class: 'sw', title: 'Tukar warna (X)', onclick: swapColors }, '⇄');
  return h('div', { class: 'colors' }, c2, c1, sw);
}
export function swapColors() { const a = S.color; S.color = S.color2; S.color2 = a; emit('color'); savePrefs(); }
export function toggleRuler() {
  S.ruler.on = !S.ruler.on;
  if (S.ruler.on) {
    const v = visibleRect(), c = { x: v.x + v.w / 2, y: v.y + v.h / 2 }, L = Math.min(v.w, 900 / S.view.z) * .35;
    S.ruler.a = { x: c.x - L, y: c.y }; S.ruler.b = { x: c.x + L, y: c.y };
    toast('Penggaris: geser badannya untuk memindah, tarik titik biru untuk memutar. Gambar di sisi atas untuk garis lurus.', 3800);
  }
  S.ovDirty = true; emit('tool');
}
function openSheet(tab) {
  const side = $('#side');
  if (innerWidth > 860) { if (tab === 'color') $('#pColor').scrollIntoView({ block: 'nearest' }); return; }
  if (side.classList.contains('open') && side.dataset.tab === tab) { side.classList.remove('open'); return; }
  side.dataset.tab = tab; side.classList.add('open');
  $$('#sideTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  if (tab === 'nav') drawNav(true);
}

// ---------------- options bar ----------------
function brushChip(kind) {
  const o = S.tools[kind], p = presetById(o.preset);
  const c = h('canvas', { width: 144, height: 48 });
  previewStroke(c, p, getComputedStyle(document.documentElement).colorScheme === 'light' ? '#222' : '#222', 6);
  return h('button', { class: 'chip-btn', title: 'Pilih kuas', onclick: e => brushLib(e.currentTarget) }, c, h('b', {}, p.name), h('span', { html: ic('down', 14) }));
}
function sizeCtl(kind) {
  const o = S.tools[kind], p = presetById(o.preset);
  return rangeCtl('Ukuran', 1, Math.max(p.max || 200, o.size), 1, () => o.size, v => { o.size = Math.round(v * 10) / 10; (o.sizes || (o.sizes = {}))[o.preset] = o.size; syncQS(); savePrefs(); }, { pow: 2, unit: 'px' });
}
function opacityCtl(o, key = 'opacity', label = 'Opasitas') {
  return rangeCtl(label, 0.01, 1, .01, () => o[key], v => { o[key] = v; syncQS(); savePrefs(); }, { pct: true, w: 90 });
}
export function buildOpts() {
  const box = $('#opts');
  box.innerHTML = '';
  const t = S.tool;
  const add = (...k) => box.append(...k);
  if (t === 'brush' || t === 'eraser') {
    const o = S.tools[t];
    add(brushChip(t), sizeCtl(t), opacityCtl(o), sep(),
      grp(lab('Halus'), rangeCtl('', 0, .95, .01, () => o.smooth == null ? presetById(o.preset).smooth || 0 : o.smooth, v => { o.smooth = v; savePrefs(); }, { pct: true, w: 70 })), sep(),
      grp(lab('Garis'), segCtl([['solid', '━', 'Penuh'], ['dash', '╍', 'Putus-putus'], ['dot', '┈', 'Titik-titik']], () => o.dash, v => { o.dash = v; savePrefs(); buildOpts(); })));
    if (o.dash === 'dash') add(rangeCtl('Panjang', 1, 12, .5, () => o.dashLen, v => { o.dashLen = v; savePrefs(); }, { w: 60 }));
    if (o.dash !== 'solid') add(rangeCtl('Jarak', 1, 12, .5, () => o.dashGap, v => { o.dashGap = v; savePrefs(); }, { w: 60 }));
  } else if (t === 'smudge') {
    const o = S.tools.smudge;
    add(rangeCtl('Ukuran', 2, 400, 1, () => o.size, v => { o.size = Math.round(v); syncQS(); savePrefs(); }, { pow: 2, unit: 'px' }), opacityCtl(o, 'strength', 'Kekuatan'),
      h('span', { class: 'mut' }, 'Usap untuk mencampur & meratakan warna'));
  } else if (t === 'fill') {
    const o = S.tools.fill;
    add(rangeCtl('Toleransi', 0, 100, 1, () => o.tol, v => { o.tol = Math.round(v); savePrefs(); }, { w: 90 }), sep(),
      grp(lab('Acuan'), segCtl([['all', 'Semua lapisan'], ['layer', 'Lapisan ini']], () => o.ref, v => { o.ref = v; savePrefs(); })), sep(),
      rangeCtl('Lebarkan', 0, 6, 1, () => o.expand, v => { o.expand = Math.round(v); savePrefs(); }, { w: 60, unit: 'px' }),
      grp(segCtl([[true, 'Bersambung'], [false, 'Semua warna sama']], () => o.contig, v => { o.contig = v; savePrefs(); })), opacityCtl(o));
  } else if (t === 'gradient') {
    const o = S.tools.gradient;
    add(grp(lab('Jenis'), segCtl([['linear', 'Linear'], ['radial', 'Radial']], () => o.kind, v => { o.kind = v; savePrefs(); })), sep(),
      grp(segCtl([[false, 'Warna 1 → Warna 2'], [true, 'Warna → transparan']], () => o.toTransparent, v => { o.toTransparent = v; savePrefs(); })), opacityCtl(o),
      h('span', { class: 'mut' }, 'Tarik di kanvas · ⇧ untuk sudut lurus'));
  } else if (t === 'picker') {
    const o = S.tools.pick;
    add(grp(lab('Ambil dari'), segCtl([[true, 'Semua lapisan'], [false, 'Lapisan aktif']], () => o.all, v => { o.all = v; savePrefs(); })), h('span', { class: 'mut' }, 'Tip: tahan ⌥/Alt saat memakai kuas untuk pipet cepat'));
  } else if (t === 'shape') {
    const o = S.tools.shape;
    const cur = SHAPES.find(s => s[0] === o.kind);
    add(h('button', { class: 'chip-btn', style: { paddingLeft: '8px' }, onclick: e => shapePicker(e.currentTarget) }, h('span', { html: shapeIcon(o.kind) }), h('b', {}, cur ? cur[1] : ''), h('span', { html: ic('down', 14) })), sep(),
      grp(segCtl([['stroke', 'Garis'], ['fill', 'Isi'], ['both', 'Garis + isi']], () => o.mode, v => { o.mode = v; savePrefs(); S.ovDirty = true; })),
      rangeCtl('Tebal', 1, 120, 1, () => o.width, v => { o.width = Math.round(v); savePrefs(); S.ovDirty = true; }, { pow: 2, w: 80, unit: 'px' }),
      grp(lab('Gaya'), selectCtl([['solid', 'Penuh ━━'], ['dash', 'Putus-putus ╍╍'], ['long', 'Putus panjang — —'], ['dot', 'Titik-titik ···'], ['dashdot', 'Titik-garis -·-']], () => o.dash, v => { o.dash = v; savePrefs(); S.ovDirty = true; })));
    if (['polygon', 'star'].includes(o.kind)) add(rangeCtl(o.kind === 'star' ? 'Sudut' : 'Sisi', 3, 16, 1, () => o.sides, v => { o.sides = Math.round(v); savePrefs(); S.ovDirty = true; }, { w: 60 }));
    if (o.kind === 'roundrect') add(rangeCtl('Radius', 0, 300, 1, () => o.radius, v => { o.radius = Math.round(v); savePrefs(); S.ovDirty = true; }, { w: 70 }));
    add(opacityCtl(o));
    if (S.shape) add(sep(), h('button', { class: 'btn sm primary', onclick: () => { commitShape(); } }, 'Terapkan'), h('button', { class: 'btn sm', onclick: () => { S.shape = null; S.ovDirty = true; buildOpts(); } }, 'Batal'));
    else add(h('span', { class: 'mut' }, o.mode === 'both' ? 'Garis = warna 1, isi = warna 2 · ⇧ proporsional · ⌥ dari tengah' : '⇧ proporsional · ⌥ dari tengah'));
  } else if (t === 'text') {
    const o = S.tools.text;
    const l = S.textEdit ? S.textEdit.layer : activeLayer();
    const d = l && l.type === 'text' ? l.data : o;
    const set = p => applyTextOpts(p);
    add(selectCtl(FONTS.map(f => [f, f]), () => d.font, v => { document.fonts && document.fonts.load(`32px "${v}"`).then(() => { S.dirty = true; }); set({ font: v }); }),
      rangeCtl('', 6, 600, 1, () => d.size, v => set({ size: Math.round(v) }), { pow: 2, w: 80, unit: 'px' }),
      h('div', { class: 'seg' },
        h('button', { class: d.bold ? 'on' : '', html: '<b>B</b>', title: 'Tebal', onclick: () => { set({ bold: !d.bold }); buildOpts(); } }),
        h('button', { class: d.italic ? 'on' : '', html: '<i>I</i>', title: 'Miring', onclick: () => { set({ italic: !d.italic }); buildOpts(); } }),
        h('button', { class: d.underline ? 'on' : '', html: '<u>U</u>', title: 'Garis bawah', onclick: () => { set({ underline: !d.underline }); buildOpts(); } })),
      segCtl([['left', '⟸', 'Rata kiri'], ['center', '≡', 'Tengah'], ['right', '⟹', 'Rata kanan']], () => d.align, v => set({ align: v })), sep(),
      grp(lab('Warna'), h('input', { type: 'color', value: d.color || S.color, oninput: e => set({ color: e.target.value }) })),
      grp(lab('Garis tepi'), rangeCtl('', 0, 30, 1, () => d.stroke || 0, v => set({ stroke: Math.round(v) }), { w: 60 }), h('input', { type: 'color', value: d.strokeColor || '#ffffff', oninput: e => set({ strokeColor: e.target.value }) })),
      grp(lab('Latar'), h('input', { type: 'checkbox', checked: !!d.bgColor, onchange: e => { set({ bgColor: e.target.checked ? (S.color2 || '#ffff00') : null }); buildOpts(); } }), d.bgColor ? h('input', { type: 'color', value: d.bgColor, oninput: e => set({ bgColor: e.target.value }) }) : null),
      rangeCtl('Spasi', .8, 3, .05, () => d.lh, v => set({ lh: v }), { w: 60 }));
    if (S.textEdit) add(sep(), h('button', { class: 'btn sm primary', onclick: finishText }, 'Selesai'));
    else add(h('span', { class: 'mut' }, 'Klik kanvas untuk menulis · klik teks untuk mengedit'));
  } else if (t === 'select') {
    const o = S.tools.select;
    add(segCtl([['rect', ic('select', 16) + 'Kotak'], ['ellipse', '◯ Elips'], ['lasso', ic('lasso', 16) + 'Laso'], ['wand', ic('wand', 16) + 'Tongkat ajaib']], () => o.kind, v => { o.kind = v; savePrefs(); buildOpts(); buildToolbars(); }),
      segCtl([['new', 'Baru'], ['add', '+ Tambah'], ['sub', '− Kurangi'], ['inter', '∩ Irisan']], () => o.mode, v => { o.mode = v; savePrefs(); }));
    if (o.kind === 'wand') add(rangeCtl('Toleransi', 0, 100, 1, () => o.tol, v => { o.tol = Math.round(v); savePrefs(); }, { w: 80 }));
    add(sep(), h('button', { class: 'btn sm', onclick: ops.selectAll }, 'Semua'), h('button', { class: 'btn sm', onclick: ops.invertSel }, 'Balik'),
      h('button', { class: 'btn sm', onclick: ops.deselect, disabled: !S.sel }, 'Batal pilih'));
    if (S.sel) add(sep(), h('button', { class: 'btn sm', onclick: () => ops.fillLayer() }, 'Isi warna'), h('button', { class: 'btn sm', onclick: ops.deleteSel }, 'Hapus isi'),
      h('button', { class: 'btn sm', onclick: () => ops.selToLayer(false) }, 'Ke lapisan baru'), h('button', { class: 'btn sm', onclick: () => { setTool('move'); startFloat(); } }, 'Pindah / ubah'),
      h('button', { class: 'btn sm', onclick: () => promptNum('Perhalus tepi', 'Radius', 4, v => ops.modifySel('feather', v)) }, 'Perhalus'));
  } else if (t === 'move') {
    const l = activeLayer();
    add(h('button', { class: 'btn sm', html: ic('flip', 15) + 'Balik H', onclick: () => floatOp('fh') }), h('button', { class: 'btn sm', html: ic('flip', 15) + 'Balik V', onclick: () => floatOp('fv') }),
      h('button', { class: 'btn sm', html: ic('rotate', 15) + '90°', onclick: () => floatOp('r90') }), h('button', { class: 'btn sm', onclick: () => floatOp('center') }, 'Ke tengah'), h('button', { class: 'btn sm', onclick: () => floatOp('fit') }, 'Penuhi kertas'));
    if (S.float) add(sep(), h('button', { class: 'btn sm', onclick: () => floatOp('reset') }, 'Reset'), h('button', { class: 'btn sm primary', onclick: commitFloat }, 'Terapkan ↵'), h('button', { class: 'btn sm', onclick: cancelFloat }, 'Batal'));
    else add(h('span', { class: 'mut' }, l && l.type !== 'raster' ? 'Tarik sudut untuk ubah ukuran, bulatan biru untuk memutar' : 'Klik objek untuk memilih lapisannya · ⇧ bebas proporsi · panah = geser 1px'));
    if (l && l.type === 'text') add(sep(), h('button', { class: 'btn sm', onclick: () => editText(l) }, 'Edit teks'));
  } else if (t === 'hand') {
    add(h('button', { class: 'btn sm', onclick: () => fitView() }, 'Pas layar'), h('button', { class: 'btn sm', onclick: () => setZoom(1) }, '100%'),
      h('button', { class: 'btn sm', onclick: () => { S.view.r = 0; viewChanged(); } }, 'Reset putaran'), h('span', { class: 'mut' }, 'Dua jari: geser, cubit zoom, putar kanvas'));
  }
  syncQS();
}
const FONTS = ['Inter', 'Roboto Mono', 'Playfair Display', 'Merriweather', 'Oswald', 'Bebas Neue', 'Caveat', 'Patrick Hand', 'Comic Neue', 'Pacifico', 'Permanent Marker', 'Lobster'];

// ---------------- quick sliders (size / opacity) ----------------
function syncQS() {
  const q = $('#qs'), t = S.tool;
  const show = ['brush', 'eraser', 'smudge'].includes(t);
  q.hidden = !show;
  if (!show) return;
  const o = S.tools[t];
  const max = t === 'smudge' ? 400 : Math.max(presetById(o.preset).max || 200, o.size);
  const a = q.querySelector('.a'), b = q.querySelector('.b');
  a.max = 1000; a.value = Math.sqrt((o.size - 1) / (max - 1)) * 1000;
  b.value = (t === 'smudge' ? o.strength : o.opacity) * 1000;
  q.querySelector('.as').textContent = Math.round(o.size);
  q.querySelector('.bs').textContent = Math.round((t === 'smudge' ? o.strength : o.opacity) * 100) + '%';
}
function buildQS() {
  const q = $('#qs');
  const a = h('input', { type: 'range', class: 'a', min: 0, max: 1000, title: 'Ukuran' });
  const b = h('input', { type: 'range', class: 'b', min: 10, max: 1000, title: 'Opasitas' });
  q.append(h('small', { class: 'as' }), h('div', { class: 'v' }, a), h('hr'), h('div', { class: 'v' }, b), h('small', { class: 'bs' }));
  a.addEventListener('input', () => {
    const t = S.tool, o = S.tools[t], max = t === 'smudge' ? 400 : Math.max(presetById(o.preset).max || 200, o.size);
    o.size = Math.max(1, Math.round((1 + Math.pow(a.value / 1000, 2) * (max - 1)) * 10) / 10);
    if (t !== 'smudge') (o.sizes || (o.sizes = {}))[o.preset] = o.size;
    q.querySelector('.as').textContent = Math.round(o.size);
    const c = S.cursor || (() => { const r = canvasEl().getBoundingClientRect(); const w = s2w(r.width / 2, r.height / 2); return { x: w.x, y: w.y }; })();
    S.cursor = { ...c, r: o.size / 2 }; S.ovDirty = true;
    savePrefs(); $$('#opts .rng').forEach(x => x.sync && x.sync());
  });
  b.addEventListener('input', () => {
    const t = S.tool, o = S.tools[t];
    o[t === 'smudge' ? 'strength' : 'opacity'] = b.value / 1000;
    q.querySelector('.bs').textContent = Math.round(b.value / 10) + '%';
    savePrefs(); $$('#opts .rng').forEach(x => x.sync && x.sync());
  });
}

// ---------------- brush library ----------------
let libCat = null;
function brushLib(anchor) {
  const kind = S.tool === 'eraser' ? 'eraser' : 'brush';
  const o = S.tools[kind];
  const cur = presetById(o.preset);
  libCat = libCat || cur.cat;
  const box = h('div');
  const list = h('div', { class: 'list' });
  const cats = h('div', { class: 'cats seg' });
  const fillList = () => {
    cats.innerHTML = '';
    for (const c of CATS.filter(c => c !== 'Kustom')) cats.append(h('button', { class: c === libCat ? 'on' : '', onclick: () => { libCat = c; fillList(); } }, c));
    list.innerHTML = '';
    for (const p of PRESETS.filter(p => p.cat === libCat)) {
      const c = h('canvas', { width: 300, height: 76 });
      list.append(h('button', { class: 'bp' + (p.id === o.preset ? ' on' : ''), onclick: () => { selectPreset(kind, p.id); closePop(); } }, c, h('b', {}, p.name)));
      requestAnimationFrame(() => previewStroke(c, p, '#1f1f24', Math.min(p.size * 1.6, 22)));
    }
  };
  fillList();
  const adv = h('div', { class: 'adv' },
    h('div', { class: 'r' }, h('span', {}, 'Tekanan pena'), h('input', { type: 'range', min: 30, max: 250, value: (S.prefs.pCurve || 1) * 100, oninput: e => { S.prefs.pCurve = e.target.value / 100; savePrefs(); } })),
    h('label', { class: 'r' }, h('span', {}, 'Mouse terasa pena'), h('input', { type: 'checkbox', checked: S.prefs.simPressure, onchange: e => { S.prefs.simPressure = e.target.checked; savePrefs(); } }), h('small', { class: 'mut' }, 'tipis saat cepat')),
    h('label', { class: 'r' }, h('span', {}, 'Bentuk cepat'), h('input', { type: 'checkbox', checked: S.prefs.quickShape, onchange: e => { S.prefs.quickShape = e.target.checked; savePrefs(); } }), h('small', { class: 'mut' }, 'tahan di akhir goresan → garis/lingkaran rapi')));
  box.append(cats, list, adv);
  openPop(anchor, box, 'blib');
}
function selectPreset(kind, id) {
  const o = S.tools[kind], p = presetById(id);
  (o.sizes || (o.sizes = {}))[o.preset] = o.size;
  o.preset = id; o.size = (o.sizes && o.sizes[id]) || p.size; o.smooth = null;
  savePrefs(); buildOpts();
}
function shapeIcon(k) {
  const svg = { line: '<path d="M4 20L20 4"/>', arrow: '<path d="M4 20L19 5M11 5h8v8"/>', darrow: '<path d="M5 19L19 5M12 5h7v7M12 19H5v-7"/>', rect: '<rect x="4" y="5" width="16" height="14"/>', roundrect: '<rect x="4" y="5" width="16" height="14" rx="4"/>', ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>', triangle: '<path d="M12 4l9 16H3z"/>', rtriangle: '<path d="M4 4v16h16z"/>', diamond: '<path d="M12 3l9 9-9 9-9-9z"/>', polygon: '<path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/>', star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>', heart: '<path d="M12 20s-7-4.4-8.6-8.8C2.3 8 4.2 5 7.3 5c2 0 3.6 1.1 4.7 2.7C13.1 6.1 14.7 5 16.7 5c3.1 0 5 3 3.9 6.2C19 15.6 12 20 12 20z"/>', bubble: '<path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>', cross: '<path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z"/>' }[k] || '';
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${svg}</svg>`;
}
function shapePicker(anchor) {
  setTool('shape');
  const box = h('div');
  for (const [k, name] of SHAPES) box.append(h('button', { class: S.tools.shape.kind === k ? 'on' : '', onclick: () => { S.tools.shape.kind = k; if (S.shape) { S.shape.kind = k; S.ovDirty = true; } savePrefs(); closePop(); buildOpts(); } }, h('span', { html: shapeIcon(k) }), name));
  openPop(anchor, box, 'shapes');
}
function symPop(anchor) {
  const s = S.sym;
  const box = h('div', { class: 'menu', style: { padding: '6px', minWidth: '250px' } });
  const draw = () => {
    box.innerHTML = '';
    box.append(h('div', { class: 'hd' }, 'Simetri'),
      h('div', { class: 'tog', style: { padding: '4px 6px' } },
        ...[['off', 'Mati'], ['v', 'Vertikal'], ['h', 'Horizontal'], ['q', 'Kuadran'], ['r', 'Radial']].map(([m, l]) => h('button', { class: (m === 'off' ? !s.on : s.on && s.mode === m) ? 'on' : '', onclick: () => { if (m === 'off') s.on = false; else { if (!s.on) centerSym(); s.on = true; s.mode = m; } S.ovDirty = true; draw(); emit('tool'); } }, l))));
    if (s.mode === 'r') box.append(h('div', { style: { padding: '4px 6px' } }, rangeCtl('Bagian', 2, 24, 1, () => s.n, v => { s.n = Math.round(v); S.ovDirty = true; }, { w: 100 })),
      h('label', { class: 'switch', style: { padding: '4px 6px', border: 0 } }, h('span', {}, 'Cermin di tiap bagian'), h('input', { type: 'checkbox', checked: s.mirror, onchange: e => { s.mirror = e.target.checked; } })));
    box.append(h('button', { onclick: () => { centerSym(); S.ovDirty = true; } }, h('i', { class: 'ck' }), h('span', {}, 'Pusat ke tengah kertas/layar')),
      h('div', { class: 'mut', style: { padding: '4px 10px 6px', fontSize: '11.5px', whiteSpace: 'normal' } }, 'Tarik titik biru di kanvas untuk memindah pusat. Berlaku untuk kuas & penghapus.'));
  };
  draw();
  openPop(anchor, box, 'menu');
}
function centerSym() {
  const p = paperRect(), v = visibleRect(), r = p || v;
  S.sym.cx = r.x + r.w / 2; S.sym.cy = r.y + r.h / 2;
}
function insertMenu(anchor) {
  openMenu(anchor, [
    { label: 'Foto / gambar dari perangkat…', act: () => $('#fileImg').click() },
    { label: 'Ambil foto dari kamera', act: () => $('#fileCam').click() },
    { label: 'Tempel dari papan klip', kbd: '⌘V', act: () => ops.paste() },
    { sep: true },
    { label: 'Ikon…', act: () => insertDialog('icon') },
    { label: 'Emoji / stiker…', act: () => insertDialog('emoji') },
    { label: 'Teks', act: () => setTool('text') },
    { label: 'Bentuk', act: () => setTool('shape') },
    { sep: true },
    { label: 'Jendela referensi gambar', act: () => refWindow(true) }
  ]);
}
function insertDialog(tab) {
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'row', style: { marginBottom: '12px' } },
      segCtl([['icon', 'Ikon'], ['emoji', 'Emoji']], () => tab, v => { tab = v; draw(); }),
      tab === 'icon' ? h('span', { class: 'mut' }, 'Warna ikon = warna utama') : null,
      tab === 'icon' ? h('input', { type: 'color', value: S.color, oninput: e => { setColor(e.target.value); draw(); } }) : null));
    const g = h('div', { class: 'igrid' });
    if (tab === 'icon') for (const n of Object.keys(ICONS)) g.append(h('button', { title: n, html: `<svg viewBox="0 0 24 24"><path d="${ICONS[n]}" fill="${S.color}" fill-rule="evenodd"/></svg>`, onclick: () => { ops.insertIcon(n); m.close(); } }));
    else for (const e of EMOJI) g.append(h('button', { onclick: () => { ops.insertEmoji(e); m.close(); } }, e));
    body.append(g);
  };
  draw();
  const m = modal({ title: 'Sisipkan ikon & emoji', body, wide: true });
}

// ---------------- color panel ----------------
let hsv = [0, 0, 0];
function buildColor() {
  const p = $('#pColor');
  p.innerHTML = '';
  const sv = h('div', { class: 'sv' }, h('canvas', { width: 256, height: 150 }), h('i'));
  const hue = h('div', { class: 'hue' }, h('canvas', { width: 256, height: 16 }), h('i'));
  const hex = h('input', { class: 'inp hex', maxlength: 7, spellcheck: false });
  const cur = h('div', { class: 'cur' });
  const pick = h('button', { class: 'ib', title: 'Pipet (I)', html: ic('picker', 18), onclick: () => setTool('picker') });
  const sw = h('button', { class: 'ib', title: 'Tukar warna (X)', html: '⇄', onclick: swapColors });
  const c2 = h('button', { class: 'cur', title: 'Warna kedua', style: { border: 0 }, onclick: swapColors });
  const sws = h('div', { class: 'sws' });
  const recent = h('div', { class: 'sws' });
  const pals = h('div');
  p.append(h('h4', {}, 'Warna', h('span', { class: 'sp' })), sv, hue, h('div', { class: 'crow' }, cur, c2, hex, h('span', { class: 'sp' }), pick, sw),
    h('div', { class: 'pal-h' }, 'Palet'), sws, h('div', { class: 'pal-h' }, 'Terakhir dipakai'), recent, pals);
  const svc = sv.querySelector('canvas'), hc = hue.querySelector('canvas');
  const hg = cx2d(hc), grad = hg.createLinearGradient(0, 0, 256, 0);
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  hg.fillStyle = grad; hg.fillRect(0, 0, 256, 16);
  const drawSV = () => {
    const g = cx2d(svc), [r, gg, b] = hsv2rgb(hsv[0], 1, 1);
    g.fillStyle = rgb2hex(r, gg, b); g.fillRect(0, 0, 256, 150);
    const wg = g.createLinearGradient(0, 0, 256, 0); wg.addColorStop(0, '#fff'); wg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = wg; g.fillRect(0, 0, 256, 150);
    const bg = g.createLinearGradient(0, 0, 0, 150); bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, '#000'); g.fillStyle = bg; g.fillRect(0, 0, 256, 150);
  };
  const place = () => {
    sv.querySelector('i').style.left = hsv[1] * 100 + '%'; sv.querySelector('i').style.top = (1 - hsv[2]) * 100 + '%';
    sv.querySelector('i').style.background = S.color;
    hue.querySelector('i').style.left = hsv[0] / 360 * 100 + '%';
    cur.style.background = S.color; c2.style.background = S.color2;
    if (document.activeElement !== hex) hex.value = S.color.toUpperCase();
  };
  const setFromHsv = () => { const [r, g, b] = hsv2rgb(...hsv); S.color = rgb2hex(r, g, b); emit('color', 'panel'); savePrefs(); };
  const drag = (el, f) => el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    const mv = ev => { const r = el.getBoundingClientRect(); f(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); };
    mv(e);
    el.onpointermove = mv;
    el.onpointerup = () => { el.onpointermove = null; pushRecent(S.color); };
  });
  drag(sv, (x, y) => { hsv[1] = x; hsv[2] = 1 - y; setFromHsv(); place(); });
  drag(hue, x => { hsv[0] = x * 359.9; drawSV(); setFromHsv(); place(); });
  hex.addEventListener('change', () => { let v = hex.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { setColor(rgb2hex(...hex2rgb(v))); pushRecent(S.color); } });
  const DEF = ['#1f1f24', '#ffffff', '#8e8e93', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#000000', '#c7c7cc',
    '#ffd1dc', '#ffe5b4', '#fff5ba', '#c1f0c1', '#bde0fe', '#e0bbff', '#7a1f1f', '#1e5631', '#0b3d91', '#f4c095', '#e07a5f', '#3d405b', '#81b29a', '#f2cc8f', '#264653'];
  const swatch = (c, row) => h('button', { style: { background: c }, class: c.toLowerCase() === S.color.toLowerCase() ? 'on' : '', title: c, onclick: () => { setColor(c); pushRecent(c); }, oncontextmenu: e => { e.preventDefault(); setColor(c, true); } });
  const fill = () => {
    sws.innerHTML = ''; DEF.forEach(c => sws.append(swatch(c)));
    recent.innerHTML = ''; S.recent.forEach(c => recent.append(swatch(c)));
    if (!S.recent.length) recent.append(h('span', { class: 'mut', style: { gridColumn: '1/-1', fontSize: '11.5px' } }, 'Belum ada'));
    pals.innerHTML = '';
    (S.palettes || []).forEach((pl, i) => {
      const g = h('div', { class: 'sws' });
      pl.colors.forEach(c => g.append(swatch(c)));
      g.append(h('button', { class: 'add', title: 'Tambah warna saat ini', onclick: () => { pl.colors.push(S.color); savePrefs(); fill(); } }, '+'));
      pals.append(h('div', { class: 'pal-h' }, pl.name, h('span', { class: 'sp' }), h('button', { onclick: () => { S.palettes.splice(i, 1); savePrefs(); fill(); } }, 'Hapus')), g);
    });
    pals.append(h('div', { class: 'pal-h' }, h('button', { onclick: () => { (S.palettes || (S.palettes = [])).push({ name: 'Palet ' + ((S.palettes.length || 0) + 1), colors: [S.color] }); savePrefs(); fill(); } }, '+ Palet baru'), h('span', { class: 'sp' }),
      h('button', { onclick: paletteFromImage }, 'Ambil palet dari gambar')));
  };
  const sync = (src) => {
    if (src !== 'panel') {
      const [r, g, b] = hex2rgb(S.color), n = rgb2hsv(r, g, b);
      if (n[1] > 0.01 && n[2] > 0.01) hsv[0] = n[0];
      hsv[1] = n[1]; hsv[2] = n[2];
      drawSV();
    }
    place();
    sws.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.title.toLowerCase() === S.color.toLowerCase()));
  };
  fill(); sync();
  on('color', src => { sync(src); if (src !== 'panel') fill(); });
}
function paletteFromImage() {
  const r = rInt(workRect());
  if (!r || r.w < 1) return;
  const c = flatten(r, Math.min(1, 300 / Math.max(r.w, r.h)), { bg: false });
  const cols = ops.extractPalette(c, 10);
  if (!cols.length) { toast('Gambar masih kosong'); return; }
  (S.palettes || (S.palettes = [])).push({ name: 'Dari gambar', colors: cols });
  savePrefs(); emit('color'); toast('Palet diambil dari gambar');
}

// ---------------- layers panel ----------------
const thumbCache = new WeakMap();
function buildLayers() {
  const p = $('#pLayers');
  p.innerHTML = '';
  const bar = h('div', { class: 'lbar' },
    h('button', { class: 'ib sm', title: 'Lapisan baru', html: ic('plus', 18), onclick: () => ops.addLayer() }),
    h('button', { class: 'ib sm', title: 'Sisipkan foto', html: ic('image', 18), onclick: () => $('#fileImg').click() }),
    h('button', { class: 'ib sm', title: 'Duplikat (⌘J)', html: ic('copy', 18), onclick: () => ops.dupLayer() }),
    h('button', { class: 'ib sm', title: 'Gabung ke bawah (⌘E)', html: ic('merge', 18), onclick: () => ops.mergeDown(activeLayer()) }),
    h('span', { class: 'sp', style: { flex: 1 } }),
    h('button', { class: 'ib sm', title: 'Hapus lapisan', html: ic('trash', 18), onclick: () => ops.delLayer() }),
    h('button', { class: 'ib sm', title: 'Lainnya', html: ic('more', 18), onclick: e => layerMenu(e.currentTarget, activeLayer()) }));
  const list = h('div', { class: 'llist' });
  const props = h('div', { class: 'lprops' });
  p.append(h('h4', {}, 'Lapisan', h('span', { class: 'sp' }), h('span', { class: 'mut', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, '')), bar, list, props);
  renderLayerList();
}
function layerMeta(l) {
  const bits = [];
  if (l.type === 'text') bits.push('Teks'); else if (l.type === 'image') bits.push('Gambar');
  if (l.blend !== 'source-over') bits.push((BLENDS.find(b => b[0] === l.blend) || [, ''])[1]);
  if (l.opacity < 1) bits.push(Math.round(l.opacity * 100) + '%');
  return bits.join(' · ');
}
export function renderLayerList() {
  const p = $('#pLayers');
  if (!p || !S.doc) return;
  const list = p.querySelector('.llist'), props = p.querySelector('.lprops');
  list.innerHTML = '';
  const d = S.doc;
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const l = d.layers[i];
    const th = h('canvas', { class: 'thumb', width: 88, height: 68 });
    drawThumb(th, l);
    const row = h('div', { class: 'lrow' + (l.id === d.active ? ' on' : '') + (l.clip && i > 0 ? ' clip' : '') + (l.visible ? '' : ' hidden'), 'data-id': l.id },
      th,
      h('div', { class: 'nm' }, h('b', {}, l.name), h('small', { html: (l.locked ? ic('lock', 12) : '') + (l.alphaLock ? ic('alpha', 12) : '') + (l.clip ? ic('clip', 12) : '') + layerMeta(l) })),
      h('button', { class: 'ib sm', title: l.visible ? 'Sembunyikan' : 'Tampilkan', html: ic(l.visible ? 'eye' : 'eyeoff', 17), onclick: e => { e.stopPropagation(); ops.setLayerProp(l, 'visible', !l.visible, l.visible ? 'Sembunyikan' : 'Tampilkan'); } }));
    row.addEventListener('click', () => { if (d.active !== l.id) { commitPending(); d.active = l.id; renderLayerList(); S.ovDirty = true; emit('tool'); } });
    row.addEventListener('dblclick', () => renameLayer(l, row));
    row.addEventListener('contextmenu', e => { e.preventDefault(); d.active = l.id; renderLayerList(); layerMenu(row, l); });
    dragRow(row, l);
    list.append(row);
  }
  // properties of the active layer
  const l = activeLayer();
  props.innerHTML = '';
  if (!l) return;
  let dragTx = false;
  const op = h('input', {
    type: 'range', min: 0, max: 100, value: Math.round(l.opacity * 100),
    oninput: e => { if (!dragTx) { begin('Opasitas lapisan'); dragTx = true; } l.opacity = e.target.value / 100; opv.textContent = e.target.value + '%'; S.dirty = true; },
    onchange: () => { if (dragTx) { dragTx = false; end('Opasitas lapisan'); renderLayerList(); } }
  });
  const opv = h('span', { class: 'mut', style: { width: '38px', textAlign: 'right' } }, Math.round(l.opacity * 100) + '%');
  props.append(h('div', { class: 'r' }, h('span', {}, 'Opasitas'), op, opv),
    h('div', { class: 'r' }, h('span', {}, 'Campuran'), selectCtl(BLENDS, () => l.blend, v => ops.setLayerProp(l, 'blend', v, 'Mode campuran'))),
    h('div', { class: 'tog' },
      h('button', { class: l.locked ? 'on' : '', html: ic(l.locked ? 'lock' : 'unlock', 14) + 'Kunci', title: 'Kunci lapisan', onclick: () => ops.setLayerProp(l, 'locked', !l.locked, 'Kunci') }),
      h('button', { class: l.alphaLock ? 'on' : '', html: ic('alpha', 14) + 'Kunci alfa', title: 'Hanya mewarnai bagian yang sudah ada gambarnya', onclick: () => ops.setLayerProp(l, 'alphaLock', !l.alphaLock, 'Kunci alfa') }),
      h('button', { class: l.clip ? 'on' : '', html: ic('clip', 14) + 'Klip', title: 'Topeng kliping ke lapisan di bawah', onclick: () => ops.setLayerProp(l, 'clip', !l.clip, 'Topeng kliping') }),
      l.type !== 'raster' ? h('button', { onclick: () => ops.rasterizeLayer(l) }, 'Jadikan piksel') : null));
}
function drawThumb(c, l) {
  const g = cx2d(c);
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  const r = workRect({ x: 0, y: 0, w: 100, h: 100 });
  const s = Math.min(c.width / r.w, c.height / r.h);
  g.setTransform(s, 0, 0, s, (c.width - r.w * s) / 2 - r.x * s, (c.height - r.h * s) / 2 - r.y * s);
  g.imageSmoothingQuality = 'high';
  drawLayerContent(g, l, null, 0);
  thumbCache.set(l, l.ver);
}
function refreshThumbs() {
  if (!S.doc) return;
  for (const row of $$('#pLayers .lrow')) {
    const l = layerById(row.dataset.id);
    if (l && thumbCache.get(l) !== l.ver) drawThumb(row.querySelector('canvas'), l);
  }
}
function renameLayer(l, row) {
  const nm = row.querySelector('.nm b');
  const inp = h('input', { class: 'inp', value: l.name, style: { height: '24px', width: '100%' } });
  nm.replaceWith(inp); inp.focus(); inp.select();
  const done = () => { const v = inp.value.trim(); if (v && v !== l.name) ops.setLayerProp(l, 'name', v, 'Ganti nama'); else renderLayerList(); };
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = l.name; inp.blur(); } e.stopPropagation(); });
}
function dragRow(row, l) {
  let st = null, timer = null;
  row.addEventListener('pointerdown', e => {
    if (e.target.closest('button,input')) return;
    st = { y: e.clientY, id: e.pointerId, on: false, touch: e.pointerType === 'touch' };
    if (st.touch) timer = setTimeout(() => { if (st) { st.on = true; row.classList.add('dragging'); try { row.setPointerCapture(st.id); } catch (_) { } } }, 380);
  });
  row.addEventListener('pointermove', e => {
    if (!st) return;
    if (!st.on) {
      if (st.touch) { if (Math.abs(e.clientY - st.y) > 8) { clearTimeout(timer); st = null; } return; }
      if (Math.abs(e.clientY - st.y) < 6) return;
      st.on = true; row.classList.add('dragging'); row.setPointerCapture(st.id);
    }
    e.preventDefault();
    $$('#pLayers .lrow').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    const tgt = document.elementFromPoint(e.clientX, e.clientY);
    const r = tgt && tgt.closest('.lrow');
    if (r && r !== row) { const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-above' : 'drop-below'); st.target = r; st.above = e.clientY < b.top + b.height / 2; }
    else st.target = null;
  });
  const up = () => {
    clearTimeout(timer);
    if (st && st.on && st.target) {
      const d = S.doc, t = layerById(st.target.dataset.id);
      let ti = d.layers.indexOf(t);
      const fi = d.layers.indexOf(l);
      // list is drawn top-first: "above" in the list = higher index
      let to = st.above ? ti + 1 : ti;
      if (fi < to) to--;
      ops.moveLayer(l, to);
    }
    row.classList.remove('dragging');
    $$('#pLayers .lrow').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    st = null;
  };
  row.addEventListener('pointerup', up);
  row.addEventListener('pointercancel', up);
}
function layerMenu(anchor, l) {
  if (!l) return;
  const d = S.doc, i = d.layers.indexOf(l);
  openMenu(anchor, [
    { label: 'Ganti nama', act: () => { const row = $(`#pLayers .lrow[data-id="${l.id}"]`); row && renameLayer(l, row); } },
    { label: 'Duplikat', kbd: '⌘J', act: () => ops.dupLayer(l) },
    { label: 'Gabung ke bawah', kbd: '⌘E', dis: i === 0, act: () => ops.mergeDown(l) },
    { label: 'Gabung semua yang terlihat', act: () => ops.flattenLayers(true) },
    { label: 'Ratakan gambar', act: () => ops.flattenLayers(false) },
    { sep: true },
    { label: 'Naikkan', dis: i === d.layers.length - 1, act: () => ops.moveLayer(l, i + 1) },
    { label: 'Turunkan', dis: i === 0, act: () => ops.moveLayer(l, i - 1) },
    { sep: true },
    { label: 'Pilih isi lapisan', act: () => ops.selectLayerAlpha(l) },
    { label: 'Isi dengan warna utama', act: () => ops.fillLayer() },
    { label: 'Bersihkan', act: () => ops.clearLayer(l) },
    { label: 'Balik horizontal', act: () => ops.flipLayer(true) },
    { label: 'Balik vertikal', act: () => ops.flipLayer(false) },
    l.type !== 'raster' ? { label: 'Jadikan piksel', act: () => ops.rasterizeLayer(l) } : null,
    l.type === 'text' ? { label: 'Edit teks', act: () => { setTool('text'); editText(l); } } : null,
    { label: 'Ekspor lapisan ini (PNG)', act: () => exportLayerPng(l) },
    { sep: true },
    { label: 'Hapus lapisan', act: () => ops.delLayer(l) }
  ]);
}
async function exportLayerPng(l) {
  const b = contentBounds(l);
  if (!b) { toast('Lapisan kosong'); return; }
  const c = mk(b.w, b.h), g = cx2d(c);
  g.translate(-b.x, -b.y); drawLayerContent(g, l, null, 0);
  download(await toBlob(c), safeName(S.doc.name + ' - ' + l.name) + '.png');
}

// ---------------- navigator ----------------
let navImg = null, navT = null, navR = null;
function buildNav() {
  const p = $('#pNav');
  p.innerHTML = '';
  const c = h('canvas', { width: 560, height: 260 });
  p.append(h('h4', {}, 'Navigator', h('span', { class: 'sp' }), h('button', { class: 'ib sm', title: 'Pas layar', html: ic('fit', 16), onclick: () => fitView() })), c);
  const go = e => {
    if (!navR) return;
    const b = c.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * c.width, y = (e.clientY - b.top) / b.height * c.height;
    S.view.x = navR.x + (x - navR.ox) / navR.s; S.view.y = navR.y + (y - navR.oy) / navR.s; viewChanged();
  };
  c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); go(e); c.onpointermove = go; c.onpointerup = () => { c.onpointermove = null; }; });
}
export function drawNav(full) {
  const c = $('#pNav canvas');
  if (!c || !S.doc || c.offsetParent === null) return;
  if (full || !navImg) {
    const v = visibleRect();
    const base = S.doc.infinite ? (docBounds() || v) : paperRect();
    const r = S.doc.infinite ? { x: Math.min(base.x, v.x), y: Math.min(base.y, v.y), w: 0, h: 0 } : base;
    if (S.doc.infinite) { r.w = Math.max(base.x + base.w, v.x + v.w) - r.x; r.h = Math.max(base.y + base.h, v.y + v.h) - r.y; }
    const s = Math.min((c.width - 16) / r.w, (c.height - 16) / r.h);
    navR = { ...r, s, ox: (c.width - r.w * s) / 2, oy: (c.height - r.h * s) / 2 };
    navImg = flatten(r, Math.min(s, 1), {});
  }
  const g = cx2d(c), R = navR;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  g.drawImage(navImg, R.ox, R.oy, R.w * R.s, R.h * R.s);
  // viewport outline
  const inv = vm().inverse(), cv = canvasEl().getBoundingClientRect();
  const pts = [[0, 0], [cv.width, 0], [cv.width, cv.height], [0, cv.height]].map(([x, y]) => inv.transformPoint({ x, y }));
  g.beginPath();
  pts.forEach((p, i) => { const x = R.ox + (p.x - R.x) * R.s, y = R.oy + (p.y - R.y) * R.s; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.closePath(); g.lineWidth = 3; g.strokeStyle = '#ff5a5f'; g.stroke();
}
let navFull = false;
function navSoon(full) { navFull = navFull || full; clearTimeout(navT); navT = setTimeout(() => { const f = navFull; navFull = false; drawNav(f); }, navFull ? 350 : 30); }

// ---------------- HUD ----------------
function buildHud() {
  const hud = $('#hud');
  hud.innerHTML = '';
  const z = h('button', { class: 'z', title: 'Zoom', onclick: e => openMenu(e.currentTarget, [
    { label: 'Pas layar', kbd: '⌘0', act: () => fitView() }, { label: '25%', act: () => setZoom(.25) }, { label: '50%', act: () => setZoom(.5) }, { label: '100%', kbd: '⌘1', act: () => setZoom(1) },
    { label: '200%', act: () => setZoom(2) }, { label: '400%', act: () => setZoom(4) }, { label: '800%', act: () => setZoom(8) }, { sep: true },
    { label: 'Reset putaran', act: () => { S.view.r = 0; viewChanged(); } }, { label: 'Cermin tampilan', check: S.view.flip, act: () => { S.view.flip = !S.view.flip; viewChanged(); } }
  ]) });
  const pos = h('span', { class: 'pos' });
  const rot = h('button', { class: 'ib sm', title: 'Reset putaran', html: ic('rotate', 16), onclick: () => { S.view.r = 0; viewChanged(); } });
  hud.append(pos, rot, h('button', { class: 'ib sm', title: 'Perkecil', html: ic('zoomout', 17), onclick: () => setZoom(S.view.z / 1.25) }), z,
    h('button', { class: 'ib sm', title: 'Perbesar', html: ic('zoomin', 17), onclick: () => setZoom(S.view.z * 1.25) }),
    h('button', { class: 'ib sm', title: 'Pas layar', html: ic('fit', 17), onclick: () => fitView() }));
  const upd = () => {
    z.textContent = Math.round(S.view.z * 100) + '%';
    const deg = Math.round((((S.view.r * 180 / Math.PI) % 360) + 360) % 360);
    rot.hidden = !deg; rot.title = 'Putaran ' + deg + '° — klik untuk reset';
  };
  on('view', upd); upd();
  on('pointer', p => {
    const d = S.doc;
    if (!d) return;
    const mm = v => (v / d.dpi * 25.4).toFixed(0);
    pos.textContent = `${Math.round(p.x)}, ${Math.round(p.y)} px` + (d.infinite ? '' : ` · ${mm(p.x)},${mm(p.y)} mm`);
  });
}

// ---------------- menus ----------------
function menuDefs() {
  const l = activeLayer();
  return {
    File: [
      { label: 'Gambar baru…', kbd: '⌘N', act: () => newDocDialog() },
      { label: 'Galeri', act: () => App.toGallery() },
      { label: 'Buka file (gambar, PSD, proyek)…', kbd: '⌘O', act: () => $('#fileOpen').click() },
      { sep: true },
      { label: 'Simpan sekarang', kbd: '⌘S', act: async () => { await saveNow(); toast('Tersimpan di perangkat ini'); } },
      { label: 'Simpan file proyek (.sketch)', act: () => quickExport('sketch') },
      { sep: true },
      { label: 'Ekspor…', kbd: '⇧⌘E', act: () => exportDialog() },
      { label: 'Ekspor cepat PNG', act: () => quickExport('png') },
      { label: 'Ekspor cepat JPG', act: () => quickExport('jpg') },
      { label: 'Ekspor PDF', act: () => quickExport('pdf') },
      { label: 'Ekspor Photoshop (.psd berlapis)', act: () => quickExport('psd') },
      { label: 'Cetak…', kbd: '⌘P', act: printDoc }
    ],
    Edit: [
      { label: 'Urungkan' + (H.undo.length ? ' ' + H.undo[H.undo.length - 1].label : ''), kbd: '⌘Z', dis: !H.undo.length, act: doUndo },
      { label: 'Ulangi' + (H.redo.length ? ' ' + H.redo[H.redo.length - 1].label : ''), kbd: '⇧⌘Z', dis: !H.redo.length, act: doRedo },
      { sep: true },
      { label: 'Potong', kbd: '⌘X', act: () => ops.cutSel() },
      { label: 'Salin', kbd: '⌘C', act: () => ops.copySel(false) },
      { label: 'Salin gabungan', kbd: '⇧⌘C', act: () => ops.copySel(true) },
      { label: 'Tempel', kbd: '⌘V', act: () => ops.paste() },
      { label: 'Hapus isi', kbd: '⌫', act: () => ops.deleteSel() },
      { label: 'Isi dengan warna utama', kbd: '⌥⌫', act: () => ops.fillLayer(S.color) },
      { label: 'Isi dengan warna kedua', kbd: '⌘⌫', act: () => ops.fillLayer(S.color2) },
      { sep: true },
      { label: 'Riwayat langkah…', act: historyDialog },
      { label: 'Pengaturan…', act: settingsDialog }
    ],
    Kanvas: [
      { label: 'Ukuran kertas / kanvas…', act: canvasSizeDialog },
      { label: 'Skala gambar…', dis: S.doc.infinite, act: scaleDialog },
      { label: 'Latar & pola kertas…', act: bgDialog },
      { sep: true },
      { label: 'Putar 90° searah jarum jam', act: () => ops.rotateCanvas(90) },
      { label: 'Putar 90° berlawanan', act: () => ops.rotateCanvas(-90) },
      { label: 'Putar 180°', act: () => ops.rotateCanvas(180) },
      { label: 'Balik horizontal', act: () => ops.flipCanvas(true) },
      { label: 'Balik vertikal', act: () => ops.flipCanvas(false) },
      { sep: true },
      { label: 'Pangkas ke seleksi', dis: !S.sel, act: ops.cropToSelection },
      { label: 'Pangkas ke isi gambar', act: ops.cropToContent },
      { label: S.doc.infinite ? 'Ubah ke kertas (pas isi gambar)' : 'Ubah ke kanvas tak terbatas', act: () => ops.setInfinite(!S.doc.infinite) }
    ],
    Lapisan: [
      { label: 'Lapisan baru', kbd: '⇧⌘N', act: () => ops.addLayer() },
      { label: 'Duplikat lapisan', kbd: '⌘J', act: () => ops.dupLayer() },
      { label: 'Hapus lapisan', act: () => ops.delLayer() },
      { label: 'Gabung ke bawah', kbd: '⌘E', act: () => ops.mergeDown(activeLayer()) },
      { label: 'Gabung semua yang terlihat', act: () => ops.flattenLayers(true) },
      { label: 'Ratakan gambar', act: () => ops.flattenLayers(false) },
      { sep: true },
      { label: 'Sisipkan foto…', act: () => $('#fileImg').click() },
      { label: 'Sisipkan ikon / emoji…', act: () => insertDialog('icon') },
      { label: 'Jadikan piksel', dis: !l || l.type === 'raster', act: () => ops.rasterizeLayer() },
      { label: 'Kunci alfa', check: l && l.alphaLock, act: () => l && ops.setLayerProp(l, 'alphaLock', !l.alphaLock, 'Kunci alfa') },
      { label: 'Topeng kliping', check: l && l.clip, act: () => l && ops.setLayerProp(l, 'clip', !l.clip, 'Topeng kliping') },
      { label: 'Balik lapisan horizontal', act: () => ops.flipLayer(true) },
      { label: 'Balik lapisan vertikal', act: () => ops.flipLayer(false) }
    ],
    Seleksi: [
      { label: 'Pilih semua', kbd: '⌘A', act: ops.selectAll },
      { label: 'Batal pilih', kbd: '⌘D', dis: !S.sel, act: ops.deselect },
      { label: 'Balik pilihan', kbd: '⇧⌘I', act: ops.invertSel },
      { label: 'Pilih isi lapisan', act: () => ops.selectLayerAlpha() },
      { sep: true },
      { label: 'Perlebar…', dis: !S.sel, act: () => promptNum('Perlebar seleksi', 'Sebesar', 4, v => ops.modifySel('grow', v)) },
      { label: 'Perkecil…', dis: !S.sel, act: () => promptNum('Perkecil seleksi', 'Sebesar', 4, v => ops.modifySel('shrink', v)) },
      { label: 'Perhalus tepi…', dis: !S.sel, act: () => promptNum('Perhalus tepi', 'Radius', 4, v => ops.modifySel('feather', v)) },
      { sep: true },
      { label: 'Salin ke lapisan baru', kbd: '⌘J', dis: !S.sel, act: () => ops.selToLayer(false) },
      { label: 'Potong ke lapisan baru', kbd: '⇧⌘J', dis: !S.sel, act: () => ops.selToLayer(true) }
    ],
    Filter: [{ hd: 'Berlaku pada lapisan aktif' + (S.sel ? ' (dalam seleksi)' : '') }, ...FILTERS.map(f => ({ label: f.name + (f.params.length ? '…' : ''), act: () => filterDialog(f) }))],
    Tampilan: [
      { label: 'Perbesar', kbd: '⌘+', act: () => setZoom(S.view.z * 1.25) },
      { label: 'Perkecil', kbd: '⌘−', act: () => setZoom(S.view.z / 1.25) },
      { label: 'Pas layar', kbd: '⌘0', act: () => fitView() },
      { label: 'Ukuran asli 100%', kbd: '⌘1', act: () => setZoom(1) },
      { label: 'Reset putaran', act: () => { S.view.r = 0; viewChanged(); } },
      { label: 'Cermin tampilan (cek proporsi)', check: S.view.flip, act: () => { S.view.flip = !S.view.flip; viewChanged(); } },
      { sep: true },
      { label: 'Kisi bantu', kbd: "⌘'", check: S.grid, act: () => { S.grid = !S.grid; S.ovDirty = true; } },
      { label: 'Ukuran kisi…', act: () => promptNum('Ukuran kisi bantu', 'Jarak', S.gridSize, v => { S.gridSize = Math.max(2, v); S.grid = true; S.ovDirty = true; }) },
      { label: 'Kisi piksel saat zoom besar', check: S.prefs.pixelGrid, act: () => { S.prefs.pixelGrid = !S.prefs.pixelGrid; savePrefs(); S.ovDirty = true; } },
      { label: 'Penggaris', kbd: 'R', check: S.ruler.on, act: toggleRuler },
      { label: 'Jendela referensi', act: () => refWindow(true) },
      { sep: true },
      { label: 'Mode fokus (sembunyikan panel)', kbd: 'Tab', act: toggleFocus },
      { label: 'Tema ' + (S.prefs.theme === 'dark' ? 'terang' : 'gelap'), act: toggleTheme },
      { label: 'Pintasan keyboard', kbd: '?', act: shortcutsDialog }
    ]
  };
}
function buildMenus() {
  const nav = $('#menus');
  nav.innerHTML = '';
  for (const name of ['File', 'Edit', 'Kanvas', 'Lapisan', 'Seleksi', 'Filter', 'Tampilan']) {
    const b = h('button', { onclick: e => { const r = openMenu(e.currentTarget, menuDefs()[name]); if (r) e.currentTarget.classList.add('open'); } }, name);
    b.addEventListener('pointerenter', () => { if (popAnchor && popAnchor.parentElement === nav && popAnchor !== b) b.click(); });
    nav.append(b);
  }
  $('#bMenuM').onclick = e => {
    const defs = menuDefs(), items = [];
    for (const k of Object.keys(defs)) { items.push({ hd: k }); items.push(...defs[k].filter(x => !x.hd)); }
    openMenu(e.currentTarget, items);
  };
}
export function toggleTheme() {
  S.prefs.theme = S.prefs.theme === 'dark' ? 'light' : 'dark';
  applyTheme(); savePrefs();
}
export function applyTheme() {
  document.documentElement.dataset.theme = S.prefs.theme;
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = S.prefs.theme === 'dark' ? '#17171a' : '#f2f2f5';
  themeChanged();
  const gt = $('#gTheme'); if (gt) gt.innerHTML = ic(S.prefs.theme === 'dark' ? 'sun' : 'moon', 18);
}
function toggleFocus() { $('#app').classList.toggle('focus'); }
export function doUndo() { commitPending(); const l = undo(); if (l) toast('Urungkan: ' + l, 1100); emit('layers'); emit('stroke'); }
export function doRedo() { const l = redo(); if (l) toast('Ulangi: ' + l, 1100); emit('layers'); emit('stroke'); }

// ---------------- dialogs ----------------
const PRESET_SIZES = [
  { id: 'inf', name: 'Tak terbatas', sub: 'tanpa batas kertas', inf: true },
  { id: 'a4p', name: 'A4 Potret', mm: [210, 297] }, { id: 'a4l', name: 'A4 Lanskap', mm: [297, 210] },
  { id: 'a3p', name: 'A3', mm: [297, 420] }, { id: 'a5p', name: 'A5', mm: [148, 210] }, { id: 'f4', name: 'F4 / Folio', mm: [215, 330] },
  { id: 'letter', name: 'Letter', mm: [215.9, 279.4] }, { id: 'sq', name: 'Kotak', px: [2048, 2048] }, { id: 'hd', name: 'Layar HD', px: [1920, 1080] },
  { id: '4k', name: '4K', px: [3840, 2160] }, { id: 'ig', name: 'Instagram', px: [1080, 1080] }, { id: 'story', name: 'Story / Reels', px: [1080, 1920] },
  { id: 'yt', name: 'Thumbnail YouTube', px: [1280, 720] }, { id: 'card', name: 'Kartu nama', mm: [90, 55] }, { id: 'poster', name: 'Poster A2', mm: [420, 594] }
];
const presetPx = (p, dpi) => p.px ? p.px : p.mm ? p.mm.map(v => Math.round(v / 25.4 * dpi)) : [0, 0];
const presetSub = (p, dpi) => p.sub || (p.mm ? `${p.mm[0]}×${p.mm[1]} mm` : `${p.px[0]}×${p.px[1]} px`);
function presetThumb(p) {
  if (p.inf) return h('i', { class: 'inf', style: { width: '30px', height: '30px' } });
  const [w, hh] = p.mm || p.px, s = 34 / Math.max(w, hh);
  return h('i', { style: { width: Math.max(8, w * s) + 'px', height: Math.max(8, hh * s) + 'px' } });
}
export function quickTiles(box) {
  box.innerHTML = '';
  for (const id of ['inf', 'a4p', 'a4l', 'sq', 'hd', 'story']) {
    const p = PRESET_SIZES.find(x => x.id === id);
    box.append(h('button', { class: 'qk', onclick: () => createFromPreset(p, 150) }, h('div', { class: 'shp' }, presetThumb(p)), h('b', {}, p.name), h('small', {}, presetSub(p))));
  }
  box.append(h('button', { class: 'qk', onclick: () => newDocDialog() }, h('div', { class: 'shp', html: ic('sliders', 30) }), h('b', {}, 'Ukuran kustom…'), h('small', {}, 'px · mm · cm · dpi')));
  box.append(h('button', { class: 'qk', onclick: () => { App.importNext = true; $('#fileOpen').click(); } }, h('div', { class: 'shp', html: ic('image', 30) }), h('b', {}, 'Dari foto'), h('small', {}, 'buka foto jadi kanvas')));
}
function createFromPreset(p, dpi, extra = {}) {
  if (p.inf) App.newDocument({ infinite: true, name: extra.name, bg: extra.bg, bgOn: extra.bgOn, paper: extra.paper, dpi });
  else { const [w, hh] = presetPx(p, dpi); App.newDocument({ w, h: hh, dpi, ...extra }); }
}
export function newDocDialog() {
  const st = { preset: PRESET_SIZES[1], dpi: 150, unit: 'px', w: 1240, h: 1754, bg: '#ffffff', bgOn: true, paper: 'plain', name: '' };
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    const grid = h('div', { class: 'presets' });
    for (const p of PRESET_SIZES) grid.append(h('button', { class: st.preset === p ? 'on' : '', onclick: () => { st.preset = p; if (!p.inf) { [st.w, st.h] = presetPx(p, st.dpi); } draw(); } }, presetThumb(p), h('b', {}, p.name), h('small', {}, presetSub(p, st.dpi))));
    const conv = v => st.unit === 'px' ? v : st.unit === 'mm' ? +(v / st.dpi * 25.4).toFixed(1) : st.unit === 'cm' ? +(v / st.dpi * 2.54).toFixed(2) : +(v / st.dpi).toFixed(2);
    const back = v => st.unit === 'px' ? v : st.unit === 'mm' ? v / 25.4 * st.dpi : st.unit === 'cm' ? v / 2.54 * st.dpi : v * st.dpi;
    const wI = h('input', { class: 'inp', type: 'number', value: conv(st.w), style: { width: '100px' }, onchange: e => { st.w = Math.round(back(+e.target.value)); st.preset = null; draw(); } });
    const hI = h('input', { class: 'inp', type: 'number', value: conv(st.h), style: { width: '100px' }, onchange: e => { st.h = Math.round(back(+e.target.value)); st.preset = null; draw(); } });
    const inf = st.preset && st.preset.inf;
    body.append(h('div', { class: 'fl' }, h('span', {}, 'Nama'), h('input', { class: 'inp', placeholder: 'Tanpa judul', value: st.name, oninput: e => st.name = e.target.value })),
      h('div', { class: 'fl' }, h('span', {}, 'Ukuran kertas'), grid),
      inf ? h('p', { class: 'mut' }, 'Kanvas tanpa batas — geser & zoom sebebasnya, gambar tidak pernah terpotong. Saat ekspor, ukuran mengikuti isi gambar.') :
        h('div', { class: 'fl' }, h('span', {}, 'Ukuran kustom'), h('div', { class: 'row' }, wI, '×', hI,
          selectCtl([['px', 'px'], ['mm', 'mm'], ['cm', 'cm'], ['in', 'inci']], () => st.unit, v => { st.unit = v; draw(); }),
          h('button', { class: 'btn sm', title: 'Tukar potret/lanskap', onclick: () => { [st.w, st.h] = [st.h, st.w]; st.preset = null; draw(); } }, '⇄ Orientasi'),
          h('span', { class: 'mut' }, `${st.w} × ${st.h} px`))),
      h('div', { class: 'fl' }, h('span', {}, 'Resolusi (untuk ukuran mm & cetak)'), segCtl([[72, '72 dpi · layar'], [150, '150 dpi · standar'], [300, '300 dpi · cetak']], () => st.dpi, v => { st.dpi = v; if (st.preset && !st.preset.inf) [st.w, st.h] = presetPx(st.preset, v); draw(); })),
      h('div', { class: 'fl' }, h('span', {}, 'Latar'), h('div', { class: 'row' },
        segCtl([[true, 'Warna'], [false, 'Transparan']], () => st.bgOn, v => { st.bgOn = v; draw(); }),
        st.bgOn ? h('input', { type: 'color', value: st.bg, oninput: e => st.bg = e.target.value }) : null,
        selectCtl([['plain', 'Polos'], ['grid', 'Kotak-kotak'], ['dots', 'Titik'], ['lines', 'Bergaris (buku tulis)'], ['iso', 'Isometrik']], () => st.paper, v => st.paper = v))));
  };
  draw();
  modal({
    title: 'Gambar baru', body, wide: true, buttons: [{ label: 'Batal' }, {
      label: 'Buat', primary: true, act: () => {
        const extra = { name: st.name || undefined, bg: st.bg, bgOn: st.bgOn, paper: st.paper };
        if (st.preset && st.preset.inf) createFromPreset(st.preset, st.dpi, extra);
        else App.newDocument({ w: clamp(st.w, 1, 16000), h: clamp(st.h, 1, 16000), dpi: st.dpi, ...extra });
      }
    }]
  });
}
function canvasSizeDialog() {
  const d = S.doc;
  if (d.infinite) {
    confirmDlg('Kanvas tak terbatas', 'Kanvas ini tidak punya batas kertas. Ubah ke kertas seukuran isi gambar?', 'Ubah ke kertas', () => ops.setInfinite(false), false);
    return;
  }
  const st = { w: d.w, h: d.h, ax: .5, ay: .5 };
  const anch = h('div', { class: 'anchor' });
  const drawA = () => { anch.innerHTML = ''; for (const ay of [0, .5, 1]) for (const ax of [0, .5, 1]) anch.append(h('button', { class: st.ax === ax && st.ay === ay ? 'on' : '', onclick: () => { st.ax = ax; st.ay = ay; drawA(); } })); };
  drawA();
  const mm = v => (v / d.dpi * 25.4).toFixed(1);
  const info = h('span', { class: 'mut' });
  const upd = () => info.textContent = `${mm(st.w)} × ${mm(st.h)} mm @ ${d.dpi} dpi`;
  const wI = h('input', { class: 'inp', type: 'number', value: st.w, style: { width: '110px' }, oninput: e => { st.w = +e.target.value; upd(); } });
  const hI = h('input', { class: 'inp', type: 'number', value: st.h, style: { width: '110px' }, oninput: e => { st.h = +e.target.value; upd(); } });
  upd();
  const sel = h('select', { class: 'sel', onchange: e => { const p = PRESET_SIZES.find(x => x.id === e.target.value); if (p && !p.inf) { [st.w, st.h] = presetPx(p, d.dpi); wI.value = st.w; hI.value = st.h; upd(); } } },
    h('option', { value: '' }, 'Pilih ukuran standar…'), PRESET_SIZES.filter(p => !p.inf).map(p => h('option', { value: p.id }, p.name + ' — ' + presetSub(p))));
  modal({
    title: 'Ukuran kertas / kanvas', body: h('div', {},
      h('div', { class: 'fl' }, h('span', {}, 'Ukuran standar'), sel),
      h('div', { class: 'fl' }, h('span', {}, 'Lebar × tinggi (px)'), h('div', { class: 'row' }, wI, '×', hI, info)),
      h('div', { class: 'fl' }, h('span', {}, 'Posisi gambar lama (jangkar)'), anch),
      h('p', { class: 'mut' }, 'Gambar tidak diperbesar/diperkecil — hanya kertasnya yang berubah. Untuk mengubah skala gambar pakai Kanvas → Skala gambar.')),
    buttons: [{ label: 'Batal' }, { label: 'Terapkan', primary: true, act: () => ops.resizeCanvas(st.w, st.h, st.ax, st.ay) }]
  });
}
function scaleDialog() {
  const d = S.doc;
  const st = { w: d.w, h: d.h, keep: true };
  const wI = h('input', { class: 'inp', type: 'number', value: st.w, style: { width: '110px' } });
  const hI = h('input', { class: 'inp', type: 'number', value: st.h, style: { width: '110px' } });
  const pct = h('input', { class: 'inp', type: 'number', value: 100, style: { width: '80px' } });
  wI.oninput = () => { st.w = +wI.value; if (st.keep) { st.h = Math.round(st.w * d.h / d.w); hI.value = st.h; } pct.value = Math.round(st.w / d.w * 100); };
  hI.oninput = () => { st.h = +hI.value; if (st.keep) { st.w = Math.round(st.h * d.w / d.h); wI.value = st.w; } pct.value = Math.round(st.h / d.h * 100); };
  pct.oninput = () => { st.w = Math.round(d.w * pct.value / 100); st.h = Math.round(d.h * pct.value / 100); wI.value = st.w; hI.value = st.h; };
  modal({
    title: 'Skala gambar', body: h('div', {},
      h('div', { class: 'fl' }, h('span', {}, 'Ukuran baru (px)'), h('div', { class: 'row' }, wI, '×', hI, h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: true, onchange: e => st.keep = e.target.checked }), 'Kunci rasio'))),
      h('div', { class: 'fl' }, h('span', {}, 'Atau persen'), h('div', { class: 'row' }, pct, '%'))),
    buttons: [{ label: 'Batal' }, { label: 'Terapkan', primary: true, act: () => ops.scaleImage(clamp(st.w, 1, 16000), clamp(st.h, 1, 16000)) }]
  });
}
function bgDialog() {
  const d = S.doc;
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    const PAPERS = ['#ffffff', '#fffdf5', '#f6efe0', '#e9e4d8', '#d9c7a7', '#fdf2f8', '#eef6ff', '#1f1f24', '#0f2a1d', '#13213a'];
    body.append(h('div', { class: 'fl' }, h('span', {}, 'Warna kertas'), h('div', { class: 'row' },
      segCtl([[true, 'Berwarna'], [false, 'Transparan']], () => d.bgOn, v => ops.setBg({ bgOn: v }) || draw()),
      h('input', { type: 'color', value: d.bg, onchange: e => { ops.setBg({ bg: e.target.value, bgOn: true }); draw(); } }),
      ...PAPERS.map(c => h('button', { style: { width: '26px', height: '26px', borderRadius: '7px', border: '1px solid var(--line)', background: c }, onclick: () => { ops.setBg({ bg: c, bgOn: true }); draw(); } })))),
      h('div', { class: 'fl' }, h('span', {}, 'Pola kertas'), segCtl([['plain', 'Polos'], ['grid', 'Kotak'], ['dots', 'Titik'], ['lines', 'Garis'], ['iso', 'Isometrik']], () => d.paper, v => { ops.setBg({ paper: v }); draw(); })),
      d.paper !== 'plain' ? h('div', { class: 'fl' }, h('span', {}, 'Jarak pola'), rangeCtl('', 8, 200, 1, () => d.paperSp, v => { d.paperSp = Math.round(v); S.dirty = true; }, { unit: 'px' })) : null,
      h('p', { class: 'mut' }, 'Pola kertas ikut tercetak & terekspor. Untuk garis bantu yang tidak ikut terekspor, pakai Tampilan → Kisi bantu.'));
  };
  draw();
  modal({ title: 'Latar & pola kertas', body, buttons: [{ label: 'Selesai', primary: true }] });
}
function filterDialog(f) {
  const l = activeLayer();
  if (!l) return;
  if (l.locked) { toast('Lapisan terkunci 🔒'); return; }
  commitPending();
  const cb = contentBounds(l);
  if (!cb) { toast('Lapisan aktif masih kosong'); return; }
  const p = {};
  f.params.forEach(([k, , , , v]) => p[k] = v);
  const padK = f.pad ? 60 : 0;
  let r = rInt({ x: cb.x - padK, y: cb.y - padK, w: cb.w + padK * 2, h: cb.h + padK * 2 });
  const pr = paperRect();
  if (pr) r = rInter(r, pr) || r;
  if (S.sel) r = rInter(r, rInt(selRect())) || r;
  const src = (() => { const c = mk(r.w, r.h), g = cx2d(c); g.translate(-r.x, -r.y); drawLayerContent(g, l, null, 0); return c; })();
  const compose = out => {
    if (!S.sel) return out;
    const c = mk(r.w, r.h), g = cx2d(c);
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'destination-out'; g.drawImage(S.sel.c, S.sel.x - r.x, S.sel.y - r.y);
    const m = mk(r.w, r.h), mg = cx2d(m); mg.drawImage(out, 0, 0); mg.globalCompositeOperation = 'destination-in'; mg.drawImage(S.sel.c, S.sel.x - r.x, S.sel.y - r.y);
    g.globalCompositeOperation = 'source-over'; g.drawImage(m, 0, 0);
    return c;
  };
  // preview replaces the whole layer while open
  const full = cb;
  let busy = false, pend = false;
  const preview = () => {
    if (busy) { pend = true; return; }
    busy = true;
    requestAnimationFrame(() => {
      try {
        const out = compose(applyFilter(f.id, p, src));
        const base = mk(Math.max(full.x + full.w, r.x + r.w) - Math.min(full.x, r.x), Math.max(full.y + full.h, r.y + r.h) - Math.min(full.y, r.y));
        const ox = Math.min(full.x, r.x), oy = Math.min(full.y, r.y), g = cx2d(base);
        g.translate(-ox, -oy); drawLayerContent(g, { ...l, _preview: null }, null, 0);
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(r.x - ox, r.y - oy, r.w, r.h); g.drawImage(out, r.x - ox, r.y - oy);
        l._preview = { c: base, x: ox, y: oy };
        S.dirty = true;
      } finally { busy = false; if (pend) { pend = false; preview(); } }
    });
  };
  const body = h('div');
  for (const [k, label, min, max] of f.params) {
    const step = max - min <= 2 ? .01 : 1;
    body.append(h('div', { class: 'sl' }, h('span', {}, label), rangeCtl('', min, max, step, () => p[k], v => { p[k] = v; preview(); })));
  }
  if (!f.params.length) body.append(h('p', { class: 'mut' }, 'Pratinjau tampil di kanvas.'));
  if (l.type !== 'raster') body.append(h('p', { class: 'mut' }, 'Lapisan ' + (l.type === 'text' ? 'teks' : 'gambar') + ' akan dijadikan piksel saat diterapkan.'));
  preview();
  modal({
    title: f.name, body,
    onClose: () => { if (l._preview) { l._preview = null; S.dirty = true; } },
    buttons: [{ label: 'Batal' }, {
      label: 'Terapkan', primary: true, act: () => {
        l._preview = null;
        const out = compose(applyFilter(f.id, p, src));
        begin(f.name);
        if (l.type !== 'raster') rasterize(l);
        clearRegion(l, r);
        drawToLayer(l, out, r.x, r.y, { op: 'source-over', noSel: true });
        end(f.name);
        S.dirty = true; emit('stroke'); emit('layers');
      }
    }]
  });
}
function historyDialog() {
  const body = h('div', { class: 'menu', style: { maxHeight: '60vh', overflow: 'auto' } });
  const all = [...H.undo.map((e, i) => ({ e, i, done: true })), ...H.redo.slice().reverse().map((e, i) => ({ e, i, done: false }))];
  if (!all.length) body.append(h('p', { class: 'mut' }, 'Belum ada langkah.'));
  all.forEach((it, idx) => body.append(h('button', {
    style: { opacity: it.done ? 1 : .5 }, onclick: () => {
      const target = idx + 1; // number of undone-steps to keep
      while (H.undo.length > target) undo();
      while (H.undo.length < target && H.redo.length) redo();
      emit('layers'); emit('stroke'); m.close();
    }
  }, h('i', { class: 'ck' }, it.done ? '✓' : ''), h('span', {}, (idx + 1) + '. ' + it.e.label))));
  const m = modal({ title: 'Riwayat langkah', body, buttons: [{ label: 'Tutup' }] });
}
function settingsDialog() {
  const sw = (label, sub, key) => h('label', { class: 'switch' }, h('span', {}, label, h('small', {}, sub)), h('input', { type: 'checkbox', checked: !!S.prefs[key], onchange: e => { S.prefs[key] = e.target.checked; savePrefs(); S.ovDirty = true; } }));
  modal({
    title: 'Pengaturan', body: h('div', {},
      sw('Jari tetap bisa menggambar', 'Saat stylus/Apple Pencil terdeteksi, matikan agar jari hanya untuk geser & zoom', 'fingerDraw'),
      sw('Mouse terasa seperti pena', 'Garis menipis saat digerakkan cepat', 'simPressure'),
      sw('Bentuk cepat (QuickShape)', 'Tahan sebentar di akhir goresan → garis lurus / lingkaran rapi', 'quickShape'),
      sw('Kisi piksel saat zoom besar', 'Tampil di atas 1000%', 'pixelGrid'),
      h('div', { class: 'switch' }, h('span', {}, 'Kurva tekanan pena', h('small', {}, 'Kiri = ringan, kanan = perlu menekan lebih kuat')), h('input', { type: 'range', min: 30, max: 250, value: (S.prefs.pCurve || 1) * 100, style: { width: '140px', height: '20px' }, oninput: e => { S.prefs.pCurve = e.target.value / 100; savePrefs(); } })),
      h('div', { class: 'switch' }, h('span', {}, 'Tema'), segCtl([['dark', 'Gelap'], ['light', 'Terang']], () => S.prefs.theme, v => { S.prefs.theme = v; applyTheme(); savePrefs(); })),
      h('p', { class: 'mut' }, 'Gambar tersimpan otomatis di perangkat ini' + (window.AMATU ? ' dan tersinkron ke akun Portal AMATU.' : '.'))),
    buttons: [{ label: 'Selesai', primary: true }]
  });
}
function shortcutsDialog() {
  const rows = [['Kuas / Penghapus / Jari', 'B / E / S'], ['Ember / Gradien / Pipet', 'G / ⇧G / I'], ['Bentuk / Teks', 'U / T'], ['Seleksi kotak / laso / tongkat', 'M / L / W'],
    ['Pindah & ubah', 'V'], ['Geser tampilan', 'Spasi (tahan) / H'], ['Penggaris', 'R'], ['Ukuran kuas', '[ ]'], ['Opasitas 10–100%', '1 … 0'], ['Tukar / reset warna', 'X / D'],
    ['Pipet cepat', '⌥ + klik'], ['Urungkan / ulangi', '⌘Z / ⇧⌘Z'], ['Dua jari ketuk / tiga jari', 'urungkan / ulangi'], ['Salin / potong / tempel', '⌘C / ⌘X / ⌘V'], ['Pilih semua / batal', '⌘A / ⌘D'],
    ['Hapus isi seleksi', '⌫'], ['Duplikat lapisan', '⌘J'], ['Gabung ke bawah', '⌘E'], ['Ekspor', '⇧⌘E'], ['Simpan', '⌘S'], ['Zoom', '⌘+ / ⌘− / ⌘0 / ⌘1'], ['Mode fokus', 'Tab'], ['Terapkan / batal', '↵ / Esc'],
    ['Garis lurus dengan kuas', 'tahan di akhir goresan'], ['Sudut 15° / proporsional', '⇧']];
  modal({ title: 'Pintasan keyboard', body: h('div', { class: 'kbd-list' }, rows.flatMap(([a, b]) => [h('span', {}, a), h('kbd', {}, K(b))])), buttons: [{ label: 'Tutup', primary: true }] });
}
async function printDoc() {
  const c = renderExport({ area: 'page', scale: 1, bg: true, fmt: 'png' });
  const url = URL.createObjectURL(await toBlob(c));
  const d = S.doc, mmW = d.infinite ? null : d.w / d.dpi * 25.4, mmH = d.infinite ? null : d.h / d.dpi * 25.4;
  const f = h('iframe', { style: { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' } });
  document.body.append(f);
  f.srcdoc = `<html><head><style>@page{${mmW ? `size:${mmW}mm ${mmH}mm;` : ''}margin:0}html,body{margin:0}img{width:100%;display:block}</style></head><body><img src="${url}"></body></html>`;
  f.onload = () => { setTimeout(() => { f.contentWindow.print(); setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 2000); }, 200); };
}
async function quickExport(fmt) {
  try {
    toast('Menyiapkan ' + fmt.toUpperCase() + '…', 1500);
    const blob = await exportBlob({ fmt, area: 'page', scale: 1, bg: fmt !== 'png' || S.doc.bgOn, quality: .92 });
    download(blob, safeName(S.doc.name) + '.' + (fmt === 'sketch' ? 'sketch.json' : fmt));
  } catch (e) { toast('Gagal ekspor: ' + e.message); }
}
export function exportDialog() {
  commitPending();
  const st = { fmt: 'png', area: 'page', scale: 1, bg: S.doc.bgOn, q: .92 };
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    const r = exportArea(st.area);
    const layered = ['psd', 'sketch'].includes(st.fmt);
    body.append(
      h('div', { class: 'fl' }, h('span', {}, 'Format'), segCtl([['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WEBP'], ['pdf', 'PDF'], ['psd', 'PSD'], ['sketch', 'Proyek']], () => st.fmt, v => { st.fmt = v; draw(); })),
      h('p', { class: 'mut', style: { marginTop: '-4px' } }, {
        png: 'Kualitas terbaik, mendukung latar transparan.', jpg: 'Ukuran file kecil, cocok untuk dibagikan.', webp: 'Kecil & tajam, mendukung transparan.',
        pdf: 'Siap cetak sesuai ukuran kertas (' + S.doc.dpi + ' dpi).', psd: 'Buka di Photoshop / Amatu Photo dengan semua lapisan terpisah.', sketch: 'File proyek Sketch Paint — semua lapisan, teks & foto tetap bisa diedit.'
      }[st.fmt]),
      layered ? null : h('div', { class: 'fl' }, h('span', {}, 'Area'), segCtl([['page', S.doc.infinite ? 'Seluruh gambar' : 'Kertas'], ['content', 'Isi gambar saja'], ...(S.sel ? [['sel', 'Seleksi']] : [])], () => st.area, v => { st.area = v; draw(); })),
      layered || st.fmt === 'pdf' ? null : h('div', { class: 'fl' }, h('span', {}, 'Skala'), segCtl([[.5, '0.5×'], [1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], () => st.scale, v => { st.scale = v; draw(); })),
      ['png', 'webp'].includes(st.fmt) ? h('div', { class: 'fl' }, h('span', {}, 'Latar'), segCtl([[true, 'Sertakan latar kertas'], [false, 'Transparan']], () => st.bg, v => { st.bg = v; })) : null,
      ['jpg', 'webp'].includes(st.fmt) ? h('div', { class: 'fl' }, h('span', {}, 'Kualitas'), rangeCtl('', .3, 1, .01, () => st.q, v => st.q = v, { pct: true })) : null,
      r ? h('p', { class: 'mut' }, `Hasil: ${Math.round(r.w * (layered || st.fmt === 'pdf' ? 1 : st.scale))} × ${Math.round(r.h * (layered || st.fmt === 'pdf' ? 1 : st.scale))} px`) : null);
  };
  draw();
  const go = async (how) => {
    try {
      const blob = await exportBlob({ fmt: st.fmt, area: st.area, scale: st.scale, bg: st.bg, quality: st.q });
      const name = safeName(S.doc.name) + '.' + (st.fmt === 'sketch' ? 'sketch.json' : st.fmt);
      if (how === 'share' && navigator.canShare) {
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: S.doc.name }); return; }
      }
      if (how === 'copy') { await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); toast('Disalin ke papan klip'); return; }
      download(blob, name);
    } catch (e) { if (e.name !== 'AbortError') toast('Gagal: ' + e.message); return false; }
  };
  const btns = [{ label: 'Batal' }];
  if (navigator.canShare) btns.push({ label: 'Bagikan', act: () => go('share') });
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) btns.push({ label: 'Salin', act: () => st.fmt === 'png' ? go('copy') : (toast('Salin hanya untuk PNG'), false) });
  btns.push({ label: 'Unduh', primary: true, act: () => go('download') });
  modal({ title: 'Ekspor', body, buttons: btns });
}

// ---------------- reference window ----------------
let refImg = null;
export function refWindow(show) {
  const w = $('#refwin');
  if (!show) { w.hidden = true; return; }
  if (w.hidden && w.childElementCount) { w.hidden = false; drawRef(); return; }
  w.innerHTML = '';
  const head = h('header', {}, h('span', {}, 'Referensi'),
    h('button', { class: 'ib sm', title: 'Buka gambar', html: ic('image', 16), onclick: () => $('#fileRef').click() }),
    h('button', { class: 'ib sm', title: 'Pakai gambar kanvas sekarang', html: ic('ref', 16), onclick: () => { const r = rInt(workRect()); refImg = flatten(r, Math.min(1, 1200 / Math.max(r.w, r.h))); drawRef(); } }),
    h('button', { class: 'ib sm', title: 'Tutup', html: ic('close', 16), onclick: () => refWindow(false) }));
  const c = h('canvas');
  const body = h('div', { class: 'rb' }, c, h('div', { class: 'hint' }, 'Buka foto referensi untuk dilihat sambil menggambar. Klik gambar untuk mengambil warnanya.'));
  w.append(head, body);
  w.hidden = false;
  // drag window
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = w.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    head.onpointermove = ev => { w.style.left = clamp(ev.clientX - ox, 0, innerWidth - 80) + 'px'; w.style.top = clamp(ev.clientY - oy, 0, innerHeight - 40) + 'px'; w.style.right = 'auto'; };
    head.onpointerup = () => { head.onpointermove = null; };
  });
  c.addEventListener('pointerdown', e => {
    const pick = ev => {
      const b = c.getBoundingClientRect(), x = (ev.clientX - b.left) * c.width / b.width, y = (ev.clientY - b.top) * c.height / b.height;
      const d = cx2d(c, { willReadFrequently: true }).getImageData(x | 0, y | 0, 1, 1).data;
      if (d[3]) setColor(rgb2hex(d[0], d[1], d[2]));
    };
    c.setPointerCapture(e.pointerId); pick(e); c.onpointermove = pick; c.onpointerup = () => { c.onpointermove = null; pushRecent(S.color); };
  });
  new ResizeObserver(drawRef).observe(body);
  $('#fileRef').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const { loadImage } = await import('./store.js');
    refImg = await loadImage(f); drawRef();
  };
}
function drawRef() {
  const w = $('#refwin'), c = w.querySelector('canvas');
  if (!c) return;
  const b = c.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = Math.max(1, b.width * dpr); c.height = Math.max(1, b.height * dpr);
  const g = cx2d(c);
  g.clearRect(0, 0, c.width, c.height);
  w.querySelector('.hint').hidden = !!refImg;
  if (!refImg) return;
  const iw = refImg.naturalWidth || refImg.width, ih = refImg.naturalHeight || refImg.height, s = Math.min(c.width / iw, c.height / ih);
  g.drawImage(refImg, (c.width - iw * s) / 2, (c.height - ih * s) / 2, iw * s, ih * s);
}

// ---------------- keyboard ----------------
function keys(e) {
  if (!S.doc || $('#editor').hidden) return;
  if (isTyping(e)) return;
  if ($('#modal').childElementCount) { if (e.key === 'Escape') { const b = $('#modal .back'); b && b.remove(); } return; }
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  const go = f => { e.preventDefault(); f(); };
  if (mod) {
    if (k === 'z') return go(e.shiftKey ? doRedo : doUndo);
    if (k === 'y') return go(doRedo);
    if (k === 's') return go(async () => { await saveNow(); toast('Tersimpan'); });
    if (k === 'e') return go(e.shiftKey ? exportDialog : () => ops.mergeDown(activeLayer()));
    if (k === 'n') return go(e.shiftKey ? () => ops.addLayer() : newDocDialog);
    if (k === 'o') return go(() => $('#fileOpen').click());
    if (k === 'p') return go(printDoc);
    if (k === 'c') return go(() => ops.copySel(e.shiftKey));
    if (k === 'x') return go(() => ops.cutSel());
    if (k === 'v') return; // handled by the paste event
    if (k === 'a') return go(ops.selectAll);
    if (k === 'd') return go(ops.deselect);
    if (k === 'i' && e.shiftKey) return go(ops.invertSel);
    if (k === 'j') return go(() => S.sel ? ops.selToLayer(e.shiftKey) : ops.dupLayer());
    if (k === '0') return go(() => fitView());
    if (k === '1') return go(() => setZoom(1));
    if (k === '=' || k === '+') return go(() => setZoom(S.view.z * 1.25));
    if (k === '-') return go(() => setZoom(S.view.z / 1.25));
    if (k === "'") return go(() => { S.grid = !S.grid; S.ovDirty = true; });
    if (k === 'backspace') return go(() => ops.fillLayer(S.color2));
    return;
  }
  if (e.altKey && k === 'backspace') return go(() => ops.fillLayer(S.color));
  if (S.tool === 'move' && k.startsWith('arrow')) {
    const s = e.shiftKey ? 10 : 1;
    return go(() => nudge(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0));
  }
  const tmap = { b: 'brush', e: 'eraser', s: 'smudge', i: 'picker', u: 'shape', t: 'text', v: 'move', h: 'hand' };
  if (tmap[k]) return go(() => setTool(tmap[k]));
  if (k === 'g') return go(() => setTool(e.shiftKey ? 'gradient' : 'fill'));
  if (k === 'm' || k === 'l' || k === 'w') return go(() => {
    const o = S.tools.select;
    if (k === 'm') o.kind = S.tool === 'select' && o.kind === 'rect' ? 'ellipse' : 'rect'; else o.kind = k === 'l' ? 'lasso' : 'wand';
    setTool('select'); buildOpts(); buildToolbars();
  });
  if (k === 'r') return go(toggleRuler);
  if (k === 'x') return go(swapColors);
  if (k === 'd') return go(() => { S.color = '#1f1f24'; S.color2 = '#ffffff'; emit('color'); savePrefs(); });
  if (k === 'tab') return go(toggleFocus);
  if (k === '?') return go(shortcutsDialog);
  if (k === 'enter') return go(() => { if (S.float) commitFloat(); else if (S.shape) commitShape(); });
  if (k === 'escape') return go(() => { closePop(); cancelPending(); });
  if (k === 'backspace' || k === 'delete') return go(() => { if (S.shape) { S.shape = null; S.ovDirty = true; } else ops.deleteSel(); });
  if (k === '[' || k === ']') return go(() => {
    const o = S.tools[S.tool];
    if (!o || o.size == null) return;
    const f = k === ']' ? 1.15 : 1 / 1.15;
    o.size = clamp(Math.round(o.size * f * 10) / 10 + (k === ']' ? .5 : -.5), 1, 1000);
    if (S.cursor) S.cursor.r = o.size / 2;
    S.ovDirty = true; savePrefs(); syncQS(); $$('#opts .rng').forEach(x => x.sync && x.sync());
  });
  if (/^[0-9]$/.test(k)) return go(() => {
    const o = S.tools[S.tool];
    if (!o) return;
    const key = S.tool === 'smudge' ? 'strength' : 'opacity';
    if (o[key] == null) return;
    o[key] = k === '0' ? 1 : +k / 10;
    toast(Math.round(o[key] * 100) + '%', 700); savePrefs(); syncQS(); $$('#opts .rng').forEach(x => x.sync && x.sync());
  });
}

// ---------------- build ----------------
export function buildToolbars() {
  buildTools($('#tools'), false);
  buildTools($('#mbar'), true);
}
export function initUI() {
  $('#bGallery').innerHTML = ic('gallery', 20);
  $('#bUndo').innerHTML = ic('undo', 20); $('#bRedo').innerHTML = ic('redo', 20);
  $('#bMenuM').innerHTML = ic('menu', 20);
  $('#bExport').innerHTML = ic('share', 17) + '<span class="lbl">Ekspor</span>';
  $('#gNew').innerHTML = ic('plus', 17) + '<span class="lbl">Gambar baru</span>';
  $('#gOpen').innerHTML = ic('folder', 17) + '<span class="lbl">Buka file</span>';
  $('#bGallery').onclick = () => App.toGallery();
  $('#bUndo').onclick = doUndo; $('#bRedo').onclick = doRedo;
  $('#bExport').onclick = exportDialog;
  $('#gNew').onclick = () => newDocDialog();
  $('#gOpen').onclick = () => $('#fileOpen').click();
  $('#gTheme').onclick = toggleTheme;
  $('#docName').addEventListener('change', e => { if (S.doc) { S.doc.name = e.target.value.trim() || 'Tanpa judul'; emit('changed', {}); } });
  $('#docName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });
  $('#sideTabs').append(...[['color', 'Warna'], ['layers', 'Lapisan'], ['nav', 'Navigator']].map(([t, l]) => h('button', { 'data-t': t, onclick: () => openSheet(t) }, l)));
  // swipe the sheet down to close
  let sy = null;
  $('#side').addEventListener('pointerdown', e => { if (e.target.closest('.sheet-grip,.side-tabs')) sy = e.clientY; });
  $('#side').addEventListener('pointerup', e => { if (sy != null && e.clientY - sy > 40) $('#side').classList.remove('open'); sy = null; });
  $('#stage').addEventListener('pointerdown', () => { if (innerWidth <= 860) $('#side').classList.remove('open'); }, true);
  buildQS(); buildHud(); buildMenus(); buildColor(); buildLayers(); buildNav();
  buildToolbars(); buildOpts();
  window.addEventListener('keydown', keys);
  on('tool', () => { buildOpts(); buildToolbars(); });
  on('color', () => { $$('.colors .c1').forEach(b => b.style.background = S.color); $$('.colors .c2').forEach(b => b.style.background = S.color2); if (S.tool === 'shape') S.ovDirty = true; });
  on('layers', () => { renderLayerList(); navSoon(true); });
  on('stroke', () => { refreshThumbs(); navSoon(true); });
  on('changed', () => { updUndo(); });
  on('view', () => navSoon(false));
  on('sel', () => { if (S.tool === 'select') buildOpts(); });
  on('pen', () => toast('Stylus terdeteksi ✍️ — tekanan pena aktif'));
  on('save', s => { const e = $('#saveState'); e.textContent = s === 'saving' ? 'Menyimpan…' : s === 'saved' ? 'Tersimpan' : s === 'error' ? 'Gagal simpan' : 'Belum disimpan'; });
  setInterval(() => { if (S.doc) refreshThumbs(); }, 1500);
}
function updUndo() { $('#bUndo').disabled = !H.undo.length; $('#bRedo').disabled = !H.redo.length; }
export function onDocOpened() {
  $('#docName').value = S.doc.name;
  renderLayerList(); updUndo(); buildOpts(); navSoon(true);
  $('#saveState').textContent = 'Tersimpan';
}
