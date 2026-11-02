// Boot, gallery and document lifecycle.
import { S, $, on, emit, toast, loadPrefs, mk, cx2d } from './state.js';
import { newDoc, newLayer, H, changed } from './doc.js';
import { initView, fitView, viewChanged } from './view.js';
import { initInput, commitPending, setTool } from './tools.js';
import { initUI, App, h, openMenu, confirmDlg, modal, quickTiles, onDocOpened, applyTheme, closePop } from './ui.js';
import { listMeta, loadDoc, saveNow, scheduleSave, flushSave, deleteDoc, renameDoc, duplicateDoc, openProjectFile, importPsd, loadImage, blit, download, safeName } from './store.js';
import { insertImageBlob } from './ops.js';
import { ic } from './icons.js';

loadPrefs();
applyTheme();

function showEditor(on) {
  $('#editor').hidden = !on;
  $('#gallery').hidden = on;
}
function openDocument(d) {
  S.doc = d;
  H.undo.length = 0; H.redo.length = 0; H.tx = null;
  S.sel = null; S.float = null; S.shape = null; S.stroke = null; S.textEdit = null;
  showEditor(true);
  requestAnimationFrame(() => {
    if (d.view && d.view.z) { Object.assign(S.view, d.view); viewChanged(); } else fitView();
    S.sym.cx = d.infinite ? 0 : d.w / 2; S.sym.cy = d.infinite ? 0 : d.h / 2;
  });
  try { history.replaceState(null, '', '#d=' + d.id); } catch (e) { }
  try { localStorage.setItem('sketch.last', d.id); } catch (e) { }
  onDocOpened();
  if (document.fonts) for (const l of d.layers) if (l.type === 'text') document.fonts.load(`${l.data.bold ? 700 : 400} 32px "${l.data.font}"`).then(() => { S.dirty = true; }).catch(() => { });
  emit('layers');
  S.dirty = S.ovDirty = true;
}
App.newDocument = function (o = {}) {
  commitPending();
  const d = newDoc({ ...o, name: o.name || 'Gambar ' + new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) });
  const l = newLayer('raster', 'Lapisan 1');
  d.layers.push(l); d.active = l.id;
  if (S.doc) flushSave();
  openDocument(d);
  if (!['brush', 'eraser'].includes(S.tool)) setTool('brush');
  saveNow();
  return d;
};
App.toGallery = async function () {
  commitPending();
  if (S.doc) { await flushSave(); await saveNow(); }
  S.doc = null;
  closePop();
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  try { localStorage.removeItem('sketch.last'); } catch (e) { }
  showEditor(false);
  renderGallery();
};
async function openById(id) {
  const d = await loadDoc(id);
  if (!d) { toast('Gambar tidak ditemukan'); renderGallery(); return; }
  openDocument(d);
}

// ---------------- gallery ----------------
const urls = [];
async function renderGallery() {
  quickTiles($('#gQuick'));
  const grid = $('#gGrid');
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  let metas = [];
  try { metas = await listMeta(); } catch (e) { console.error(e); }
  grid.innerHTML = '';
  if (!metas.length) {
    grid.append(h('div', { class: 'empty' }, h('b', {}, 'Belum ada gambar'), h('br'), 'Mulai dengan memilih ukuran kertas di atas — atau kanvas tak terbatas.'));
    return;
  }
  for (const m of metas) {
    const u = m.thumb ? URL.createObjectURL(m.thumb) : '';
    if (u) urls.push(u);
    const more = h('button', { class: 'ib sm', html: ic('more', 18), title: 'Lainnya', onclick: e => { e.stopPropagation(); cardMenu(e.currentTarget, m); } });
    const card = h('div', { class: 'card', onclick: () => openById(m.id), oncontextmenu: e => { e.preventDefault(); cardMenu(more, m); } },
      h('div', { class: 'th' }, u ? h('img', { src: u, alt: '' }) : null),
      h('div', { class: 'meta' }, h('div', {}, h('b', {}, m.name), h('small', {}, (m.infinite ? 'Tak terbatas' : `${m.w}×${m.h}`) + ' · ' + new Date(m.updated).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }))), more));
    grid.append(card);
  }
}
function cardMenu(anchor, m) {
  openMenu(anchor, [
    { label: 'Buka', act: () => openById(m.id) },
    {
      label: 'Ganti nama', act: () => {
        const inp = h('input', { class: 'inp', value: m.name, style: { width: '100%' } });
        modal({ title: 'Ganti nama', body: inp, buttons: [{ label: 'Batal' }, { label: 'Simpan', primary: true, act: async () => { await renameDoc(m.id, inp.value.trim() || m.name); renderGallery(); } }] });
        setTimeout(() => inp.select(), 50);
      }
    },
    { label: 'Duplikat', act: async () => { await duplicateDoc(m.id); renderGallery(); } },
    { label: 'Unduh PNG', act: () => m.thumb && openById(m.id).then(() => import('./ui.js').then(u => u.exportDialog())) },
    { sep: true },
    { label: 'Hapus', act: () => confirmDlg('Hapus gambar?', `"${m.name}" akan dihapus dari perangkat ini. Tindakan ini tidak bisa dibatalkan.`, 'Hapus', async () => { await deleteDoc(m.id); renderGallery(); }) }
  ]);
}

// ---------------- files ----------------
async function newDocFromImage(file) {
  const img = await loadImage(file);
  const w = img.naturalWidth, hh = img.naturalHeight;
  const s = Math.min(1, 6000 / Math.max(w, hh));
  const d = App.newDocument({ w: Math.round(w * s), h: Math.round(hh * s), name: file.name.replace(/\.[^.]+$/, '') || 'Foto', bgOn: true });
  const c = mk(d.w, d.h); cx2d(c).drawImage(img, 0, 0, d.w, d.h);
  const l = d.layers[0]; l.name = 'Foto';
  blit(l, c, 0, 0);
  const top = newLayer('raster', 'Lapisan 2');
  d.layers.push(top); d.active = top.id;
  emit('layers'); S.dirty = true; saveNow();
}
async function openAny(file) {
  try {
    const n = file.name.toLowerCase();
    if (n.endsWith('.json') || n.endsWith('.sketch')) { const d = await openProjectFile(file); openDocument(d); saveNow(); return; }
    if (n.endsWith('.psd')) { toast('Membaca PSD…'); const d = await importPsd(file); openDocument(d); saveNow(); return; }
    if (file.type.startsWith('image/')) {
      if (S.doc && !App.importNext) await insertImageBlob(file, file.name.replace(/\.[^.]+$/, ''));
      else await newDocFromImage(file);
      return;
    }
    toast('Jenis file tidak didukung');
  } catch (e) { console.error(e); toast('Gagal membuka: ' + e.message); }
  finally { App.importNext = false; }
}
App.openFile = openAny;

function wireFiles() {
  $('#fileImg').addEventListener('change', async e => {
    const fs = [...e.target.files]; e.target.value = '';
    for (const f of fs) { if (S.doc) await insertImageBlob(f, f.name.replace(/\.[^.]+$/, '')); else await newDocFromImage(f); }
  });
  $('#fileCam').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { if (S.doc) await insertImageBlob(f, 'Foto kamera'); else await newDocFromImage(f); } });
  $('#fileOpen').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openAny(f); else App.importNext = false; });
  // drag & drop
  window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) await openAny(f);
  });
  // paste images from the system clipboard
  window.addEventListener('paste', async e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const items = [...(e.clipboardData ? e.clipboardData.items : [])];
    const img = items.find(i => i.type.startsWith('image/'));
    e.preventDefault();
    if (img) {
      const f = img.getAsFile();
      if (!S.doc) { await newDocFromImage(f); return; }
      // our own copy round-trips through the OS clipboard: paste in place instead
      if (S.clip && S.clipStamp && Date.now() - S.clipStamp < 600000 && Math.abs(f.size - (S.clipSize || -1)) < 1) { const ops = await import('./ops.js'); ops.pasteCanvas(S.clip.c, S.clip.x, S.clip.y); return; }
      if (S.clip && S.clipStamp && Date.now() - S.clipStamp < 600000) { const ops = await import('./ops.js'); ops.pasteCanvas(S.clip.c, S.clip.x, S.clip.y); return; }
      await insertImageBlob(f, 'Tempelan', true);
    } else if (S.doc && S.clip) { const ops = await import('./ops.js'); ops.pasteCanvas(S.clip.c, S.clip.x, S.clip.y); }
  });
}

// ---------------- boot ----------------
initView();
initInput();
initUI();
wireFiles();
on('changed', d => { if (S.doc && !(d && d.noSave)) scheduleSave(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.doc) { commitPendingSafe(); flushSave(); saveNow(); } });
window.addEventListener('pagehide', () => { if (S.doc) saveNow(); });
function commitPendingSafe() { try { if (!S.stroke) commitPending(); } catch (e) { } }
if (document.fonts) document.fonts.addEventListener('loadingdone', () => { S.dirty = true; });
window.SKETCH = { S, App, H };

(async () => {
  const m = location.hash.match(/#d=([\w-]+)/);
  const last = m ? m[1] : null;
  if (last) { const d = await loadDoc(last).catch(() => null); if (d) { openDocument(d); return; } }
  showEditor(false);
  renderGallery();
})();
