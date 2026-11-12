// Screenshot reading helpers that don't need the DOM: card detection, constellation badges, name matching.
import { db } from "./db.js";

const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
const words = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]+/g, " ").trim().split(" ").filter(Boolean);
const TRAVELER_NAMES = ["Traveler", "Traveller", "Aether", "Lumine"];

// Names and aliases of every character except the Traveler (whose element can't be read from a name).
let keyCache = { chars: null, keys: [] };
function nameKeys() {
  if (keyCache.chars !== db.characters) {
    const keys = [];
    for (const c of db.characters) {
      if (c.id.startsWith("traveler")) continue;
      for (const n of [c.name, ...(c.aliases || [])]) keys.push({ name: n, id: c.id });
    }
    for (const n of TRAVELER_NAMES) keys.push({ name: n, id: "traveler" });
    keyCache = { chars: db.characters, keys };
  }
  return keyCache.keys;
}

// Exact name lookup (used for Claude's answers). "Traveler (Cryo)" maps to that Traveler.
export function matchName(raw) {
  const n = norm(raw);
  if (!n) return null;
  for (const c of db.characters) if (norm(c.id) === n || norm(c.name) === n) return c.id;
  const k = nameKeys().find(k => norm(k.name) === n);
  if (k) return k.id === "traveler" ? "traveler-anemo" : k.id;
  return null;
}

// Edit distance where letters OCR often confuses cost half.
const LOOKALIKE = new Set(["li", "il", "ij", "ji", "qg", "gq", "uv", "vu", "nh", "hn", "ce", "ec"]);
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const ca = a[i - 1], cb = b[j - 1], sub = ca === cb ? 0 : LOOKALIKE.has(ca + cb) ? 0.5 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev = cur;
  }
  return prev[b.length];
}

// One card = one name: pick the closest known name, allowing a few OCR mistakes. Returns an id, "traveler" or null.
export function matchCardName(raw) {
  const s = norm(raw);
  if (s.length < 3) return null;
  const best = new Map();
  for (const k of nameKeys()) {
    const key = norm(k.name);
    const d = editDistance(s, key) / Math.max(1, Math.round(0.4 * key.length));
    if (!best.has(k.id) || d < best.get(k.id)) best.set(k.id, d);
  }
  const ranked = [...best.entries()].sort((a, b) => a[1] - b[1]);
  if (!ranked.length || ranked[0][1] > 1) return null;
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return null;
  return ranked[0][0];
}

// Finds names anywhere in free OCR text (screenshots that aren't HoYoLAB character cards).
export function namesFromText(text) {
  const tokens = words(text);
  const keys = nameKeys().filter(k => k.id !== "traveler").map(k => ({ w: words(k.name), id: k.id })).sort((a, b) => b.w.length - a.w.length);
  const found = new Set();
  let traveler = false;
  for (let i = 0; i < tokens.length; i++) {
    if (TRAVELER_NAMES.some(n => n.toLowerCase() === tokens[i])) traveler = true;
    for (const k of keys) {
      if (i + k.w.length > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < k.w.length; j++) {
        const t = tokens[i + j], w = k.w[j];
        if (t === w || (w.length >= 6 && editDistance(t, w) <= 1)) continue;
        ok = false;
        break;
      }
      if (ok) found.add(k.id);
    }
  }
  return { ids: [...found], traveler };
}

// HoYoLAB character cards have a solid #1f1f1f level bar; the square portrait sits above it.
export function detectCards(img) {
  const { data, width: W, height: H } = img, n = W * H;
  const bar = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    bar[i] = Math.abs(r - 31) <= 4 && Math.abs(g - 31) <= 4 && Math.abs(b - 31) <= 4 ? 1 : 0;
  }
  const seen = new Uint8Array(n), stack = new Int32Array(n), out = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!bar[s0] || seen[s0]) continue;
    let sp = 0;
    stack[sp++] = s0; seen[s0] = 1;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && bar[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < W - 1 && bar[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && bar[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
      if (y < H - 1 && bar[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < 0.05 * W || w > 0.3 * W || h < 0.12 * w || h > 0.5 * w) continue;
    // Dark portrait pixels can touch the bar, so take the bar height most columns agree on.
    const counts = new Map();
    for (let x = x0 + 2; x <= x1 - 2; x++) {
      let k = 0;
      while (y1 - k >= y0 && bar[(y1 - k) * W + x]) k++;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let bh = 0, bc = -1;
    for (const [k, c] of counts) if (c > bc) { bc = c; bh = k; }
    out.push({ x0, x1: x1 + 1, barTop: y1 + 1 - bh, barBot: y1 + 1, w });
  }
  return out.sort((a, b) => (Math.floor(a.barBot / 20) - Math.floor(b.barBot / 20)) || a.x0 - b.x0);
}

export function lumaOf(img) {
  const { data, width: W, height: H } = img, L = new Float32Array(W * H);
  for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return L;
}

// Area-average resize of a w×h float array to tw×th.
function resizeArea(src, w, h, tw, th) {
  const out = new Float32Array(tw * th), sx = w / tw, sy = h / th;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
    const ax = i * sx, bx = ax + sx, ay = j * sy, by = ay + sy;
    let acc = 0, wt = 0;
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) {
      const fy = Math.min(by, y + 1) - Math.max(ay, y);
      if (fy <= 0) continue;
      for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
        const fx = Math.min(bx, x + 1) - Math.max(ax, x);
        if (fx <= 0) continue;
        acc += src[Math.min(h - 1, y) * w + Math.min(w - 1, x)] * fx * fy;
        wt += fx * fy;
      }
    }
    out[j * tw + i] = wt ? acc / wt : 0;
  }
  return out;
}

const GLYPH_W = 8, GLYPH_H = 12;

// The constellation digit in the portrait's top-right badge, as an 8×12 array in [0,1]; null when there's no badge.
export function badgeGlyph(L, W, H, c) {
  const w = c.w, top = c.barTop - w, s = Math.round(0.22 * w), bx0 = c.x1 - s, by0 = Math.max(0, top);
  if (bx0 < 0 || by0 + s > H) return null;
  const at = (x, y) => L[(by0 + y) * W + bx0 + x];
  const lab = new Int32Array(s * s);
  const comps = [];
  let nl = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    if (at(x, y) <= 150 || lab[y * s + x]) continue;
    nl++;
    const st = [[x, y]];
    lab[y * s + x] = nl;
    let x0 = x, x1 = x, y0 = y, y1 = y;
    while (st.length) {
      const [cx, cy] = st.pop();
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= s || ny >= s || lab[ny * s + nx] || at(nx, ny) <= 150) continue;
        lab[ny * s + nx] = nl;
        st.push([nx, ny]);
      }
    }
    comps.push({ id: nl, x0, x1: x1 + 1, y0, y1: y1 + 1 });
  }
  // The digit sits near a fixed spot relative to the card; pick the bright blob closest to it.
  const ex = s - 0.12 * w, ey = top + 0.09 * w - by0;
  let best = null, bd = Infinity;
  for (const k of comps) {
    const h = k.y1 - k.y0;
    if (h < 0.06 * w || h > 0.13 * w) continue;
    const d = Math.hypot((k.x0 + k.x1) / 2 - ex, (k.y0 + k.y1) / 2 - ey);
    if (d <= 0.06 * w && d < bd) { bd = d; best = k; }
  }
  if (!best) return null;
  const ring = [];
  for (let y = Math.max(0, best.y0 - 2); y < Math.min(s, best.y1 + 2); y++)
    for (let x = Math.max(0, best.x0 - 2); x < Math.min(s, best.x1 + 2); x++) {
      const v = at(x, y);
      if (v < 150) ring.push(v);
    }
  ring.sort((a, b) => a - b);
  const bg = ring.length ? ring[ring.length >> 1] : 0;
  const gw = best.x1 - best.x0, gh = best.y1 - best.y0, g = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let v = at(best.x0 + x, best.y0 + y);
    if (lab[(best.y0 + y) * s + best.x0 + x] !== best.id) v = Math.min(v, 150);
    g[y * gw + x] = Math.max(0, Math.min(1, (v - bg) / (255 - bg + 1e-6)));
  }
  return resizeArea(g, gw, gh, GLYPH_W, GLYPH_H);
}

// Average 8×12 glyphs of the badge digits 1–6, measured from real HoYoLAB screenshots.
export const BADGE_TEMPLATES = [
  [0,0,0.37,0.37,0.92,0.92,0.72,0.72,0.35,0.35,0.66,0.66,0.9,0.9,0.72,0.72,0.7,0.7,0.95,0.95,0.88,0.88,0.72,0.72,0,0,0.11,0.11,0.8,0.8,0.72,0.72,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73,0,0,0.12,0.12,0.8,0.8,0.73,0.73],
  [0.06,0.53,0.85,1,1,0.9,0.64,0.21,0.24,0.58,0.66,0.5,0.54,0.75,0.71,0.44,0.42,0.62,0.48,0,0.08,0.59,0.79,0.67,0,0,0,0,0.06,0.53,0.77,0.78,0,0,0,0,0.24,0.65,0.79,0.67,0,0,0,0,0.43,0.77,0.81,0.55,0,0,0.19,0.56,0.96,0.69,0.37,0,0.03,0.27,0.49,0.71,0.59,0.38,0.19,0,0.06,0.53,0.8,0.85,0.22,0.08,0.01,0.01,0.56,0.74,0.62,0.22,0,0,0.01,0.01,0.61,0.81,0.81,0.61,0.5,0.5,0.48,0.43,0.66,0.89,1,1,1,1,0.95,0.85],
  [0.08,0.5,0.8,1,0.99,0.81,0.48,0,0.28,0.55,0.63,0.5,0.68,0.77,0.62,0.25,0.47,0.61,0.45,0,0.37,0.72,0.76,0.49,0,0,0,0,0.49,0.76,0.71,0.34,0.04,0.25,0.4,0.5,0.68,0.61,0.44,0.17,0.09,0.5,0.8,1,0.88,0.46,0.16,0,0,0,0,0,0.49,0.78,0.78,0.49,0,0,0,0,0.31,0.68,0.78,0.61,0,0,0,0,0.12,0.57,0.77,0.73,0.66,0.55,0.33,0,0.38,0.72,0.76,0.5,0.42,0.6,0.62,0.5,0.68,0.73,0.59,0.25,0.17,0.64,0.92,1,0.98,0.74,0.41,0.01],
  [0,0,0,0.3,0.7,0.8,0.39,0,0,0,0.1,0.46,0.81,0.81,0.39,0,0,0,0.19,0.63,0.92,0.82,0.39,0,0,0,0.54,0.74,0.79,0.75,0.39,0,0,0.28,0.64,0.64,0.68,0.74,0.39,0,0,0.55,0.74,0.54,0.57,0.74,0.39,0,0.52,0.8,0.33,0.21,0.52,0.74,0.39,0,0.67,0.89,0.67,0.61,0.76,0.87,0.67,0.34,0.82,0.97,1,1,1,1,0.95,0.68,0,0,0,0.16,0.52,0.74,0.39,0.01,0,0,0,0.16,0.52,0.74,0.39,0.01,0,0,0,0.16,0.52,0.74,0.4,0.01],
  [0.53,0.82,0.99,1,1,0.94,0.69,0.31,0.54,0.79,0.82,0.62,0.5,0.47,0.35,0.15,0.56,0.75,0.66,0.24,0,0,0,0,0.65,0.75,0.55,0.02,0,0,0.01,0,0.65,0.82,0.78,0.51,0.5,0.38,0.21,0.02,0.65,0.88,1,1,1,0.76,0.42,0.04,0,0.01,0.01,0.04,0.58,0.85,0.76,0.42,0,0.01,0.01,0.02,0.41,0.75,0.75,0.49,0,0,0.01,0.01,0.24,0.66,0.75,0.56,0.65,0.45,0.21,0.03,0.58,0.85,0.76,0.42,0.53,0.61,0.59,0.52,0.78,0.77,0.55,0.22,0.41,0.76,0.97,1,0.98,0.69,0.34,0.01],
  [0,0.15,0.45,0.89,1,0.99,0.84,0.57,0.11,0.4,0.63,0.79,0.5,0.49,0.42,0.28,0.22,0.66,0.82,0.69,0.01,0,0,0,0.63,0.77,0.63,0.21,0,0,0,0,0.67,0.78,0.75,0.57,0.5,0.47,0.35,0.14,0.71,0.79,0.86,0.94,1,0.94,0.7,0.27,0.72,0.85,0.71,0.3,0.12,0.53,0.75,0.77,0.72,0.78,0.59,0.15,0.07,0.44,0.69,0.8,0.71,0.7,0.47,0.01,0.01,0.35,0.63,0.82,0.51,0.76,0.69,0.29,0.16,0.6,0.81,0.76,0.26,0.59,0.72,0.64,0.58,0.75,0.73,0.48,0.01,0.42,0.76,0.99,1,0.9,0.64,0.2]
];
const BADGE_MAX_SCORE = 0.18;

// 0 when there's no badge (or the blob doesn't look like a digit), otherwise 1–6.
export function readConstellation(glyph) {
  if (!glyph) return 0;
  let best = 0, bs = Infinity;
  BADGE_TEMPLATES.forEach((t, k) => {
    let s = 0;
    for (let i = 0; i < t.length; i++) s += Math.abs(glyph[i] - t[i]);
    s /= t.length;
    if (s < bs) { bs = s; best = k + 1; }
  });
  return bs <= BADGE_MAX_SCORE ? best : 0;
}
