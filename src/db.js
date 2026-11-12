// Game data, loaded from data/*.json at startup and shared by every module.

export const ELEMENTS = ["pyro", "hydro", "anemo", "electro", "dendro", "cryo", "geo"];

export const db = {
  characters: [], // [{ id, name, element, weapon, rarity, aliases? }]
  byId: {},
  teams: [],      // parsed teams, see loadDb
  sources: {},    // guide id -> { character, guide, url, version }
  meta: {},       // freshness info written by the updaters
};

// "mona@1" -> { id: "mona", minC: 1 }
export function parseOption(text) {
  const [id, c] = text.split("@");
  return { id, minC: c ? Number(c) : 0 };
}

export function loadDb({ characters, teams, meta = {} }) {
  db.characters = characters;
  db.byId = Object.fromEntries(characters.map(c => [c.id, c]));
  db.sources = teams.sources;
  const order = {};
  db.teams = teams.teams.map((t, i) => ({
    id: "t" + i,
    src: t.source,
    arch: t.archetype,
    note: t.note,
    limited: !!t.budget,
    order: (order[t.source] = (order[t.source] ?? -1) + 1), // position within its guide
    slots: t.slots.map(slot => slot.map(parseOption)),
  }));
  db.meta = meta;
  return db;
}

export async function fetchDb(base = new URL("../data/", import.meta.url)) {
  const get = async name => {
    const res = await fetch(new URL(name, base), { cache: "no-cache" });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json();
  };
  const [characters, teams, meta] = await Promise.all([get("characters.json"), get("teams.json"), get("meta.json")]);
  return loadDb({ characters, teams, meta });
}

export const nameOf = id => (db.byId[id] ? db.byId[id].name : id);
