import { readAll } from "../scripts/lib/data-io.mjs";
import { loadDb } from "../src/db.js";

export async function loadRealData() {
  const data = await readAll();
  loadDb(data);
  return data;
}

// Replaces global fetch for one test. `routes` maps a predicate or URL substring to a response factory.
export function mockFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, respond] of routes) {
      if (typeof match === "function" ? match(u, init) : u.includes(match)) {
        const r = await respond(u, init);
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return new Response(body, { status: r.status || 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
