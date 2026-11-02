// Brush engine: stamp-based strokes into a tiled buffer, committed to the layer at stroke end.
import { S, T, mk, cx2d, clamp } from './state.js';
import { key, unkey, tileW, begin, end, drawToLayer, paperRect } from './doc.js';
import { symTransforms } from './view.js';

const D = Math.PI / 180;
// tip: round | pencil | charcoal | crayon | bristle | dry | spray | water | pixel
export const PRESETS = [
  { id: 'pensil', name: 'Pensil HB', cat: 'Sketsa', tip: 'pencil', size: 4, max: 40, opacity: .9, flow: .55, hard: .7, spacing: .12, pSize: .45, pOp: .9, jAngle: 1, smooth: .25 },
  { id: 'pensil6b', name: 'Pensil 6B', cat: 'Sketsa', tip: 'pencil', size: 9, max: 60, opacity: 1, flow: .75, hard: .6, spacing: .1, pSize: .5, pOp: .8, jAngle: 1, smooth: .2 },
  { id: 'arang', name: 'Arang', cat: 'Sketsa', tip: 'charcoal', size: 22, max: 160, opacity: 1, flow: .55, hard: .5, spacing: .12, pSize: .5, pOp: .7, jAngle: 1, smooth: .15 },
  { id: 'krayon', name: 'Krayon', cat: 'Sketsa', tip: 'crayon', size: 16, max: 120, opacity: 1, flow: .85, hard: .8, spacing: .14, pSize: .3, pOp: .6, jAngle: 1, smooth: .2 },
  { id: 'bolpoin', name: 'Bolpoin', cat: 'Tinta', tip: 'round', size: 3, max: 30, opacity: 1, flow: 1, hard: .92, spacing: .06, pSize: .55, pOp: .25, smooth: .5 },
  { id: 'fineliner', name: 'Fineliner', cat: 'Tinta', tip: 'round', size: 4, max: 40, opacity: 1, flow: 1, hard: .95, spacing: .05, pSize: 0, pOp: 0, smooth: .55 },
  { id: 'gpen', name: 'Pena Tinta (G-pen)', cat: 'Tinta', tip: 'round', size: 9, max: 80, opacity: 1, flow: 1, hard: .95, spacing: .05, pSize: .95, pOp: 0, taper: .6, smooth: .5 },
  { id: 'kaligrafi', name: 'Kaligrafi', cat: 'Tinta', tip: 'round', size: 18, max: 120, opacity: 1, flow: 1, hard: .95, spacing: .04, pSize: .45, pOp: 0, round: .22, angle: 40, smooth: .45 },
  { id: 'spidol', name: 'Spidol', cat: 'Tinta', tip: 'round', size: 14, max: 80, opacity: .9, flow: 1, hard: .9, spacing: .06, pSize: 0, pOp: 0, smooth: .35 },
  { id: 'stabilo', name: 'Stabilo', cat: 'Tinta', tip: 'round', size: 26, max: 120, opacity: .45, flow: 1, hard: .95, spacing: .05, pSize: 0, pOp: 0, round: .32, angle: 70, blend: 'multiply', smooth: .5 },
  { id: 'kuas', name: 'Kuas Bulat', cat: 'Lukis', tip: 'round', size: 24, max: 300, opacity: 1, flow: .9, hard: .75, spacing: .08, pSize: .75, pOp: .3, smooth: .2 },
  { id: 'lembut', name: 'Kuas Lembut', cat: 'Lukis', tip: 'round', size: 70, max: 600, opacity: 1, flow: .22, hard: 0, spacing: .08, pSize: .3, pOp: .7, smooth: .15 },
  { id: 'airbrush', name: 'Airbrush', cat: 'Lukis', tip: 'round', size: 140, max: 800, opacity: 1, flow: .06, hard: 0, spacing: .05, pSize: 0, pOp: .9, smooth: .1 },
  { id: 'catair', name: 'Cat Air', cat: 'Lukis', tip: 'water', size: 46, max: 300, opacity: .75, flow: .3, hard: .3, spacing: .07, pSize: .5, pOp: .4, jSize: .15, jAngle: 1, smooth: .2 },
  { id: 'catminyak', name: 'Cat Minyak', cat: 'Lukis', tip: 'bristle', size: 34, max: 240, opacity: 1, flow: .9, hard: .8, spacing: .06, pSize: .5, pOp: .3, follow: true, smooth: .25 },
  { id: 'kering', name: 'Kuas Kering', cat: 'Lukis', tip: 'dry', size: 40, max: 300, opacity: 1, flow: .75, hard: .8, spacing: .05, pSize: .3, pOp: .5, follow: true, smooth: .2 },
  { id: 'semprot', name: 'Cat Semprot', cat: 'Lukis', tip: 'spray', size: 70, max: 400, opacity: 1, flow: .7, hard: .5, spacing: .25, pSize: .3, pOp: .6, jAngle: 1, smooth: .05 },
  { id: 'piksel', name: 'Piksel', cat: 'Lainnya', tip: 'pixel', size: 1, max: 64, opacity: 1, flow: 1, hard: 1, spacing: .3, pSize: 0, pOp: 0, smooth: 0 },
  { id: 'bintik', name: 'Stipple', cat: 'Lainnya', tip: 'round', size: 5, max: 40, opacity: 1, flow: 1, hard: .9, spacing: 1.6, pSize: .4, pOp: 0, jScatter: 3, jSize: .5, smooth: 0 },
  { id: 'neon', name: 'Neon', cat: 'Lainnya', tip: 'round', size: 14, max: 120, opacity: 1, flow: 1, hard: .95, spacing: .05, pSize: .2, pOp: 0, glow: true, smooth: .45 }
];
export const CATS = ['Sketsa', 'Tinta', 'Lukis', 'Lainnya', 'Kustom'];
export function presetById(id) {
  return PRESETS.find(p => p.id === id) || (S.customBrushes || []).find(p => p.id === id) || PRESETS[0];
}

// ---------------- tips ----------------
const R = 128;
const shapeCache = new Map(), colorCache = new Map();
const VARIANTS = { pencil: 6, charcoal: 6, crayon: 6, bristle: 4, dry: 6, spray: 8, water: 4 };

function noise(c, f) {
  const g = cx2d(c, { willReadFrequently: true }), im = g.getImageData(0, 0, R, R), d = im.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) d[i] = clamp(d[i] * f(), 0, 255);
  g.putImageData(im, 0, 0);
}
function softDisc(g, r, hard, cx = R / 2, cy = R / 2, a = 1) {
  if (hard >= .97) { g.globalAlpha = a; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.globalAlpha = 1; return; }
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  const h = clamp(hard, 0, .97);
  gr.addColorStop(0, `rgba(255,255,255,${a})`);
  if (h > 0) gr.addColorStop(h, `rgba(255,255,255,${a})`);
  for (let i = 1; i <= 8; i++) { const t = i / 8; gr.addColorStop(h + (1 - h) * t, `rgba(255,255,255,${a * 0.5 * (1 + Math.cos(Math.PI * t))})`); }
  g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2);
  g.fillStyle = '#fff';
}
function makeShape(tip, hard) {
  const c = mk(R, R), g = cx2d(c, { willReadFrequently: true }), r = R / 2;
  g.fillStyle = '#fff';
  const rnd = Math.random;
  switch (tip) {
    case 'pencil':
      softDisc(g, r - 2, hard);
      noise(c, () => rnd() < .3 ? rnd() * .35 : .55 + rnd() * .45);
      break;
    case 'charcoal':
      for (let i = 0; i < 9; i++) {
        g.save(); g.translate(r + (rnd() - .5) * r * .5, r + (rnd() - .5) * r * .5); g.rotate(rnd() * 7); g.scale(1, .4 + rnd() * .6);
        g.globalAlpha = .35 + rnd() * .4; g.beginPath(); g.arc(0, 0, r * (.45 + rnd() * .4), 0, 7); g.fill(); g.restore();
      }
      noise(c, () => rnd() < .45 ? rnd() * .25 : .6 + rnd() * .4);
      break;
    case 'crayon':
      softDisc(g, r - 3, .85);
      noise(c, () => rnd() < .42 ? 0 : .65 + rnd() * .35);
      break;
    case 'bristle':
      for (let i = 0; i < 46; i++) {
        const a = rnd() * 7, d = Math.sqrt(rnd()) * r * .85;
        g.globalAlpha = .35 + rnd() * .6;
        g.beginPath(); g.ellipse(r + Math.cos(a) * d * .35, r + Math.sin(a) * d, R * (.025 + rnd() * .04), R * (.025 + rnd() * .04), 0, 0, 7); g.fill();
      }
      break;
    case 'dry':
      for (let i = 0; i < 22; i++) {
        const y = R * .1 + rnd() * R * .8;
        g.globalAlpha = .3 + rnd() * .7;
        g.beginPath(); g.ellipse(r, y, R * .05, R * (.01 + rnd() * .025), 0, 0, 7); g.fill();
      }
      break;
    case 'spray':
      for (let i = 0; i < 260; i++) {
        const a = rnd() * 7, d = Math.pow(rnd(), .7) * (r - 2);
        g.globalAlpha = .4 + rnd() * .6;
        g.beginPath(); g.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, .7 + rnd() * 1.3, 0, 7); g.fill();
      }
      break;
    case 'water': {
      const gr = g.createRadialGradient(r, r, 0, r, r, r - 1);
      gr.addColorStop(0, 'rgba(255,255,255,.28)'); gr.addColorStop(.72, 'rgba(255,255,255,.42)');
      gr.addColorStop(.9, 'rgba(255,255,255,.62)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath();
      for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, rr = (r - 2) * (.82 + rnd() * .18); i ? g.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr) : g.moveTo(r + rr, r); }
      g.fill();
      noise(c, () => .8 + rnd() * .2);
      break;
    }
    default:
      softDisc(g, r - (hard >= .97 ? .5 : 0), hard);
  }
  return c;
}
export function tipsFor(p, hard, color) {
  const n = VARIANTS[p.tip] || 1, hk = Math.round(hard * 20) / 20;
  const sk = p.tip + '|' + hk;
  let shapes = shapeCache.get(sk);
  if (!shapes) { shapes = []; for (let i = 0; i < n; i++) shapes.push(makeShape(p.tip, hk)); shapeCache.set(sk, shapes); }
  const ck = sk + '|' + color;
  let cols = colorCache.get(ck);
  if (!cols) {
    cols = shapes.map(s => {
      const c = mk(R, R), g = cx2d(c);
      g.drawImage(s, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, R, R);
      return c;
    });
    if (colorCache.size > 60) colorCache.delete(colorCache.keys().next().value);
    colorCache.set(ck, cols);
  }
  return cols;
}

// ---------------- strokes ----------------
const pc = p => Math.pow(clamp(p, 0, 1), S.prefs.pCurve || 1);

// o: {layer, preset, size, opacity, color, erase, dash, dashLen, dashGap, smooth, buf}
export function makeStroke(o) {
  const p = o.preset;
  const hard = o.hard != null ? o.hard : p.hard;
  const st = {
    layer: o.layer, p, size: o.size, color: o.color, hard,
    buf: o.buf || new Map(),
    alpha: o.opacity * (p.opacity == null ? 1 : p.opacity),
    op: o.erase ? 'destination-out' : (o.layer && o.layer.alphaLock ? 'source-atop' : (p.blend || 'source-over')),
    tips: p.tip === 'pixel' ? null : tipsFor(p, hard, o.erase ? '#000' : o.color),
    glow: p.glow && !o.erase ? tipsFor({ tip: 'round' }, 0, o.color) : null,
    smooth: o.smooth != null ? o.smooth : (p.smooth || 0),
    dash: o.dash || 'solid', dashLen: o.dashLen || 3, dashGap: o.dashGap || 2,
    sym: o.noSym ? [] : (S.sym.on ? symTransforms() : []),
    rem: 0, along: 0, pts: [], sm: null, last: null, dir: 0
  };
  return st;
}
function bufTile(st, tx, ty) {
  const k = key(tx, ty);
  let t = st.buf.get(k);
  if (!t) { t = mk(T, T); t._g = cx2d(t); st.buf.set(k, t); }
  return t;
}
function drawStamp(st, x, y, size, alpha, ang, tip, round) {
  if (st.p.tip === 'pixel') {
    const s = Math.max(1, Math.round(size)), x0 = Math.floor(x - s / 2 + .5), y0 = Math.floor(y - s / 2 + .5);
    for (const [tx, ty] of tilesFor(x0, y0, s, s)) {
      const g = bufTile(st, tx, ty)._g;
      g.globalAlpha = 1; g.fillStyle = st.color; g.fillRect(x0 - tx * T, y0 - ty * T, s, s);
    }
    return;
  }
  if (size < 1) { alpha *= size; size = 1; }
  const r = size / 2;
  for (const [tx, ty] of tilesFor(x - r, y - r, size, size)) {
    const g = bufTile(st, tx, ty)._g;
    g.globalAlpha = clamp(alpha, 0, 1);
    if (ang || round !== 1) {
      g.setTransform(1, 0, 0, 1, x - tx * T, y - ty * T); g.rotate(ang); if (round !== 1) g.scale(1, round);
      g.drawImage(tip, -r, -r, size, size);
      g.setTransform(1, 0, 0, 1, 0, 0);
    } else g.drawImage(tip, x - r - tx * T, y - r - ty * T, size, size);
  }
}
function tilesFor(x, y, w, h) {
  const out = [], x0 = Math.floor(x / T), y0 = Math.floor(y / T), x1 = Math.floor((x + w) / T), y1 = Math.floor((y + h) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}
function diam(st, pr) {
  const p = st.p;
  let s = st.size * (1 - (p.pSize || 0) + (p.pSize || 0) * pc(pr));
  if (p.taper) s *= clamp(0.12 + st.along / (st.size * p.taper * 10 + 1), 0.12, 1);
  return Math.max(0.3, s);
}
function stampAt(st, x, y, pr) {
  const p = st.p;
  // dashed / dotted line patterns
  if (st.dash !== 'solid') {
    const u = Math.max(st.size, 2);
    const L = st.dash === 'dot' ? 0.01 : st.dashLen * u, G = (st.dash === 'dot' ? Math.max(1.6, st.dashGap) : st.dashGap) * u;
    const m = st.along % (L + G);
    if (st.dash === 'dot') { const per = Math.floor(st.along / (L + G)); if (per === st._lastDot) return; st._lastDot = per; }
    else if (m > L) return;
  }
  let size = diam(st, pr);
  if (p.jSize) size *= 1 + (Math.random() - .5) * 2 * p.jSize;
  const alpha = (p.flow == null ? 1 : p.flow) * (1 - (p.pOp || 0) + (p.pOp || 0) * pc(pr));
  let ang = (p.angle || 0) * D + (p.follow ? st.dir + Math.PI / 2 : 0) + (p.jAngle ? (Math.random() - .5) * 2 * Math.PI * p.jAngle : 0);
  if (p.jScatter) { x += (Math.random() - .5) * size * p.jScatter; y += (Math.random() - .5) * size * p.jScatter; }
  const tips = st.tips, vi = tips ? (Math.random() * tips.length) | 0 : 0, tip = tips && tips[vi];
  const round = p.round || 1;
  const put = (x, y, a) => {
    if (st.glow) drawStamp(st, x, y, size * 3.2, alpha * .05, 0, st.glow[0], 1);
    drawStamp(st, x, y, size, alpha, a, tip, round);
  };
  put(x, y, ang);
  for (const f of st.sym) { const q = f({ x, y, a: ang }); put(q.x, q.y, q.a); }
}
function seg(st, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (L < 1e-4) return;
  st.dir = Math.atan2(dy, dx);
  const base = st.along;
  let s = st.rem;
  while (s <= L) {
    const f = s / L, pr = a.p + (b.p - a.p) * f;
    st.along = base + s;
    stampAt(st, a.x + dx * f, a.y + dy * f, pr);
    s += Math.max(st.p.tip === 'pixel' ? .5 : 0.35, diam(st, pr) * (st.p.spacing || .1));
  }
  st.along = base + L;
  st.rem = s - L;
}
export function strokePoint(st, pt) {
  st.pts.push(pt);
  if (!st.sm) { st.sm = { ...pt }; st.last = { ...pt }; stampAt(st, pt.x, pt.y, pt.p); st.rem = Math.max(.35, diam(st, pt.p) * (st.p.spacing || .1)); return; }
  const k = 1 - clamp(st.smooth, 0, .95) * .92;
  const sm = st.sm;
  sm.x += (pt.x - sm.x) * k; sm.y += (pt.y - sm.y) * k; sm.p += (pt.p - sm.p) * Math.min(1, k * 1.5);
  seg(st, st.last, sm); st.last = { ...sm };
}
export function strokeFinish(st) {
  const lp = st.pts[st.pts.length - 1];
  if (lp && st.last && st.smooth > 0) seg(st, st.last, { ...lp, p: st.last.p });
}
// redraw the stroke as a clean straight line / ellipse (QuickShape)
export function strokeRebuild(st, pts) {
  st.buf.clear(); st.rem = 0; st.along = 0; st._lastDot = undefined;
  const pr = st.pts.reduce((a, p) => a + p.p, 0) / Math.max(1, st.pts.length);
  stampAt(st, pts[0].x, pts[0].y, pr);
  st.rem = Math.max(.35, diam(st, pr) * (st.p.spacing || .1));
  for (let i = 1; i < pts.length; i++) seg(st, { ...pts[i - 1], p: pr }, { ...pts[i], p: pr });
}
export function strokeCommit(st, label) {
  begin(label);
  for (const [k, t] of st.buf) {
    const [tx, ty] = unkey(k);
    drawToLayer(st.layer, t, tx * T, ty * T, { op: st.op, alpha: st.alpha });
  }
  end(label);
}
// render a sample stroke into a small canvas (brush library previews)
export function previewStroke(c, preset, color, size) {
  const g = cx2d(c);
  g.clearRect(0, 0, c.width, c.height);
  const st = makeStroke({ preset, size: size || clamp(preset.size, 2, c.height * .32), opacity: 1, color, noSym: true, smooth: 0 });
  st.op = 'source-over';
  const w = c.width, h = c.height, n = 40;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    strokePoint(st, { x: 10 + t * (w - 20), y: h / 2 + Math.sin(t * Math.PI * 2) * h * .22, p: Math.sin(t * Math.PI) * .9 + .1 });
  }
  g.globalAlpha = st.alpha;
  g.globalCompositeOperation = preset.blend === 'multiply' ? 'source-over' : 'source-over';
  for (const [k, t] of st.buf) { const [tx, ty] = unkey(k); g.drawImage(t, tx * T, ty * T); }
  g.globalAlpha = 1;
}

// ---------------- smudge ----------------
let smMask = null, smMaskSize = 0;
export function smudgeStart(layer, pt, size, strength) {
  begin('Jari');
  return { layer, size, strength, last: { ...pt }, sm: { ...pt }, rem: 0 };
}
function regionFromLayer(layer, x, y, s) {
  const c = mk(s, s), g = cx2d(c);
  for (const [tx, ty] of tilesFor(x, y, s, s)) {
    const t = layer.tiles.get(key(tx, ty));
    if (t) g.drawImage(t, tx * T - x, ty * T - y);
  }
  return c;
}
function smudgeDab(st, from, to, pr) {
  const s = Math.max(4, Math.round(st.size)), r = s / 2;
  if (!smMask || smMaskSize !== s) {
    smMask = mk(s, s); smMaskSize = s;
    const g = cx2d(smMask), gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(.45, 'rgba(0,0,0,.85)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }
  const fx = Math.round(from.x - r), fy = Math.round(from.y - r), x = Math.round(to.x - r), y = Math.round(to.y - r);
  const patch = regionFromLayer(st.layer, fx, fy, s), pg = cx2d(patch);
  pg.globalCompositeOperation = 'destination-in'; pg.drawImage(smMask, 0, 0);
  const a = clamp(st.strength * (0.35 + 0.65 * pr), 0, 1);
  const paper = paperRect();
  for (const [tx, ty] of tilesFor(x, y, s, s)) {
    const t = tileW(st.layer, tx, ty), g = cx2d(t);
    g.save();
    if (paper) { g.beginPath(); g.rect(paper.x - tx * T, paper.y - ty * T, paper.w, paper.h); g.clip(); }
    if (st.layer.alphaLock) {
      g.globalCompositeOperation = 'source-atop'; g.globalAlpha = a; g.drawImage(patch, x - tx * T, y - ty * T);
    } else {
      g.globalAlpha = a; g.globalCompositeOperation = 'destination-out'; g.drawImage(smMask, x - tx * T, y - ty * T);
      g.globalCompositeOperation = 'lighter'; g.drawImage(patch, x - tx * T, y - ty * T);
    }
    g.restore();
  }
}
export function smudgeMove(st, pt) {
  const k = 0.55;
  st.sm.x += (pt.x - st.sm.x) * k; st.sm.y += (pt.y - st.sm.y) * k;
  const step = Math.max(1, st.size * .12);
  let L = Math.hypot(st.sm.x - st.last.x, st.sm.y - st.last.y);
  while (L >= step) {
    const f = step / L, q = { x: st.last.x + (st.sm.x - st.last.x) * f, y: st.last.y + (st.sm.y - st.last.y) * f };
    smudgeDab(st, st.last, q, pt.p);
    st.last = q;
    L = Math.hypot(st.sm.x - st.last.x, st.sm.y - st.last.y);
  }
}
export function smudgeEnd() { end('Jari'); }
