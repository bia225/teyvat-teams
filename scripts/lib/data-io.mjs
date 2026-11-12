// Reading and writing data/*.json in a stable, diff-friendly format (one record per line).
import { readFile, writeFile } from "node:fs/promises";

export const DATA_DIR = new URL("../../data/", import.meta.url);
export const ELEMENTS = ["pyro", "hydro", "anemo", "electro", "dendro", "cryo", "geo"];
export const WEAPONS = ["sword", "claymore", "polearm", "bow", "catalyst"];

export const today = () => new Date().toISOString().slice(0, 10);

export async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, DATA_DIR), "utf8"));
}

export async function readAll() {
  const [characters, teams, meta] = await Promise.all([readJson("characters.json"), readJson("teams.json"), readJson("meta.json")]);
  return { characters, teams, meta };
}

export function formatCharacters(characters) {
  return "[\n" + characters.map(c => "  " + JSON.stringify(c)).join(",\n") + "\n]\n";
}

export function formatTeams({ sources, teams }) {
  const src = JSON.stringify(sources, null, 2).replace(/\n/g, "\n  ");
  const list = teams.map(t => "    " + JSON.stringify(t)).join(",\n");
  return `{\n  "sources": ${src},\n  "teams": [\n${list}\n  ]\n}\n`;
}

export async function writeCharacters(characters) {
  await writeFile(new URL("characters.json", DATA_DIR), formatCharacters(characters));
}
export async function writeTeams(teams) {
  await writeFile(new URL("teams.json", DATA_DIR), formatTeams(teams));
}
export async function writeMeta(meta) {
  await writeFile(new URL("meta.json", DATA_DIR), JSON.stringify(meta, null, 2) + "\n");
}

// "Lan Yan" -> "lanyan", "Kamisato Ayaka" -> "kamisatoayaka"
export const slugify = s => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

export const USER_AGENT = "teyvat-teams-updater/1.0 (+https://github.com/bia225/teyvat-teams)";

export async function fetchText(url, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" }, redirect: "follow" });
      if (res.status === 404) return { status: 404, text: "" };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text: await res.text() };
    } catch (e) {
      if (attempt >= retries) throw new Error(`${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
