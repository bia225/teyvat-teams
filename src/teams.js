// Team matching: which guide teams can this roster build around a chosen character?
import { db } from "./db.js";

export function teamHasChar(team, id) {
  return team.slots.some(slot => slot.some(o => o.id === id));
}

// Owned options for one slot, in the guide's order. `rank` is the position in the guide's list.
export function ownedOptions(slot, roster) {
  const seen = new Set(), out = [];
  slot.forEach((o, rank) => {
    if (roster[o.id] !== undefined && roster[o.id] >= o.minC && !seen.has(o.id)) {
      seen.add(o.id);
      out.push({ id: o.id, rank });
    }
  });
  return out;
}

// One distinct character per slot (anchor included), going as little down the guide's lists as possible.
export function bestAssignment(slotOpts, anchor) {
  let best = null, bestCost = Infinity;
  const pick = [], used = new Set();
  (function go(i, cost) {
    if (cost >= bestCost) return;
    if (i === slotOpts.length) {
      if (used.has(anchor)) { best = pick.slice(); bestCost = cost; }
      return;
    }
    for (const o of slotOpts[i]) {
      if (used.has(o.id)) continue;
      used.add(o.id); pick[i] = o;
      go(i + 1, cost + o.rank);
      used.delete(o.id);
    }
  })(0, 0);
  return best ? { picks: best, cost: bestCost } : null;
}

// ready: teams the roster can build now. almost: teams missing exactly one slot.
export function findTeams(anchor, roster) {
  const ready = [], almost = [];
  for (const t of db.teams) {
    if (!teamHasChar(t, anchor)) continue;
    const opts = t.slots.map(s => ownedOptions(s, roster));
    const missing = opts.map((o, i) => (o.length ? -1 : i)).filter(i => i >= 0);
    const base = t.order * 0.15 + (t.limited ? 2 : 0);
    if (missing.length === 0) {
      const a = bestAssignment(opts, anchor);
      if (!a) continue;
      const picks = a.picks.map(p => p.id);
      // A team built around the chosen character beats one where they fill a support slot.
      const lead = picks[0] === anchor ? 0 : 0.5;
      ready.push({ team: t, picks, opts, score: a.cost + base + lead });
    } else if (missing.length === 1) {
      const keep = opts.filter((_, i) => i !== missing[0]);
      const a = bestAssignment(keep, anchor);
      if (!a) continue;
      const picks = []; let k = 0;
      opts.forEach((_, i) => picks.push(i === missing[0] ? null : a.picks[k++].id));
      almost.push({ team: t, picks, opts, missingSlot: missing[0], need: t.slots[missing[0]], score: a.cost + base });
    }
  }
  const dedupe = list => {
    const seen = new Set();
    return list.sort((a, b) => a.score - b.score).filter(r => {
      const key = r.picks.filter(Boolean).slice().sort().join(",") + "|" + (r.missingSlot ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return { ready: dedupe(ready), almost: dedupe(almost) };
}

export function teamCountFor(anchor) {
  return db.teams.filter(t => teamHasChar(t, anchor)).length;
}

// Checks Claude's ranking against the candidates we sent. Throws on anything invented.
export function validateAi(value, cands, anchor) {
  if (!value || !Array.isArray(value.teams) || value.teams.length < 1 || value.teams.length > 3) throw new Error("expected 1 to 3 teams");
  const byKey = Object.fromEntries(cands.map(c => [c.key, c]));
  const seenTeams = new Set();
  return value.teams.map(t => {
    const c = byKey[t.id];
    if (!c) throw new Error("unknown team " + t.id);
    if (seenTeams.has(t.id)) throw new Error("duplicate team");
    seenTeams.add(t.id);
    if (!Array.isArray(t.members) || t.members.length !== 4) throw new Error("team needs 4 members");
    const used = new Set(), slotsUsed = new Set();
    const members = t.members.map(m => {
      const { slot, id } = m;
      if (!Number.isInteger(slot) || slot < 1 || slot > 4 || slotsUsed.has(slot)) throw new Error("bad slot");
      if (!c.opts[slot - 1].some(o => o.id === id)) throw new Error(id + " is not an owned option for slot " + slot);
      if (used.has(id)) throw new Error(id + " used twice");
      if (typeof m.reason !== "string" || !m.reason.trim() || m.reason.length > 200) throw new Error("bad reason");
      used.add(id); slotsUsed.add(slot);
      return { slot, id, reason: m.reason.trim() };
    }).sort((a, b) => a.slot - b.slot);
    if (!used.has(anchor)) throw new Error("anchor missing");
    const summary = typeof t.summary === "string" ? t.summary.trim().slice(0, 300) : "";
    return { cand: c, members, summary };
  });
}

// Checks Claude's free suggestion (no guide team available). Returns null if Claude said it doesn't know.
export function validateFallback(value, roster, anchor) {
  if (!value || value.unknown) return null;
  if (!Array.isArray(value.members) || value.members.length !== 4) throw new Error("team needs 4 members");
  const used = new Set();
  const members = value.members.map(m => {
    if (!db.byId[m.id] || roster[m.id] === undefined) throw new Error((m.id || "?") + " is not owned");
    if (used.has(m.id)) throw new Error("duplicate member");
    if (typeof m.reason !== "string" || !m.reason.trim() || m.reason.length > 200) throw new Error("bad reason");
    used.add(m.id);
    return { id: m.id, reason: m.reason.trim() };
  });
  if (!used.has(anchor)) throw new Error("anchor missing");
  return { members, summary: typeof value.summary === "string" ? value.summary.trim().slice(0, 300) : "" };
}
