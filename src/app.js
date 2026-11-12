// Page wiring: roster picker, team results, screenshot import.
import { db, ELEMENTS, fetchDb, nameOf } from "./db.js";
import { findTeams, teamHasChar, teamCountFor } from "./teams.js";
import { getSample, canReadImages, aiErrorMessage, rankTeams, suggestTeam, readScreenshotsWithClaude } from "./claude.js";
import { readScreenshotsLocally } from "./ocr.js";

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const elVar = el => `var(--${el})`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const STORE_KEY = "gtf-roster-v1";
const EXAMPLE_ROSTER = {
  "traveler-anemo": 0, "traveler-geo": 0, "traveler-electro": 0, "traveler-dendro": 0, "traveler-hydro": 0, "traveler-pyro": 0,
  amber: 6, kaeya: 6, lisa: 6, xiangling: 6, bennett: 5, xingqiu: 6, fischl: 6, sucrose: 6, beidou: 4, noelle: 6, chongyun: 4, collei: 6,
  kirara: 3, kuki: 4, aino: 2, lanyan: 3, kachina: 4, iansan: 2, ororon: 1, chevreuse: 3, layla: 4, yaoyao: 2, dahlia: 1, charlotte: 2,
  rosaria: 2, neuvillette: 0, furina: 0, kazuha: 0, zhongli: 0, nahida: 0, xilonen: 0, ineffa: 0, columbina: 0, mavuika: 0, citlali: 0,
  escoffier: 0, jean: 1, mona: 1, diluc: 0, qiqi: 0, keqing: 1, tighnari: 0, dehya: 0, yelan: 0, flins: 0,
};

const state = { roster: {}, isExample: false, filterEl: null, ownedOnly: false, query: "", candidates: [] };

// ---------- roster storage ----------
function loadRoster() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { state.roster = JSON.parse(raw) || {}; state.isExample = false; return; }
  } catch (e) { /* storage unavailable: fall through to the example */ }
  state.roster = Object.fromEntries(Object.entries(EXAMPLE_ROSTER).filter(([id]) => db.byId[id]));
  state.isExample = true;
}
function saveRoster() {
  state.isExample = false;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.roster)); } catch (e) { /* keep working without storage */ }
}

// ---------- roster panel ----------
function renderFilters() {
  const box = $("#el-filters");
  box.innerHTML = ["all", ...ELEMENTS].map(e => {
    const pressed = (e === "all" && !state.filterEl) || e === state.filterEl;
    const label = e === "all" ? "All" : `<span class="dot" style="--el:${elVar(e)}"></span>${e[0].toUpperCase() + e.slice(1)}`;
    return `<button type="button" class="fchip" data-el="${e}" aria-pressed="${pressed}">${label}</button>`;
  }).join("");
  box.querySelectorAll("button").forEach(b => {
    b.onclick = () => { state.filterEl = b.dataset.el === "all" ? null : b.dataset.el; renderFilters(); renderGrid(); };
  });
}

function renderGrid() {
  const q = state.query.trim().toLowerCase();
  const list = db.characters
    .filter(c => !state.filterEl || c.element === state.filterEl)
    .filter(c => !state.ownedOnly || state.roster[c.id] !== undefined)
    .filter(c => !q || c.name.toLowerCase().includes(q) || (c.aliases || []).some(a => a.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  $("#grid").innerHTML = list.map(c => {
    const on = state.roster[c.id] !== undefined, cons = on ? state.roster[c.id] : 0;
    return `<div class="char ${on ? "on" : ""}" style="--el:${elVar(c.element)}">
      <button type="button" class="tog" data-id="${c.id}" aria-pressed="${on}" title="${esc(c.name)} · ${c.rarity}★ ${c.element} ${c.weapon}"><span class="dot ${c.rarity === 5 ? "star5" : ""}"></span><span class="n">${esc(c.name)}</span></button>
      <button type="button" class="cons" data-id="${c.id}" aria-label="${esc(c.name)} constellation C${cons}, click to change">C${cons}</button>
    </div>`;
  }).join("") || `<p class="note">No characters match.</p>`;
  $("#grid").querySelectorAll(".tog").forEach(b => {
    b.onclick = () => {
      const id = b.dataset.id;
      if (state.roster[id] !== undefined) delete state.roster[id]; else state.roster[id] = 0;
      saveRoster(); refreshAll();
    };
  });
  $("#grid").querySelectorAll(".cons").forEach(b => {
    b.onclick = () => { const id = b.dataset.id; state.roster[id] = ((state.roster[id] || 0) + 1) % 7; saveRoster(); refreshAll(); };
  });
  $("#owned-count").textContent = `${Object.keys(state.roster).filter(id => db.byId[id]).length} of ${db.characters.length} owned`;
}

// ---------- results panel ----------
function renderAnchor() {
  const sel = $("#anchor");
  const prev = sel.value;
  const owned = Object.keys(state.roster).filter(id => db.byId[id]).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (!owned.length) { sel.innerHTML = `<option value="">Mark some characters first</option>`; sel.disabled = true; return; }
  sel.disabled = false;
  const withTeams = owned.filter(id => db.teams.some(t => teamHasChar(t, id)));
  const without = owned.filter(id => !withTeams.includes(id));
  const opt = id => `<option value="${id}">${esc(nameOf(id))}</option>`;
  sel.innerHTML = `<option value="">Choose a character…</option><optgroup label="Has teams">${withTeams.map(opt).join("")}</optgroup>` +
    (without.length ? `<optgroup label="No teams yet">${without.map(opt).join("")}</optgroup>` : "");
  sel.value = owned.includes(prev) ? prev : "";
}

function memberCard(id, opts, slotIdx, anchor, reason, picks) {
  const c = db.byId[id];
  const alts = opts ? opts[slotIdx].map(o => o.id).filter(x => x !== id && !picks.includes(x)) : [];
  return `<div class="mem ${id === anchor ? "anchor" : ""}" style="--el:${elVar(c.element)}">
    <span class="nm">${esc(c.name)}</span>
    <span class="meta">${c.rarity}★ ${c.element} · C${state.roster[id] ?? 0}</span>
    ${reason ? `<span class="why">${esc(reason)}</span>` : ""}
    ${alts.length ? `<span class="alt">Or: ${alts.slice(0, 3).map(nameOf).map(esc).join(", ")}</span>` : ""}
  </div>`;
}

function sourceLine(team) {
  const s = db.sources[team.src];
  if (!s) return "";
  const version = (db.meta.guides && db.meta.guides[team.src] && db.meta.guides[team.src].version) || s.version;
  return `<span class="src">Source: <a href="${esc(s.url)}">${esc(s.guide)} guide</a>${version ? ` (updated for ${esc(version)})` : ""}</span>`;
}

function teamTitle(arch, ids) { return `${esc(arch)} · ${ids.map(nameOf).map(esc).join(", ")}`; }

function renderResults() {
  const anchor = $("#anchor").value;
  $("#example-note").classList.toggle("hidden", !state.isExample);
  $("#ai-results").innerHTML = "";
  $("#ai-status").textContent = "";
  if (!anchor) {
    state.candidates = [];
    $("#summary").innerHTML = ""; $("#almost").innerHTML = "";
    $("#ai-box").classList.add("hidden"); $("#teams-label").classList.add("hidden");
    $("#results").innerHTML = Object.keys(state.roster).length
      ? `<div class="empty"><p><strong>Pick a character above</strong> to see the best teams you can build for them.</p></div>`
      : `<div class="empty"><p><strong>Start by marking the characters you own.</strong> Then pick one above to see the teams you can build.</p></div>`;
    return;
  }
  const { ready, almost } = findTeams(anchor, state.roster);
  state.candidates = ready.slice(0, 8).map((r, i) => ({ ...r, key: "c" + (i + 1) }));
  const total = teamCountFor(anchor);
  $("#summary").innerHTML = `<span><strong>${ready.length}</strong> ${ready.length === 1 ? "team" : "teams"} you can build</span><span><strong>${total}</strong> ${total === 1 ? "team includes" : "teams include"} ${esc(nameOf(anchor))}</span>`;
  $("#teams-label").classList.toggle("hidden", !ready.length);

  $("#results").innerHTML = ready.slice(0, 12).map((r, i) => `<article class="team">
      <div class="team-head"><h3>${teamTitle(r.team.arch, r.picks)}</h3>
        <span class="row">${i === 0 ? `<span class="tag best">Top match</span>` : ""}${r.team.limited ? `<span class="tag">Budget</span>` : ""}</span></div>
      <div class="members">${r.picks.map((id, s) => memberCard(id, r.opts, s, anchor, "", r.picks)).join("")}</div>
      <p class="note">${esc(r.team.note)}</p>${sourceLine(r.team)}
    </article>`).join("") + (ready.length > 12 ? `<p class="note">${ready.length - 12} more teams match. They use lower-ranked options.</p>` : "");

  if (!ready.length) {
    $("#ai-box").classList.add("hidden");
    const none = total === 0;
    $("#results").innerHTML = `<div class="empty">
      <p><strong>${none ? `There are no teams for ${esc(nameOf(anchor))} in this site's data yet.` : `None of the ${total} teams with ${esc(nameOf(anchor))} can be filled from your roster.`}</strong></p>
      <p class="note">${none ? "New guides are added automatically once they're published." : "See the teams below that are one character away."}</p>
      <div class="row ai-only"><button type="button" class="btn primary" id="fallback-btn">Ask Claude for a team</button></div>
      <p class="status" id="fallback-status" role="status" aria-live="polite"></p>
      <div id="fallback-out" class="teams"></div></div>`;
    $("#fallback-btn").onclick = () => runFallback(anchor);
  } else {
    $("#ai-box").classList.remove("hidden");
    $("#ai-text").textContent = `Want a short explanation of each pick? Claude can rank your top ${state.candidates.length} teams for ${nameOf(anchor)} and say what each teammate does.`;
  }

  const close = almost.slice(0, 4);
  $("#almost").innerHTML = close.length ? `<p class="section-label">One character away</p>` + close.map(r => {
    const need = r.need.map(o => nameOf(o.id) + (o.minC ? ` (C${o.minC})` : "")).filter((v, i, a) => a.indexOf(v) === i);
    return `<article class="team">
      <div class="team-head"><h3>${esc(r.team.arch)} with ${r.picks.filter(Boolean).map(nameOf).map(esc).join(", ")}</h3></div>
      <p class="need">Missing: <b>${need.map(esc).join(" or ")}</b></p>
      <p class="note">${esc(r.team.note)}</p>${sourceLine(r.team)}
    </article>`;
  }).join("") : "";
}

function refreshAll() { renderGrid(); renderAnchor(); renderResults(); }

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function renderFreshness() {
  const m = db.meta || {};
  const parts = [];
  if (m.charactersUpdated) parts.push(`Characters updated ${formatDate(m.charactersUpdated)}`);
  if (m.teamsChecked) parts.push(`teams checked ${formatDate(m.teamsChecked)}`);
  $("#freshness").textContent = parts.join(" · ");
  const latest = [m.charactersChecked, m.teamsChecked].filter(Boolean).sort().pop();
  $("#freshness-top").textContent = latest ? `Data checked ${formatDate(latest)}` : "";
}

// ---------- Claude ----------
async function runRank() {
  const anchor = $("#anchor").value, btn = $("#ai-btn"), st = $("#ai-status");
  if (!state.candidates.length) return;
  btn.disabled = true; st.classList.remove("err"); st.textContent = "Asking Claude…";
  try {
    const result = await rankTeams(anchor, state.roster, state.candidates);
    if ($("#anchor").value !== anchor) return;
    $("#ai-results").innerHTML = `<p class="section-label">Claude's picks for your roster</p>` + result.map((r, i) => {
      const picks = r.members.map(m => m.id);
      return `<article class="team ai">
        <div class="team-head"><h3>${teamTitle(r.cand.team.arch, picks)}</h3><span class="tag best">#${i + 1}</span></div>
        ${r.summary ? `<p class="note">${esc(r.summary)}</p>` : ""}
        <div class="members">${r.members.map(m => memberCard(m.id, r.cand.opts, m.slot - 1, anchor, m.reason, picks)).join("")}</div>
        ${sourceLine(r.cand.team)}
      </article>`;
    }).join("");
    st.textContent = "Explanations are written by Claude from the team data. Check the linked guide for rotations.";
  } catch (e) {
    st.classList.add("err");
    st.textContent = aiErrorMessage(e, "Claude's answer didn't match your roster, so it wasn't shown. The teams below are still accurate.");
  } finally { btn.disabled = false; }
}

async function runFallback(anchor) {
  const st = $("#fallback-status"), out = $("#fallback-out"), btn = $("#fallback-btn");
  btn.disabled = true; st.classList.remove("err"); st.textContent = "Asking Claude…";
  try {
    const v = await suggestTeam(anchor, state.roster);
    if (!v) { st.textContent = `Claude doesn't know ${nameOf(anchor)}'s kit well enough to suggest a team yet.`; return; }
    const picks = v.members.map(m => m.id);
    out.innerHTML = `<article class="team ai">
      <div class="team-head"><h3>AI suggestion · ${picks.map(nameOf).map(esc).join(", ")}</h3><span class="tag">Not from a guide</span></div>
      ${v.summary ? `<p class="note">${esc(v.summary)}</p>` : ""}
      <div class="members">${v.members.map(m => memberCard(m.id, null, 0, anchor, m.reason, picks)).join("")}</div>
    </article>`;
    st.textContent = "Written by Claude from your roster, not taken from a guide. Treat it as a starting point.";
  } catch (e) {
    st.classList.add("err");
    st.textContent = aiErrorMessage(e, "Claude's answer didn't match your roster, so it wasn't shown.");
  } finally { btn.disabled = false; }
}

// ---------- screenshot import ----------
let importing = false;
async function importShots(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith("image/"));
  if (!files.length || importing) return;
  importing = true;
  const st = $("#import-status");
  st.classList.remove("err");
  const setStatus = t => { st.textContent = t; };
  if (state.isExample) state.roster = {};
  try {
    if (await canReadImages()) {
      const r = await readScreenshotsWithClaude(files, state.roster, setStatus);
      setStatus(`Found ${plural(r.seen.size, "character")} (${r.added} new). Check the list and fix anything that's wrong.` +
        (r.unknown.length ? ` Not recognised: ${r.unknown.slice(0, 5).join(", ")}.` : ""));
    } else {
      const r = await readScreenshotsLocally(files, state.roster, setStatus);
      if (!r.seen.size) {
        setStatus("No character names found. Use a screenshot that shows names, like your HoYoLAB character list, or mark characters below.");
      } else {
        setStatus(`Found ${plural(r.seen.size, "character")} (${r.added} new). ` +
          (r.cardMode ? `Constellations were read from the badges (${r.withConstellation} above C0). ` : "Constellations aren't read from this kind of screenshot, so set them with the C badges. ") +
          "Check the list and fix anything it missed." + (r.traveler ? " Tick the Traveler elements you've unlocked." : ""));
      }
    }
  } catch (e) {
    st.classList.add("err");
    st.textContent = e.userMessage || aiErrorMessage(e, "Couldn't read that screenshot. Try a clearer one, or mark characters below.");
  } finally {
    importing = false;
    saveRoster();
    refreshAll();
  }
}

// ---------- start ----------
function wire() {
  $("#anchor").onchange = renderResults;
  $("#search").oninput = e => { state.query = e.target.value; renderGrid(); };
  $("#f-owned").onclick = e => { state.ownedOnly = !state.ownedOnly; e.currentTarget.setAttribute("aria-pressed", state.ownedOnly); renderGrid(); };
  $("#clear-roster").onclick = () => { state.roster = {}; saveRoster(); refreshAll(); $("#import-status").textContent = "Roster cleared."; };
  $("#ai-btn").onclick = runRank;
  $("#shots").onchange = e => { importShots(e.target.files); e.target.value = ""; };
  const drop = $("#drop");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); importShots(e.dataTransfer.files); });
  document.addEventListener("paste", e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith("image/"));
    if (files.length) importShots(files);
  });
}

async function start() {
  wire();
  try {
    await fetchDb();
  } catch (e) {
    document.body.classList.remove("loading");
    $("#results").innerHTML = `<div class="empty"><p><strong>Couldn't load the character data.</strong> Check your connection and refresh the page.</p></div>`;
    return;
  }
  loadRoster();
  renderFilters();
  renderFreshness();
  refreshAll();
  document.body.classList.remove("loading");
  // Outside claude.ai there is no Claude: hide its buttons and explain how import works there.
  getSample().then(s => {
    if (s) return;
    document.body.classList.add("no-ai");
    $("#drop-text").innerHTML = "<strong>Import from screenshots.</strong> Upload or paste screenshots of your HoYoLAB character list. Names and constellations are read in your browser and never uploaded. Check the list afterwards and fix anything it missed.";
  });
}

start();
