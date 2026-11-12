// Keeps team data in step with the KQM quick guides.
//  1. Each known guide is fetched; when its Teams section changes, Claude extracts the new teams
//     (only if ANTHROPIC_API_KEY is set), they're validated, and they replace that guide's teams.
//  2. Characters without a guide are checked for a newly published guide, a few per run.
// Without an API key, changes are only reported (the workflow turns the report into a GitHub issue).
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchText, sleep, today, slugify } from "./lib/data-io.mjs";
import { validateTeam } from "./validate-data.mjs";

const GUIDE_URL = slug => `https://keqingmains.com/q/${slug}-quickguide/`;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const PROBES_PER_RUN = 12;
const PROBE_EVERY_DAYS = 14;

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_, l) => "\n\n" + "#".repeat(Number(l)) + " ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/li|\/tr|\/div|\/figcaption)[^>]*>/gi, "\n")
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&(#8217|rsquo);/g, "'").replace(/&(#8211|ndash);/g, "–")
    .replace(/&(#8212|mdash);/g, "—").replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The guide's Teams section: from the first heading mentioning teams to the next heading at the same level.
export function teamsSection(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => /^#{1,3} .*\bteams?\b/i.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level && !/\bteams?\b/i.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").slice(0, 80000);
}

export function guideVersion(text) {
  const m = /updated for (?:version |v)?(\d+\.\d+|luna [ivx]+)/i.exec(text.slice(0, 8000));
  return m ? m[1].replace(/^luna/i, "Luna") : null;
}

const hash = s => createHash("sha256").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

async function extractTeams({ guideName, subject, section, characters, apiKey }) {
  const list = characters.map(c => `${c.id}: ${c.name}${c.aliases ? " (" + c.aliases.join(", ") + ")" : ""}`).join("\n");
  const prompt = `Below is the Teams section of the KeqingMains quick guide for ${guideName} (character id "${subject}") in Genshin Impact.
Turn every recommended team into JSON for a team-finder site.

Character ids you may use (id: name):
${list}

Rules:
- Each team has exactly 4 slots, in the order the guide lists them. A slot is a list of character ids, best option first, in the guide's order of preference.
- If an option needs a constellation, write it as "id@N" (for example "fischl@6"). Otherwise just the id.
- Only use ids from the list. If a team needs a character that isn't listed, or has fewer than 4 members, or a flexible slot you can't express as specific characters, leave that team out.
- Every team must include ${subject}.
- "archetype": the guide's name for the team type, short (for example "Hypercarry", "Lunar-Charged", "Forward Melt").
- "note": one sentence in your own words, at most 20 words, on how the team works. Don't copy the guide's sentences.
- "budget": true only if the guide presents it as an accessible or limited-roster option.
Reply with JSON only: {"teams":[{"archetype":"...","slots":[["id"],["id","id"],["id"],["id"]],"note":"...","budget":false}]}

TEAMS SECTION:
${section}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = (body.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in Claude's reply");
  const parsed = JSON.parse(m[0]);
  if (!Array.isArray(parsed.teams)) throw new Error("reply has no teams list");
  return parsed.teams;
}

function checkExtracted(raw, source, ids, sources) {
  const teams = raw.map(t => ({
    source,
    archetype: String(t.archetype || "").trim(),
    slots: Array.isArray(t.slots) ? t.slots.map(s => (Array.isArray(s) ? s.map(String) : [])) : [],
    note: String(t.note || "").trim(),
    ...(t.budget ? { budget: true } : {}),
  }));
  const problems = teams.flatMap((t, i) => validateTeam(t, ids, sources).map(e => `team ${i + 1}: ${e}`));
  return { teams, problems };
}

export async function updateTeams({ characters, teams, meta }, { apiKey = process.env.ANTHROPIC_API_KEY, now = new Date() } = {}) {
  const report = { updated: [], added: [], changedNoKey: [], newGuidesNoKey: [], warnings: [] };
  const ids = new Set(characters.map(c => c.id));
  const guides = { ...(meta.guides || {}) };
  const probes = { ...(meta.guideProbes || {}) };
  const pending = { ...(meta.pendingGuides || {}) }; // guides found while there was no API key
  let sources = { ...teams.sources };
  let list = teams.teams.slice();

  const applyGuide = async (key, source, section) => {
    const raw = await extractTeams({ guideName: source.guide, subject: source.character, section, characters, apiKey });
    const trial = { ...sources, [key]: source };
    const { teams: fresh, problems } = checkExtracted(raw, key, ids, trial);
    const old = list.filter(t => t.source === key).length;
    if (!fresh.length) throw new Error("no usable teams in the guide");
    if (problems.length) throw new Error(`extracted teams failed checks: ${problems.slice(0, 5).join("; ")}`);
    if (old && fresh.length < old * 0.5) throw new Error(`only ${fresh.length} teams extracted (had ${old}); not replacing`);
    sources = trial;
    list = [...list.filter(t => t.source !== key), ...fresh];
    return fresh.length;
  };

  // 1. Known guides
  for (const [key, source] of Object.entries(sources)) {
    try {
      const { status, text: html } = await fetchText(source.url);
      if (status === 404) { report.warnings.push(`${source.guide} guide is gone (404): ${source.url}`); continue; }
      const text = htmlToText(html);
      const section = teamsSection(text);
      if (!section) { report.warnings.push(`${source.guide} guide: couldn't find its Teams section`); continue; }
      const version = guideVersion(text), h = hash(section), prev = guides[key];
      if (!prev) { guides[key] = { version, hash: h, checked: today() }; continue; } // first run: record a baseline
      guides[key] = { ...prev, checked: today() };
      if (prev.hash === h) continue;
      if (!apiKey) {
        // Report each change once; it's picked up automatically once an API key is added.
        if (prev.pendingHash !== h) report.changedNoKey.push(`${source.guide} (${prev.version || "?"} → ${version || "?"})`);
        guides[key].pendingHash = h;
        continue;
      }
      const n = await applyGuide(key, { ...source, version }, section);
      guides[key] = { version, hash: h, checked: today() };
      report.updated.push(`${source.guide}: ${n} teams${version ? ` (updated for ${version})` : ""}`);
    } catch (e) {
      report.warnings.push(`${source.guide} guide: ${e.message}`);
    }
    await sleep(1500);
  }

  // 2. New guides for characters that don't have one yet (a few per run, each re-checked every two weeks).
  const covered = new Set(Object.values(sources).map(s => s.character));
  const addGuide = async (c, url, text, section) => {
    const version = guideVersion(text);
    const n = await applyGuide(c.id, { character: c.id, guide: c.name, url, version }, section);
    guides[c.id] = { version, hash: hash(section), checked: today() };
    covered.add(c.id);
    delete pending[c.id];
    report.added.push(`${c.name}: ${n} teams from ${url}`);
  };
  if (apiKey) {
    for (const [id, url] of Object.entries(pending).slice(0, PROBES_PER_RUN)) {
      const c = characters.find(x => x.id === id);
      if (!c || covered.has(id)) { delete pending[id]; continue; }
      try {
        const { status, text: html } = await fetchText(url);
        await sleep(1500);
        if (status !== 200) { delete pending[id]; continue; }
        const text = htmlToText(html), section = teamsSection(text);
        if (!section) { delete pending[id]; continue; }
        await addGuide(c, url, text, section);
      } catch (e) {
        report.warnings.push(`${c.name} guide: ${e.message}`);
      }
    }
  }
  const due = characters
    .filter(c => !covered.has(c.id) && !pending[c.id] && !c.id.startsWith("traveler") && c.element !== "varies")
    .filter(c => !probes[c.id] || (now - new Date(probes[c.id])) / 86400000 >= PROBE_EVERY_DAYS)
    .sort((a, b) => (probes[a.id] || "").localeCompare(probes[b.id] || ""))
    .slice(0, PROBES_PER_RUN);
  for (const c of due) {
    probes[c.id] = today();
    const slugs = [...new Set([c.id, slugify(c.name.split(" ").pop()), c.name.toLowerCase().replace(/[^a-z]+/g, "-")])];
    for (const slug of slugs) {
      try {
        const url = GUIDE_URL(slug);
        const { status, text: html } = await fetchText(url);
        await sleep(1500);
        if (status !== 200) continue;
        const text = htmlToText(html);
        const section = teamsSection(text);
        if (!section || !text.toLowerCase().includes(c.name.split(" ").pop().toLowerCase())) continue;
        if (!apiKey) {
          if (!pending[c.id]) report.newGuidesNoKey.push(`${c.name}: ${url}`);
          pending[c.id] = url;
          break;
        }
        await addGuide(c, url, text, section);
        break;
      } catch (e) {
        report.warnings.push(`${c.name} guide: ${e.message}`);
        break;
      }
    }
  }

  return { teams: { sources, teams: list }, meta: { ...meta, guides, guideProbes: probes, pendingGuides: pending }, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readAll, writeTeams, writeMeta } = await import("./lib/data-io.mjs");
  const data = await readAll();
  const { teams, meta, report } = await updateTeams(data);
  await writeTeams(teams);
  await writeMeta({ ...meta, teamsChecked: today() });
  console.log(JSON.stringify(report, null, 2));
}
