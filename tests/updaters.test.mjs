import { test } from "node:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers.mjs";
import { parseInfobox, characterFromInfobox, findExisting, updateCharacters } from "../scripts/update-characters.mjs";
import { htmlToText, teamsSection, guideVersion, updateTeams } from "../scripts/update-teams.mjs";

const CHARS = [
  { id: "neuvillette", name: "Neuvillette", element: "hydro", weapon: "catalyst", rarity: 5 },
  { id: "furina", name: "Furina", element: "hydro", weapon: "sword", rarity: 5 },
  { id: "kazuha", name: "Kazuha", element: "anemo", weapon: "sword", rarity: 5, aliases: ["Kaedehara Kazuha"] },
  { id: "xilonen", name: "Xilonen", element: "geo", weapon: "sword", rarity: 5 },
  { id: "zhongli", name: "Zhongli", element: "geo", weapon: "polearm", rarity: 5 },
  { id: "flins", name: "Flins", element: "electro", weapon: "polearm", rarity: 5 },
];
const NOW = new Date("2026-11-12T12:00:00Z");

test("wiki infobox is read, and unreleased characters are flagged", () => {
  const f = parseInfobox("{{Character Infobox\n|rarity = 5\n|element = Electro\n|weapon = Catalyst\n|releaseDate = November 4, 2026<ref>x</ref>\n}}");
  assert.deepEqual(characterFromInfobox(f, NOW), { element: "electro", weapon: "catalyst", rarity: 5, released: true });
  assert.equal(characterFromInfobox({ ...f, releasedate: "December 16, 2026" }, NOW).released, false);
  assert.equal(characterFromInfobox({ ...f, element: "Fire" }, NOW), null);
});

test("wiki titles match existing characters by name, alias or surname", () => {
  assert.equal(findExisting("Kaedehara Kazuha", CHARS).id, "kazuha");
  assert.equal(findExisting("Kyryll Chudomirovich Flins", CHARS).id, "flins");
  assert.equal(findExisting("Mitya", CHARS), null);
});

test("character update adds released characters only", async () => {
  const page = (date, el = "Electro") => `{{Character Infobox\n|rarity = 5\n|element = ${el}\n|weapon = Catalyst\n|releaseDate = ${date}\n}}`;
  const titles = [...CHARS.map(c => c.name), "Mitya", "Future Person"];
  const m = mockFetch([
    [u => u.includes("list=categorymembers"), () => ({ body: { query: { categorymembers: titles.map(title => ({ title })) } } })],
    [u => u.includes("prop=revisions"), () => ({ body: { query: { pages: [
      { title: "Mitya", revisions: [{ slots: { main: { content: page("November 4, 2026") } } }] },
      { title: "Future Person", revisions: [{ slots: { main: { content: page("January 6, 2027") } } }] },
    ] } } })],
  ]);
  try {
    const { characters, report } = await updateCharacters(CHARS, { now: NOW });
    assert.deepEqual(report.added, ["Mitya"]);
    assert.deepEqual(characters.at(-1), { id: "mitya", name: "Mitya", element: "electro", weapon: "catalyst", rarity: 5 });
  } finally { m.restore(); }
});

test("character update refuses a suspiciously short list", async () => {
  const m = mockFetch([[u => u.includes("list=categorymembers"), () => ({ body: { query: { categorymembers: [{ title: "Furina" }] } } })]]);
  try { await assert.rejects(updateCharacters(CHARS, { now: NOW })); } finally { m.restore(); }
});

const guide = teams => `<h1>Neuvillette Quick Guide</h1><p>Updated for Version 7.2</p><h2>Talents</h2><p>t</p><h2>Teams</h2><p>${teams}</p><h2>Weapons</h2><p>w</p>`;

test("guide text: teams section and version are found", () => {
  const text = htmlToText(guide("Neuvillette / Kazuha / Furina / Xilonen"));
  assert.equal(guideVersion(text), "7.2");
  assert.match(teamsSection(text), /^## Teams\n/);
  assert.doesNotMatch(teamsSection(text), /Weapons/);
});

function teamData() {
  return {
    characters: CHARS,
    teams: {
      sources: { neuvillette: { character: "neuvillette", guide: "Neuvillette", url: "https://keqingmains.com/q/neuvillette-quickguide/", version: null } },
      teams: [{ source: "neuvillette", archetype: "Hypercarry", slots: [["neuvillette"], ["kazuha"], ["furina"], ["xilonen", "zhongli"]], note: "Old note." }],
    },
    meta: { guides: {}, guideProbes: Object.fromEntries(CHARS.map(c => [c.id, "2026-11-11"])) },
  };
}

test("first run records a baseline without touching teams", async () => {
  const m = mockFetch([["neuvillette-quickguide", () => ({ body: guide("A") })]]);
  try {
    const { teams, meta, report } = await updateTeams(teamData(), { apiKey: "", now: NOW });
    assert.equal(teams.teams.length, 1);
    assert.equal(meta.guides.neuvillette.version, "7.2");
    assert.deepEqual(report.changedNoKey, []);
  } finally { m.restore(); }
});

test("a changed guide is reported when there's no API key", async () => {
  const d = teamData();
  d.meta.guides.neuvillette = { version: "7.1", hash: "old", checked: "2026-11-01" };
  const m = mockFetch([["neuvillette-quickguide", () => ({ body: guide("B") })]]);
  try {
    const { teams, report } = await updateTeams(d, { apiKey: "", now: NOW });
    assert.equal(teams.teams[0].note, "Old note.");
    assert.equal(report.changedNoKey.length, 1);
  } finally { m.restore(); }
});

test("a changed guide is re-extracted with Claude, and bad extractions are refused", async () => {
  const run = async reply => {
    const d = teamData();
    d.meta.guides.neuvillette = { version: "7.1", hash: "old", checked: "2026-11-01" };
    const m = mockFetch([
      ["neuvillette-quickguide", () => ({ body: guide("C") })],
      ["api.anthropic.com", () => ({ body: { content: [{ type: "text", text: JSON.stringify(reply) }] } })],
    ]);
    try { return await updateTeams(d, { apiKey: "test-key", now: NOW }); } finally { m.restore(); }
  };
  const good = await run({ teams: [{ archetype: "Hypercarry", slots: [["neuvillette"], ["kazuha"], ["furina"], ["zhongli", "xilonen"]], note: "New note." }] });
  assert.equal(good.teams.teams[0].note, "New note.");
  assert.equal(good.meta.guides.neuvillette.version, "7.2");
  assert.equal(good.report.updated.length, 1);

  const bad = await run({ teams: [{ archetype: "Hypercarry", slots: [["neuvillette"], ["madeup"], ["furina"], ["zhongli"]], note: "x" }] });
  assert.equal(bad.teams.teams[0].note, "Old note.");
  assert.match(bad.report.warnings.join(" "), /failed checks/);
});

test("without an API key, each change or new guide is reported once, then picked up when a key is added", async () => {
  const d = teamData();
  d.meta.guides.neuvillette = { version: "7.1", hash: "old", checked: "2026-11-01" };
  d.meta.guideProbes.furina = "2026-01-01"; // due for a check
  const routes = [
    ["neuvillette-quickguide", () => ({ body: guide("D") })],
    ["furina-quickguide", () => ({ body: guide("Furina / Neuvillette").replace(/Neuvillette Quick/, "Furina Quick") })],
  ];
  let m = mockFetch(routes);
  let first;
  try { first = await updateTeams(d, { apiKey: "", now: NOW }); } finally { m.restore(); }
  assert.equal(first.report.changedNoKey.length, 1);
  assert.equal(first.report.newGuidesNoKey.length, 1);
  assert.ok(first.meta.pendingGuides.furina);

  m = mockFetch(routes);
  let second;
  try { second = await updateTeams({ ...d, meta: first.meta }, { apiKey: "", now: NOW }); } finally { m.restore(); }
  assert.deepEqual([second.report.changedNoKey, second.report.newGuidesNoKey], [[], []]);

  m = mockFetch([...routes, ["api.anthropic.com", (u, init) => {
    const furina = JSON.parse(init.body).messages[0].content.includes('"furina"');
    const slots = furina ? [["furina"], ["neuvillette"], ["kazuha"], ["zhongli"]] : [["neuvillette"], ["kazuha"], ["furina"], ["zhongli"]];
    return { body: { content: [{ type: "text", text: JSON.stringify({ teams: [{ archetype: "Test", slots, note: "n" }] }) }] } };
  }]]);
  let third;
  try { third = await updateTeams({ ...d, meta: second.meta }, { apiKey: "k", now: NOW }); } finally { m.restore(); }
  assert.equal(third.report.updated.length, 1);
  assert.equal(third.report.added.length, 1);
  assert.ok(third.teams.sources.furina);
  assert.deepEqual(third.meta.pendingGuides, {});
});
