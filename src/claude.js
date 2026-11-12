// Claude features. Only available when the page runs on claude.ai; elsewhere getSample() resolves to null.
import { db, nameOf } from "./db.js";
import { validateAi, validateFallback } from "./teams.js";
import { matchName } from "./reader.js";

let samplePromise = null;
export function getSample() {
  if (!samplePromise) {
    samplePromise = (async () => {
      // A standalone page (e.g. GitHub Pages) isn't framed and has no Claude runtime: decide right away.
      let framed = true;
      try { framed = window.top !== window; } catch (e) { /* cross-origin parent: framed */ }
      if (!framed && !window.claude) return null;
      for (let i = 0; i < 50 && !(window.claude && typeof window.claude.use === "function"); i++) await new Promise(r => setTimeout(r, 200));
      if (!(window.claude && typeof window.claude.use === "function")) return null;
      try { return await window.claude.use("sample"); } catch (e) { return null; }
    })();
  }
  return samplePromise;
}

export async function canReadImages() {
  const sample = await getSample();
  if (!sample) return false;
  try { const lim = await sample.limits(); return !!(lim && lim.images); } catch (e) { return false; }
}

function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in reply");
  return JSON.parse(m[0]);
}

async function askJson(prompt, opts) {
  const sample = await getSample();
  if (!sample) throw Object.assign(new Error("unavailable"), { code: "not_granted" });
  if (typeof sample.json === "function") {
    try {
      const v = await sample.json(prompt, opts);
      if (v && typeof v === "object") return v;
    } catch (e) { if (e && e.code) throw e; }
  }
  const r = await sample(prompt, opts);
  return extractJson(r.text);
}

export function aiErrorMessage(e, fallback) {
  if (e && e.code === "not_granted") return "Claude isn't available for this page right now.";
  if (e && e.code === "rate_limited") return "Claude is busy. Wait a minute and try again.";
  return fallback;
}

const rosterText = roster => Object.keys(roster).filter(id => db.byId[id]).map(id => `${id} (${nameOf(id)}): C${roster[id]}`).join("; ");

// Ranks the given candidate teams and explains each pick. Throws if the answer doesn't match the candidates.
export async function rankTeams(anchor, roster, cands) {
  const payload = cands.map(c => ({
    id: c.key, archetype: c.team.arch, guide_note: c.team.note, budget: c.team.limited,
    slots: c.opts.map((o, i) => ({ slot: i + 1, pick: c.picks[i], owned_options_in_guide_order: o.map(x => x.id) })),
  }));
  const prompt = `You rank Genshin Impact teams for a fan site. The candidate teams come from KeqingMains (KQM) quick guides and are the only source of truth. Your own knowledge of the game may be out of date: when it disagrees with the data, trust the data.

Anchor character: ${anchor} (${nameOf(anchor)})
Player's roster (id (name): constellation): ${rosterText(roster)}

CANDIDATES (JSON):
${JSON.stringify(payload)}

Rules:
- Return 1 to 3 teams, chosen by "id" from CANDIDATES. Never invent a team.
- For each slot, use a character from that slot's owned_options_in_guide_order. Keep "pick" unless the player's constellations give a clear reason to change it. Every team must include the anchor, and no character may appear twice in a team.
- Prefer teams earlier in the list unless the roster's constellations make another clearly better. Avoid returning two near-identical teams.
- For each member write one short reason (max 20 words) saying what they do for the anchor in this team. Don't state numbers or percentages.
- "summary": one sentence on why this team suits this player's roster.
Reply with JSON only, in exactly this shape:
{"teams":[{"id":"c1","summary":"...","members":[{"slot":1,"id":"...","reason":"..."},{"slot":2,"id":"...","reason":"..."},{"slot":3,"id":"...","reason":"..."},{"slot":4,"id":"...","reason":"..."}]}]}`;
  try {
    return validateAi(await askJson(prompt, { modelTier: "quick" }), cands, anchor);
  } catch (e) {
    if (e && e.code) throw e;
    const retry = `${prompt}\n\nYour previous answer was rejected: ${e.message}. Follow the rules exactly.`;
    return validateAi(await askJson(retry, { modelTier: "default" }), cands, anchor);
  }
}

// Free suggestion for a character with no guide teams. Returns null when Claude doesn't know the character.
export async function suggestTeam(anchor, roster) {
  const info = Object.keys(roster).filter(id => db.byId[id]).map(id => {
    const c = db.byId[id];
    return `${id} (${c.name}, ${c.rarity}★ ${c.element} ${c.weapon}, C${roster[id]})`;
  }).join("; ");
  const prompt = `Suggest one Genshin Impact team of 4 for ${nameOf(anchor)} (id: ${anchor}), using only characters this player owns.
Owned characters: ${info}
Rules:
- Use only ids from the owned list. Include ${anchor}. No duplicates.
- If you don't reliably know how ${nameOf(anchor)} plays (for example a character released after your training data), reply {"unknown":true} instead of guessing.
- One short reason per member (max 20 words), no numbers. "summary": one sentence.
Reply with JSON only: {"summary":"...","members":[{"id":"...","reason":"..."},{"id":"...","reason":"..."},{"id":"...","reason":"..."},{"id":"...","reason":"..."}]}`;
  return validateFallback(await askJson(prompt, { modelTier: "default" }), roster, anchor);
}

// Claude reads the screenshots (portrait-only screenshots work too). Adds to `roster`.
export async function readScreenshotsWithClaude(files, roster, onStatus) {
  const names = db.characters.map(c => c.name).join(", ");
  const result = { seen: new Set(), added: 0, unknown: [] };
  for (let i = 0; i < files.length; i++) {
    onStatus(`Reading screenshot ${i + 1} of ${files.length}…`);
    const prompt = `This is a screenshot from Genshin Impact or HoYoLAB showing a player's characters. List every playable character you can identify.
Use exact names from this list: ${names}.
For the Traveler, use "Traveler" plus the element shown if you can tell, e.g. "Traveler (Anemo)".
Constellations: a small number in a dark box at the top-right corner of a portrait is that character's constellation (1–6). A portrait with no number there is C0, so use 0. Use null only if you can't see the corner.
Only list characters you can actually identify. Don't guess from silhouettes.
Reply with JSON only: {"characters":[{"name":"...","constellation":null}]}`;
    const v = await askJson(prompt, { images: [files[i]], modelTier: "default" });
    for (const ch of v && Array.isArray(v.characters) ? v.characters : []) {
      const id = matchName(ch && ch.name);
      if (!id) { if (ch && ch.name) result.unknown.push(String(ch.name).slice(0, 40)); continue; }
      const c = Number.isInteger(ch.constellation) && ch.constellation >= 0 && ch.constellation <= 6 ? ch.constellation : (roster[id] ?? 0);
      if (roster[id] === undefined) result.added++;
      roster[id] = c;
      result.seen.add(id);
    }
  }
  return result;
}
