// Adds newly released characters from the Genshin Impact Fandom wiki (MediaWiki API).
// Additive and conservative: existing characters are never changed or removed, and a character is only
// added once its wiki page has a release date that has passed.
import { pathToFileURL } from "node:url";
import { ELEMENTS, WEAPONS, slugify, fetchText, sleep } from "./lib/data-io.mjs";

const API = "https://genshin-impact.fandom.com/api.php";
const CATEGORIES = ["Category:Playable Characters", "Category:Playable characters"];

async function api(params) {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ ...params, format: "json", formatversion: "2" })) url.searchParams.set(k, v);
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error(`wiki API returned ${status}`);
  return JSON.parse(text);
}

async function categoryMembers() {
  for (const cat of CATEGORIES) {
    const titles = [];
    let cont;
    do {
      const j = await api({ action: "query", list: "categorymembers", cmtitle: cat, cmlimit: "500", cmnamespace: "0", ...(cont ? { cmcontinue: cont } : {}) });
      titles.push(...((j.query && j.query.categorymembers) || []).map(m => m.title));
      cont = j.continue && j.continue.cmcontinue;
    } while (cont);
    if (titles.length) return titles;
  }
  return [];
}

async function pageTexts(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const j = await api({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: titles.slice(i, i + 50).join("|") });
    for (const p of (j.query && j.query.pages) || []) {
      const rev = p.revisions && p.revisions[0];
      out[p.title] = rev ? (rev.slots ? rev.slots.main.content : rev.content) : "";
    }
    await sleep(500);
  }
  return out;
}

// Pulls "|key = value" fields out of the page's {{Character Infobox ...}} template.
export function parseInfobox(wikitext) {
  const start = String(wikitext).search(/\{\{\s*Character[ _]Infobox/i);
  if (start < 0) return null;
  let depth = 0, end = start;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") { depth++; i++; }
    else if (wikitext[i] === "}" && wikitext[i + 1] === "}") { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  const body = wikitext.slice(start, end);
  const fields = {};
  for (const m of body.matchAll(/^\s*\|\s*([\w ]+?)\s*=\s*(.*)$/gm)) fields[m[1].toLowerCase().replace(/[\s_]/g, "")] = m[2].trim();
  return fields;
}

const clean = v => String(v || "").replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, "").replace(/\{\{[^{}]*\}\}/g, "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/<[^>]+>/g, "").trim();

// { element, weapon, rarity, released } from an infobox, or null if something essential is missing.
export function characterFromInfobox(fields, now = new Date()) {
  if (!fields) return null;
  const pick = (...keys) => { for (const k of keys) if (fields[k]) return clean(fields[k]); return ""; };
  const element = pick("element", "vision").toLowerCase();
  const weapon = pick("weapon", "weapontype").toLowerCase();
  const rarity = parseInt(pick("rarity", "quality"), 10);
  const dateText = pick("releasedate", "release", "released");
  const date = dateText ? new Date(Date.parse(dateText.replace(/(\d)(st|nd|rd|th)\b/g, "$1"))) : null;
  if (!ELEMENTS.includes(element) || !WEAPONS.includes(weapon) || ![4, 5].includes(rarity)) return null;
  return { element, weapon, rarity, released: !!(date && !isNaN(date) && date <= now) };
}

// Finds the existing character a wiki title refers to (by id, name, alias, or a name inside a longer title).
export function findExisting(title, characters) {
  const t = slugify(title);
  for (const c of characters) {
    if (slugify(c.id) === t || slugify(c.name) === t || (c.aliases || []).some(a => slugify(a) === t)) return c;
  }
  const words = title.toLowerCase().split(/\s+/);
  return characters.find(c => !c.id.startsWith("traveler") && !c.name.includes(" ") && words.includes(c.name.toLowerCase())) || null;
}

export async function updateCharacters(characters, { now = new Date() } = {}) {
  const report = { added: [], aliased: [], warnings: [] };
  const titles = await categoryMembers();
  if (titles.length < characters.length * 0.8) throw new Error(`wiki listed only ${titles.length} playable characters; not trusting it`);
  const unknown = titles.filter(t => !findExisting(t, characters) && !/traveler|traveller|aether|lumine|manekin/i.test(t));
  if (!unknown.length) return { characters, report };
  const texts = await pageTexts(unknown);
  const next = characters.slice();
  for (const title of unknown) {
    const info = characterFromInfobox(parseInfobox(texts[title] || ""), now);
    if (!info) { report.warnings.push(`${title}: couldn't read element, weapon or rarity from the wiki page`); continue; }
    if (!info.released) continue; // announced but not out yet
    let id = slugify(title);
    if (next.some(c => c.id === id)) { report.warnings.push(`${title}: id ${id} already taken`); continue; }
    next.push({ id, name: title, element: info.element, weapon: info.weapon, rarity: info.rarity });
    report.added.push(title);
  }
  return { characters: report.added.length ? next : characters, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readAll, writeCharacters } = await import("./lib/data-io.mjs");
  const { characters } = await readAll();
  const { characters: next, report } = await updateCharacters(characters);
  if (report.added.length) await writeCharacters(next);
  console.log(JSON.stringify(report, null, 2));
}
