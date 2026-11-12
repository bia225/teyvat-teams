// Checks data/*.json for mistakes. Exits non-zero on any error. Also used by the tests and the updater.
import { pathToFileURL } from "node:url";
import { readAll, ELEMENTS, WEAPONS } from "./lib/data-io.mjs";

export function validateData({ characters, teams, meta }) {
  const errors = [];
  const ids = new Set(), names = new Set();
  for (const c of characters) {
    const where = `character ${c.id || JSON.stringify(c)}`;
    if (!/^[a-z][a-z-]*$/.test(c.id || "")) errors.push(`${where}: bad id`);
    if (ids.has(c.id)) errors.push(`${where}: duplicate id`);
    ids.add(c.id);
    if (!c.name) errors.push(`${where}: missing name`);
    else if (names.has(c.name.toLowerCase())) errors.push(`${where}: duplicate name ${c.name}`);
    names.add((c.name || "").toLowerCase());
    if (![...ELEMENTS, "varies"].includes(c.element)) errors.push(`${where}: bad element ${c.element}`);
    if (!WEAPONS.includes(c.weapon)) errors.push(`${where}: bad weapon ${c.weapon}`);
    if (![4, 5].includes(c.rarity)) errors.push(`${where}: bad rarity ${c.rarity}`);
    if (c.aliases !== undefined && (!Array.isArray(c.aliases) || c.aliases.some(a => typeof a !== "string" || !a))) errors.push(`${where}: bad aliases`);
  }

  const sources = teams.sources || {};
  for (const [key, s] of Object.entries(sources)) {
    if (!ids.has(s.character)) errors.push(`source ${key}: unknown character ${s.character}`);
    if (!/^https:\/\//.test(s.url || "")) errors.push(`source ${key}: bad url`);
    if (!s.guide) errors.push(`source ${key}: missing guide name`);
  }
  (teams.teams || []).forEach((t, i) => errors.push(...validateTeam(t, ids, sources).map(e => `team ${i} (${t.source} ${t.archetype}): ${e}`)));

  if (meta && typeof meta !== "object") errors.push("meta.json is not an object");
  return errors;
}

// Shared with the team updater, which checks Claude's extraction before using it.
export function validateTeam(t, ids, sources) {
  const errors = [];
  if (sources && !sources[t.source]) errors.push(`unknown source ${t.source}`);
  if (!t.archetype || typeof t.archetype !== "string") errors.push("missing archetype");
  if (typeof t.note !== "string" || !t.note.trim()) errors.push("missing note");
  else if (t.note.length > 200) errors.push("note longer than 200 characters");
  if (!Array.isArray(t.slots) || t.slots.length !== 4) { errors.push("needs exactly 4 slots"); return errors; }
  for (const slot of t.slots) {
    if (!Array.isArray(slot) || !slot.length) { errors.push("empty slot"); continue; }
    for (const opt of slot) {
      const m = /^([a-z][a-z-]*)(?:@([1-6]))?$/.exec(opt);
      if (!m) errors.push(`bad option "${opt}"`);
      else if (!ids.has(m[1])) errors.push(`unknown character ${m[1]}`);
    }
  }
  const subject = sources && sources[t.source] && sources[t.source].character;
  if (subject && !t.slots.some(slot => slot.some(o => o.split("@")[0] === subject))) errors.push(`doesn't include ${subject}`);
  if (t.budget !== undefined && typeof t.budget !== "boolean") errors.push("budget must be true/false");
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await readAll();
  const errors = validateData(data);
  if (errors.length) {
    console.error(`Data check failed (${errors.length}):\n` + errors.map(e => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(`Data OK: ${data.characters.length} characters, ${data.teams.teams.length} teams, ${Object.keys(data.teams.sources).length} guides.`);
}
