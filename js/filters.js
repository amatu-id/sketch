// Adjustments & filters (pixel ops on a canvas region).
import { mk, cx2d, clamp } from './state.js';

let canFilter = null;
function ctxFilterOK() {
  if (canFilter != null) return canFilter;
  try {
    const c = mk(8, 8), g = cx2d(c, { willReadFrequently: true });
    g.filter = 'blur(2px)'; g.fillStyle = '#000'; g.fillRect(3, 3, 2, 2);
    canFilter = g.getImageData(0, 0, 1, 1).data[3] > 0 || g.getImageData(1, 1, 1, 1).data[3] > 0;
  } catch (e) { canFilter = false; }
  return canFilter;
}
export function blurCanvas(src, r) {
  const c = mk(src.width, src.height), g = cx2d(c);
  if (r <= 0) { g.drawImage(src, 0, 0); return c; }
  if (ctxFilterOK()) { g.filter = `blur(${r}px)`; g.drawImage(src, 0, 0); g.filter = 'none'; return c; }
  // fallback: repeated down/up sampling
  let cur = src;
  const steps = Math.max(1, Math.round(Math.log2(r + 1)));
  for (let i = 0; i < steps; i++) {
    const s = mk(Math.max(1, cur.width / 2), Math.max(1, cur.height / 2));
    cx2d(s).drawImage(cur, 0, 0, s.width, s.height); cur = s;
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, c.width, c.height);
  return c;
}
function pix(src, f) {
  const c = mk(src.width, src.height), g = cx2d(c, { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const im = g.getImageData(0, 0, c.width, c.height);
  f(im.data, c.width, c.height);
  g.putImageData(im, 0, 0);
  return c;
}
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h, s, l];
}
function hsl2rgb(h, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export const FILTERS = [
  { id: 'bc', name: 'Kecerahan & Kontras', params: [['b', 'Kecerahan', -100, 100, 0], ['c', 'Kontras', -100, 100, 0]] },
  { id: 'hsl', name: 'Hue / Saturasi', params: [['h', 'Hue', -180, 180, 0], ['s', 'Saturasi', -100, 100, 0], ['l', 'Terang', -100, 100, 0]] },
  { id: 'temp', name: 'Suhu & Tint', params: [['t', 'Suhu', -100, 100, 0], ['g', 'Tint', -100, 100, 0]] },
  { id: 'curves', name: 'Level', params: [['lo', 'Hitam', 0, 254, 0], ['mid', 'Gamma', 10, 300, 100], ['hi', 'Putih', 1, 255, 255]] },
  { id: 'blur', name: 'Blur Gaussian', params: [['r', 'Radius', 0, 60, 6]], pad: 'r' },
  { id: 'sharp', name: 'Tajamkan', params: [['a', 'Kekuatan', 0, 300, 80], ['r', 'Radius', 1, 8, 2]] },
  { id: 'noise', name: 'Grain / Noise', params: [['a', 'Jumlah', 0, 100, 20], ['m', 'Monokrom', 0, 1, 1]] },
  { id: 'pixel', name: 'Pikselasi', params: [['s', 'Ukuran', 2, 80, 12]] },
  { id: 'post', name: 'Posterisasi', params: [['n', 'Level', 2, 16, 5]] },
  { id: 'thresh', name: 'Ambang Hitam-Putih', params: [['t', 'Ambang', 1, 254, 128]] },
  { id: 'sketch', name: 'Foto → Sketsa Pensil', params: [['r', 'Detail', 1, 40, 10], ['k', 'Gelap', 0, 100, 40]] },
  { id: 'outline', name: 'Garis Tepi (line art)', params: [['t', 'Kepekaan', 1, 100, 35]] },
  { id: 'gray', name: 'Hitam Putih', params: [] },
  { id: 'sepia', name: 'Sepia', params: [['a', 'Kekuatan', 0, 100, 100]] },
  { id: 'invert', name: 'Balik Warna (negatif)', params: [] },
  { id: 'vignette', name: 'Vinyet', params: [['a', 'Kekuatan', 0, 100, 50], ['s', 'Lembut', 10, 100, 60]] }
];

export function applyFilter(id, p, src) {
  switch (id) {
    case 'bc': {
      const b = p.b * 2.55, c = p.c * 2.55, f = (259 * (c + 255)) / (255 * (259 - c));
      return pix(src, d => { for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = f * (d[i + k] - 128) + 128 + b; });
    }
    case 'hsl': return pix(src, d => {
      const dh = p.h / 360, ds = p.s / 100, dl = p.l / 100;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
        h = (h + dh + 1) % 1; s = clamp(ds > 0 ? s + (1 - s) * ds : s * (1 + ds), 0, 1); l = clamp(dl > 0 ? l + (1 - l) * dl : l * (1 + dl), 0, 1);
        const o = hsl2rgb(h, s, l); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
      }
    });
    case 'temp': return pix(src, d => { for (let i = 0; i < d.length; i += 4) { d[i] += p.t * .5; d[i + 2] -= p.t * .5; d[i + 1] += p.g * .4; } });
    case 'curves': return pix(src, d => {
      const lut = new Uint8Array(256), g = 100 / p.mid, lo = p.lo, hi = Math.max(lo + 1, p.hi);
      for (let v = 0; v < 256; v++) lut[v] = clamp(Math.pow(clamp((v - lo) / (hi - lo), 0, 1), g) * 255, 0, 255);
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    });
    case 'blur': return blurCanvas(src, p.r);
    case 'sharp': {
      const bl = cx2d(blurCanvas(src, p.r), { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data, a = p.a / 100;
      return pix(src, d => { for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = d[i + k] + (d[i + k] - bl[i + k]) * a; });
    }
    case 'noise': return pix(src, d => {
      const a = p.a * 1.6;
      for (let i = 0; i < d.length; i += 4) {
        if (p.m >= .5) { const n = (Math.random() - .5) * a; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        else { d[i] += (Math.random() - .5) * a; d[i + 1] += (Math.random() - .5) * a; d[i + 2] += (Math.random() - .5) * a; }
      }
    });
    case 'pixel': {
      const s = Math.max(2, p.s | 0), w = Math.max(1, Math.ceil(src.width / s)), h = Math.max(1, Math.ceil(src.height / s));
      const sm = mk(w, h); cx2d(sm).drawImage(src, 0, 0, w, h);
      const c = mk(src.width, src.height), g = cx2d(c); g.imageSmoothingEnabled = false; g.drawImage(sm, 0, 0, w * s, h * s);
      return c;
    }
    case 'post': return pix(src, d => { const n = p.n - 1; for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / 255 * n) / n * 255; });
    case 'thresh': return pix(src, d => { for (let i = 0; i < d.length; i += 4) { const v = d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11 >= p.t ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } });
    case 'gray': return pix(src, d => { for (let i = 0; i < d.length; i += 4) { const v = d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11; d[i] = d[i + 1] = d[i + 2] = v; } });
    case 'sepia': return pix(src, d => {
      const a = p.a / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        d[i] = r + ((r * .393 + g * .769 + b * .189) - r) * a; d[i + 1] = g + ((r * .349 + g * .686 + b * .168) - g) * a; d[i + 2] = b + ((r * .272 + g * .534 + b * .131) - b) * a;
      }
    });
    case 'invert': return pix(src, d => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } });
    case 'sketch': {
      const gray = applyFilter('gray', {}, src);
      const inv = blurCanvas(applyFilter('invert', {}, gray), p.r);
      const bi = cx2d(inv, { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data;
      const k = 1 + p.k / 40;
      return pix(gray, d => {
        for (let i = 0; i < d.length; i += 4) {
          const v = clamp(d[i] * 255 / Math.max(1, 255 - bi[i]), 0, 255);
          const o = 255 - Math.pow((255 - v) / 255, 1 / k) * 255;
          d[i] = d[i + 1] = d[i + 2] = o;
        }
      });
    }
    case 'outline': {
      const g0 = cx2d(applyFilter('gray', {}, blurCanvas(src, 1)), { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data;
      const w = src.width, h = src.height, t = 101 - p.t;
      return pix(src, d => {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const L = g0[(y * w + Math.max(0, x - 1)) * 4], R = g0[(y * w + Math.min(w - 1, x + 1)) * 4];
          const U = g0[(Math.max(0, y - 1) * w + x) * 4], D = g0[(Math.min(h - 1, y + 1) * w + x) * 4];
          const m = Math.hypot(R - L, D - U);
          const v = clamp(255 - (m - t * .4) * 255 / (t + 1), 0, 255);
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      });
    }
    case 'vignette': {
      const c = mk(src.width, src.height), g = cx2d(c);
      g.drawImage(src, 0, 0);
      const w = c.width, h = c.height, r = Math.hypot(w, h) / 2;
      const gr = g.createRadialGradient(w / 2, h / 2, r * (1 - p.s / 100) * .9, w / 2, h / 2, r);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${p.a / 100})`);
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = gr; g.fillRect(0, 0, w, h);
      return c;
    }
  }
  return src;
}
