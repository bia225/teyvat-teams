// Runs every updater, checks the result, and writes data/*.json only if everything is valid.
// Writes a Markdown summary to $REPORT_FILE (used by the workflow to open an issue when something needs a look).
import { writeFile, appendFile } from "node:fs/promises";
import { readAll, writeCharacters, writeTeams, writeMeta, today } from "./lib/data-io.mjs";
import { updateCharacters } from "./update-characters.mjs";
import { updateTeams } from "./update-teams.mjs";
import { validateData } from "./validate-data.mjs";

const data = await readAll();
const lines = [];
const attention = [];
let characters = data.characters, meta = { ...data.meta, charactersChecked: today() };

try {
  const r = await updateCharacters(characters);
  characters = r.characters;
  if (r.report.added.length) {
    meta.charactersUpdated = today();
    lines.push(`New characters: ${r.report.added.join(", ")}`);
  }
  for (const w of r.report.warnings) attention.push(`Characters: ${w}`);
} catch (e) {
  attention.push(`Character update failed: ${e.message}`);
}

const t = await updateTeams({ characters, teams: data.teams, meta });
meta = { ...t.meta, teamsChecked: today() };
const r = t.report;
if (r.updated.length) lines.push("Updated guides:\n" + r.updated.map(x => `- ${x}`).join("\n"));
if (r.added.length) lines.push("New guides:\n" + r.added.map(x => `- ${x}`).join("\n"));
if (r.changedNoKey.length) attention.push("These guides changed, but teams can't be updated automatically without the ANTHROPIC_API_KEY secret:\n" + r.changedNoKey.map(x => `  - ${x}`).join("\n"));
if (r.newGuidesNoKey.length) attention.push("New guides were found, but they can't be added automatically without the ANTHROPIC_API_KEY secret:\n" + r.newGuidesNoKey.map(x => `  - ${x}`).join("\n"));
for (const w of r.warnings) attention.push(`Teams: ${w}`);

const next = { characters, teams: t.teams, meta };
const errors = validateData(next);
if (errors.length) {
  attention.push("The updated data failed its checks, so nothing was saved:\n" + errors.slice(0, 20).map(e => `  - ${e}`).join("\n"));
} else {
  await writeCharacters(characters);
  await writeTeams(t.teams);
  await writeMeta(meta);
}

const summary = [
  lines.length ? lines.join("\n\n") : "No new characters or team changes.",
  attention.length ? "\n**Needs attention**\n\n" + attention.map(a => `- ${a}`).join("\n") : "",
].join("\n");
console.log(summary);
if (process.env.REPORT_FILE) await writeFile(process.env.REPORT_FILE, summary + "\n");
// "Significant" = something other than the last-checked dates changed (the workflow commits those weekly only).
const stripChecks = m => JSON.stringify({ ...m, charactersChecked: 0, teamsChecked: 0,
  guides: Object.fromEntries(Object.entries(m.guides || {}).map(([k, v]) => [k, { ...v, checked: 0 }])) });
const significant = !errors.length && (JSON.stringify(characters) !== JSON.stringify(data.characters) ||
  JSON.stringify(t.teams) !== JSON.stringify(data.teams) || stripChecks(meta) !== stripChecks(data.meta));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `attention=${attention.length ? "true" : "false"}\nsignificant=${significant}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Data update\n\n${summary}\n`);
if (errors.length) process.exit(1);
