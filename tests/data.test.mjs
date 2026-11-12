import { test } from "node:test";
import assert from "node:assert/strict";
import { readAll } from "../scripts/lib/data-io.mjs";
import { validateData } from "../scripts/validate-data.mjs";

test("data files pass every check", async () => {
  const data = await readAll();
  assert.deepEqual(validateData(data), []);
});

test("every guide's teams include the guide's character", async () => {
  const { teams } = await readAll();
  for (const t of teams.teams) {
    const subject = teams.sources[t.source].character;
    assert.ok(t.slots.some(s => s.some(o => o.split("@")[0] === subject)), `${t.source} ${t.archetype}`);
  }
});

test("validator catches broken data", () => {
  const data = {
    characters: [{ id: "amber", name: "Amber", element: "pyro", weapon: "bow", rarity: 4 }, { id: "amber", name: "Amber 2", element: "fire", weapon: "bow", rarity: 3 }],
    teams: { sources: { amber: { character: "amber", guide: "Amber", url: "https://example.com" } },
      teams: [{ source: "amber", archetype: "Test", slots: [["amber"], ["nobody"], ["amber@9"]], note: "x" }] },
    meta: {},
  };
  const errors = validateData(data).join("\n");
  for (const expected of ["duplicate id", "bad element", "bad rarity", "exactly 4 slots"]) assert.match(errors, new RegExp(expected));
});
