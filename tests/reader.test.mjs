import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadRealData } from "./helpers.mjs";
import { matchCardName, matchName, namesFromText, detectCards, readConstellation, BADGE_TEMPLATES } from "../src/reader.js";

before(loadRealData);

test("card names survive common OCR mistakes", () => {
  const cases = {
    "Keqing": "keqing", "Kequng": "keqing", "Citiali": "citlali", "Chion": "chiori", "Tighnan": "tighnari", "Qidi": "qiqi",
    "lansan": "iansan", "Kula Shinobu": "kuki", "Rosana": "rosaria", "Wniothesley": "wriothesley", "Raiden Shogun": "raiden",
    "Sangonomiya Kokomi": "kokomi", "Yumemiuki Mizuki": "mizuki", "Manekina": "manekina", "Manekin": "manekin", "Traveler": "traveler",
  };
  for (const [raw, id] of Object.entries(cases)) assert.equal(matchCardName(raw), id, raw);
});

test("junk isn't matched to a character", () => {
  for (const raw of ["Lv 80", "Friendship", "Characters", "ge", "=a", ""]) assert.equal(matchCardName(raw), null, raw);
});

test("Claude's names map to ids, including the Traveler", () => {
  assert.equal(matchName("Kaedehara Kazuha"), "kazuha");
  assert.equal(matchName("Traveler (Cryo)"), "traveler-cryo");
  assert.equal(matchName("Nobody"), null);
});

test("names are found in free text", () => {
  const { ids, traveler } = namesFromText("Lv. 90 Raiden Shogun C2\nFurlna Lv. 80\nHu Tao Traveler\nYae Miko");
  for (const id of ["raiden", "furina", "hutao", "yae"]) assert.ok(ids.includes(id), id);
  assert.ok(traveler);
});

test("HoYoLAB cards are found by their level bars", () => {
  // Two 90px cards side by side, each with a 20px #1f1f1f bar under a 90px portrait.
  const W = 400, H = 160, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([40, 50, 70, 255], i * 4);
  for (const x0 of [20, 140]) for (let y = 100; y < 120; y++) for (let x = x0; x < x0 + 90; x++) data.set([31, 31, 31, 255], (y * W + x) * 4);
  const cards = detectCards({ data, width: W, height: H });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(c => [c.x0, c.w, c.barTop, c.barBot]), [[20, 90, 100, 120], [140, 90, 100, 120]]);
});

test("no badge means C0, and each template reads as its own digit", () => {
  assert.equal(readConstellation(null), 0);
  BADGE_TEMPLATES.forEach((t, k) => assert.equal(readConstellation(Float32Array.from(t)), k + 1));
});
