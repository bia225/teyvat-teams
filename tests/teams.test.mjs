import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadRealData } from "./helpers.mjs";
import { findTeams, validateAi, validateFallback } from "../src/teams.js";
import { db } from "../src/db.js";

const ROSTER = {
  neuvillette: 0, furina: 0, kazuha: 0, xilonen: 0, zhongli: 0, bennett: 6, xiangling: 6, xingqiu: 6, fischl: 6, sucrose: 6,
  mavuika: 0, citlali: 0, kachina: 4, iansan: 2, rosaria: 1, escoffier: 0, ineffa: 0, columbina: 0, lauma: 0, nahida: 0,
};

before(loadRealData);

test("every suggested team is buildable: 4 distinct owned characters including the anchor", () => {
  const all = Object.fromEntries(db.characters.map(c => [c.id, 6]));
  for (const c of db.characters) {
    for (const r of findTeams(c.id, all).ready) {
      assert.equal(new Set(r.picks).size, 4, `${c.id}: ${r.picks}`);
      assert.ok(r.picks.includes(c.id));
    }
  }
});

test("teams built around the chosen character come first", () => {
  const { ready } = findTeams("neuvillette", ROSTER);
  assert.ok(ready.length > 0);
  assert.equal(ready[0].picks[0], "neuvillette");
  assert.deepEqual(ready[0].picks, ["neuvillette", "kazuha", "furina", "xilonen"]);
});

test("constellation requirements are respected", () => {
  const team = r => r.team.slots.some(s => s.some(o => o.id === "rosaria" && o.minC === 2));
  assert.ok(!findTeams("mavuika", { mavuika: 0, kachina: 0, rosaria: 1, bennett: 0 }).ready.some(team));
  assert.ok(findTeams("mavuika", { mavuika: 0, kachina: 0, rosaria: 2, bennett: 0 }).ready.some(team));
});

test("teams one character short are reported with what's missing", () => {
  const { ready, almost } = findTeams("neuvillette", { neuvillette: 0, kazuha: 0, furina: 0 });
  assert.equal(ready.length, 0);
  assert.ok(almost.length > 0);
  assert.ok(almost.every(a => a.picks.filter(Boolean).length === 3 && a.need.length > 0));
});

test("Claude's ranking is rejected when it invents anything", () => {
  const cands = findTeams("neuvillette", ROSTER).ready.slice(0, 8).map((r, i) => ({ ...r, key: "c" + (i + 1) }));
  const members = cands[0].picks.map((id, i) => ({ slot: i + 1, id, reason: "Does a job." }));
  assert.equal(validateAi({ teams: [{ id: "c1", members }] }, cands, "neuvillette").length, 1);
  const bad = [
    { teams: [{ id: "c99", members }] },
    { teams: [{ id: "c1", members: members.map((m, i) => (i === 1 ? { ...m, id: "venti" } : m)) }] },
    { teams: [{ id: "c1", members: members.map((m, i) => (i === 1 ? { ...m, id: "neuvillette" } : m)) }] },
    { teams: [{ id: "c1", members: members.slice(0, 3) }] },
    { teams: [] },
  ];
  for (const v of bad) assert.throws(() => validateAi(v, cands, "neuvillette"));
});

test("Claude's free suggestion must use owned characters", () => {
  const ok = ["neuvillette", "furina", "kazuha", "zhongli"].map(id => ({ id, reason: "r" }));
  assert.equal(validateFallback({ members: ok }, ROSTER, "neuvillette").members.length, 4);
  assert.equal(validateFallback({ unknown: true }, ROSTER, "neuvillette"), null);
  assert.throws(() => validateFallback({ members: ok.map((m, i) => (i === 3 ? { ...m, id: "venti" } : m)) }, ROSTER, "neuvillette"));
});
