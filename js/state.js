// Shared state + small helpers. Every module imports S from here.
export const T = 512; // tile size (world px)

export const S = {
  doc: null,            // open drawing
  view: { x: 0, y: 0, z: 1, r: 0, flip: false },
  tool: 'brush',
  color: '#1f1f24', color2: '#ffffff',
  recent: [],
  tools: {
    brush: { preset: 'pensil', size: 4, opacity: 1, smooth: null, dash: 'solid', dashLen: 3, dashGap: 2 },
    eraser: { preset: 'kuas', size: 30, opacity: 1, smooth: null, dash: 'solid', dashLen: 3, dashGap: 2 },
    smudge: { size: 40, strength: 0.6 },
    fill: { tol: 24, ref: 'all', expand: 1, contig: true, opacity: 1 },
    gradient: { kind: 'linear', toTransparent: false, opacity: 1 },
    shape: { kind: 'rect', mode: 'stroke', width: 6, dash: 'solid', sides: 5, radius: 24, opacity: 1 },
    text: { font: 'Inter', size: 64, bold: false, italic: false, align: 'left', lh: 1.25, stroke: 0, strokeColor: '#ffffff' },
    select: { kind: 'rect', mode: 'new', tol: 24 },
    pick: { all: true }
  },
  sel: null,            // selection mask
  float: null,          // transform-in-progress
  stroke: null,         // active brush stroke
  shape: null,          // pending shape (editable until committed)
  ruler: { on: false, a: { x: 0, y: 0 }, b: { x: 400, y: 0 } },
  sym: { on: false, mode: 'v', n: 6, mirror: true, cx: 0, cy: 0 },
  grid: false, gridSize: 50,
  penSeen: false,
  dirty: true, ovDirty: true,
  prefs: { theme: 'dark', simPressure: false, pCurve: 1, fingerDraw: true, pixelGrid: true, quickShape: true }
};

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return c;
}
export const cx2d = (c, opts) => c.getContext('2d', opts);

export function hex2rgb(h) {
  h = String(h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, mx ? d / mx : 0, mx];
}
export function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

// rect helpers {x,y,w,h}
export const rUnion = (a, b) => !a ? b : !b ? a : (() => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
})();
export function rInter(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export const rPad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
export const rInt = r => { const x = Math.floor(r.x), y = Math.floor(r.y); return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y }; };
export const rHas = (r, p) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

// tiny event bus
const bus = new EventTarget();
export const on = (n, f) => bus.addEventListener(n, e => f(e.detail));
export const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));

export function toast(msg, ms = 2200) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('sketch.prefs') || 'null');
    if (!p) return;
    Object.assign(S.prefs, p.prefs || {});
    for (const k in p.tools || {}) Object.assign(S.tools[k] || (S.tools[k] = {}), p.tools[k]);
    if (p.color) S.color = p.color;
    if (p.color2) S.color2 = p.color2;
    if (Array.isArray(p.recent)) S.recent = p.recent.slice(0, 12);
    if (Array.isArray(p.palettes)) S.palettes = p.palettes;
    if (p.customBrushes) S.customBrushes = p.customBrushes;
  } catch (e) { }
}
let prefT;
export function savePrefs() {
  clearTimeout(prefT);
  prefT = setTimeout(() => {
    try {
      localStorage.setItem('sketch.prefs', JSON.stringify({
        prefs: S.prefs, tools: S.tools, color: S.color, color2: S.color2, recent: S.recent,
        palettes: S.palettes || [], customBrushes: S.customBrushes || []
      }));
    } catch (e) { }
  }, 400);
}
