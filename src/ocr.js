// Reads screenshots in the visitor's browser with Tesseract.js (no server, nothing uploaded).
import { detectCards, lumaOf, badgeGlyph, readConstellation, matchCardName, namesFromText } from "./reader.js";

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ";

let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract missing")));
      s.onerror = () => { tesseractPromise = null; reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
  }
  return tesseractPromise;
}

async function fileToCanvas(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c;
}

// Grayscale, enlarge small images, dark text on light: what OCR reads best.
async function prepareForText(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(bmp.width < 1400 ? 2 : 1, 4000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; sum += y; }
  if (sum / (d.length / 4) < 128) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  g.putImageData(img, 0, 0);
  return c;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wb = 0, sb = 0, best = -1, th = 128;
  for (let t = 0; t < 256; t++) {
    wb += hist[t];
    if (!wb) continue;
    const wf = total - wb;
    if (!wf) break;
    sb += t * hist[t];
    const mb = sb / wb, mf = (sumAll - sb) / wf, v = wb * wf * (mb - mf) ** 2;
    if (v > best) { best = v; th = t; }
  }
  return th;
}

// Stacks every card's name area into one tall sheet (dark text on white) so one OCR pass reads them all.
function buildNameSheet(canvas, cards) {
  const W = canvas.width, H = canvas.height, parts = [];
  for (const c of cards) {
    const x0 = Math.max(0, Math.floor(c.x0 - 0.12 * c.w)), x1 = Math.min(W, Math.floor(c.x1 + 0.12 * c.w));
    const y0 = Math.min(H, c.barBot + 2), y1 = Math.min(H, Math.floor(c.barBot + 0.4 * c.w));
    if (x1 - x0 < 4 || y1 - y0 < 4) { parts.push(null); continue; }
    const cv = document.createElement("canvas");
    cv.width = (x1 - x0) * 3; cv.height = (y1 - y0) * 3;
    const g = cv.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
    const id = g.getImageData(0, 0, cv.width, cv.height), d = id.data, gray = new Uint8Array(cv.width * cv.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
    const th = otsu(gray);
    let above = 0;
    for (const v of gray) if (v > th) above++;
    const lightText = above < gray.length / 2;
    let lo = 255, hi = 0;
    for (const v of gray) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(1, hi - lo);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      let v = ((gray[i] - lo) / span) * 255;
      if (lightText) v = 255 - v;
      d[p] = d[p + 1] = d[p + 2] = Math.round(v); d[p + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    parts.push(cv);
  }
  const gap = 36, width = Math.max(40, ...parts.filter(Boolean).map(p => p.width)) + 40;
  const height = parts.reduce((h, p) => h + (p ? p.height : 0) + gap, gap);
  const sheet = document.createElement("canvas");
  sheet.width = width; sheet.height = height;
  const sg = sheet.getContext("2d");
  sg.fillStyle = "#fff"; sg.fillRect(0, 0, width, height);
  const spans = [];
  let y = gap;
  for (const p of parts) {
    if (p) { sg.drawImage(p, 20, y); spans.push([y, y + p.height]); y += p.height + gap; }
    else { spans.push(null); y += gap; }
  }
  return { sheet, spans, parts };
}

function wordsOf(data) {
  if (data && Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const b of (data && data.blocks) || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
  return out;
}

function padded(canvas) {
  const pad = document.createElement("canvas");
  pad.width = canvas.width + 40; pad.height = canvas.height + 40;
  const g = pad.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, pad.width, pad.height);
  g.drawImage(canvas, 20, 20);
  return pad;
}

async function readCards(worker, canvas, img, cards) {
  const { sheet, spans, parts } = buildNameSheet(canvas, cards);
  await worker.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "" });
  const { data } = await worker.recognize(sheet, {}, { text: true, blocks: true });
  const names = cards.map(() => "");
  for (const w of wordsOf(data)) {
    if (!w.text || !w.bbox) continue;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const k = spans.findIndex(sp => sp && cy >= sp[0] - 6 && cy <= sp[1] + 6);
    if (k >= 0) names[k] += (names[k] ? " " : "") + w.text;
  }
  const ids = names.map(n => matchCardName(n));
  // Second try for names the first pass missed: that card alone, letters only.
  const retry = ids.map((id, k) => (!id && parts[k] ? k : -1)).filter(k => k >= 0);
  if (retry.length) {
    await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: LETTERS });
    for (const k of retry) {
      const { data: d } = await worker.recognize(padded(parts[k]));
      ids[k] = matchCardName(d && d.text);
    }
    await worker.setParameters({ tessedit_char_whitelist: "" });
  }
  const L = lumaOf(img);
  return cards.map((c, k) => ({ id: ids[k], constellation: ids[k] ? readConstellation(badgeGlyph(L, img.width, img.height, c)) : 0 }));
}

// Adds what it finds to `roster` (id -> constellation). onStatus(text) reports progress.
export async function readScreenshotsLocally(files, roster, onStatus) {
  onStatus("Loading the text reader (the first time takes a few seconds)…");
  let worker;
  try {
    worker = await (await loadTesseract()).createWorker("eng");
  } catch (e) {
    throw Object.assign(new Error("reader-unavailable"), { userMessage: "Couldn't load the text reader. Check your connection and try again, or mark characters below." });
  }
  const result = { seen: new Set(), added: 0, withConstellation: 0, traveler: false, cardMode: false };
  try {
    for (let i = 0; i < files.length; i++) {
      onStatus(`Reading screenshot ${i + 1} of ${files.length}…`);
      const canvas = await fileToCanvas(files[i]);
      const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const cards = detectCards(img);
      if (cards.length >= 2) {
        // HoYoLAB character list: a name and a constellation badge per card.
        result.cardMode = true;
        for (const { id, constellation } of await readCards(worker, canvas, img, cards)) {
          if (!id) continue;
          if (id === "traveler") { result.traveler = true; continue; }
          if (roster[id] === undefined) result.added++;
          if (constellation > 0) result.withConstellation++;
          roster[id] = constellation;
          result.seen.add(id);
        }
      } else {
        // Any other screenshot: find names in the text; constellations stay as they are.
        await worker.setParameters({ tessedit_pageseg_mode: "3", tessedit_char_whitelist: "" });
        const { data } = await worker.recognize(await prepareForText(files[i]));
        const r = namesFromText((data && data.text) || "");
        result.traveler = result.traveler || r.traveler;
        for (const id of r.ids) {
          result.seen.add(id);
          if (roster[id] === undefined) { roster[id] = 0; result.added++; }
        }
      }
    }
  } finally {
    try { await worker.terminate(); } catch (e) { /* already gone */ }
  }
  return result;
}
