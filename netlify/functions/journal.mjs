// Receives trade events from the MT5 EA and serves them to your web app.
// Storage: Netlify Blobs (built in, no database to set up).
// Netlify env var required:  JOURNAL_KEY  (same value as the EA's JournalKey input)
import { getStore } from "@netlify/blobs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*",
               "access-control-allow-headers": "content-type,x-api-key" },
  });

export default async (req) => {
  if (req.method === "OPTIONS") return json({});
  const expected = (process.env.JOURNAL_KEY ?? "").trim();
  if (!expected)
    return json({ error: "JOURNAL_KEY is not set on the server. Add it in Netlify > Environment variables (scope: Functions), then redeploy." }, 500);
  if ((req.headers.get("x-api-key") ?? "").trim() !== expected)
    return json({ error: "unauthorized: wrong key" }, 401);

  const store = getStore("journal");
  const notes = getStore("notes");        // journal notes, one per trade (key = account_id)

  // ---- EA -> web app -------------------------------------------------
  if (req.method === "POST") {
    let e;
    try { e = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (e.event === "edit") {                                // change any field of any trade (EA, imported or typed)
      if (!e.key || typeof e.fields !== "object") return json({ error: "missing fields" }, 400);
      const t = await store.get(e.key, { type: "json" });
      if (!t) return json({ error: "trade not found" }, 404);
      const allowed = ["symbol", "side", "lots", "entry", "sl", "tp", "exit", "opened_at", "closed_at", "net", "r", "peak_r",
        "reach_r", "reached", "reached_at", "reason", "trigger", "g1_line", "g1_tf", "g1_kind", "g1_level", "g1_mode", "g1_target",
        "risk", "status", "currency"];
      for (const k of allowed) if (k in e.fields) t[k] = e.fields[k];
      t.edited = true;
      t.edited_at = Math.floor(Date.now() / 1000);
      await store.setJSON(e.key, t);
      return json({ ok: true });
    }
    if (e.event === "note") {                                // journal notes typed in the web app
      if (!e.key || typeof e.note !== "object") return json({ error: "missing fields" }, 400);
      await notes.setJSON(e.key, { ...e.note, updated_at: Math.floor(Date.now() / 1000) });
      return json({ ok: true });
    }
    if (e.event === "manual") {                              // trade typed in by hand in the web app
      if (!e.symbol || !e.side || !e.id) return json({ error: "missing fields" }, 400);
      // history sync / MT5 import: skip positions the EA already journaled live
      if (e.mt5_account && e.mt5_position && (await store.get(`${e.mt5_account}_${e.mt5_position}`)))
        return json({ ok: true, skipped: true });
      const { event, ...rec } = e;
      rec.account = "manual"; rec.source = "manual"; rec.closes = rec.closes ?? [];
      await store.setJSON(`manual_${e.id}`, rec);
      return json({ ok: true });
    }
    if (!e.id || !e.account || !["open", "close"].includes(e.event))
      return json({ error: "missing fields" }, 400);

    const key = `${e.account}_${e.id}`;                      // one record per position
    const t = (await store.get(key, { type: "json" })) ?? { id: e.id, account: e.account, closes: [], status: "open" };

    if (e.event === "open") {
      const { event, ...open } = e;
      Object.assign(t, open);
    } else {
      // dedupe by deal ticket so a retry never double counts
      if (!t.closes.some((c) => c.deal === e.deal)) {
        const { event, ...c } = e;
        t.closes.push(c);
      }
      t.symbol ??= e.symbol; t.side ??= e.side; t.entry ??= e.entry;
      t.net = +t.closes.reduce((s, c) => s + c.net, 0).toFixed(2);
      // did price reach the R target (default 2R) at any point before the trade ended?
      t.peak_r = Math.max(t.peak_r ?? -Infinity, e.peak_r ?? -Infinity);
      if (!Number.isFinite(t.peak_r)) delete t.peak_r;
      t.reach_r = e.reach_r;
      t.reached = Boolean(t.reached || e.reached);
      t.reached_at = t.reached_at ?? e.reached_at ?? null;
      if (e.final) {
        t.status = "closed";
        t.closed_at = e.closed_at;
        t.exit = e.exit;
        t.reason = e.reason;
        t.r = e.r;
      }
    }
    await store.setJSON(key, t);
    return json({ ok: true });
  }

  // ---- web app -> reads the journal -----------------------------------
  if (req.method === "GET") {
    const { blobs } = await store.list();
    const trades = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    const { blobs: nb } = await notes.list();
    const nm = {};
    await Promise.all(nb.map(async (b) => { nm[b.key] = await notes.get(b.key, { type: "json" }); }));
    trades.forEach((t) => { const j = nm[`${t.account}_${t.id}`]; if (j) t.journal = j; });
    trades.sort((a, b) => (b.opened_at ?? b.closed_at ?? 0) - (a.opened_at ?? a.closed_at ?? 0));
    return json({ trades });
  }

  // ---- delete a manual trade (EA trades cannot be deleted) -------------
  if (req.method === "DELETE") {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!key.startsWith("manual_")) return json({ error: "only manual trades can be deleted" }, 400);
    await store.delete(key);
    await notes.delete(key);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/journal" };
