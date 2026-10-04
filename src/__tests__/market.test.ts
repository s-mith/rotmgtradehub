import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type OfferWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { resetRateLimits } from "../ratelimit";
import { listEventsFor } from "../events";
import { covers, setWatch } from "../watch";
import { linkCodeFor, person } from "./people";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null, discord: null });
  vi.stubEnv("ADMIN_EMAILS", "");
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const form = (path: string, fields: Record<string, string>, cookie?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
const page = async (path: string, cookie: string) => (await app.request(path, { headers: { cookie } })).text();
/** A settings form posts to /me and lands back on its settings section: the page it lands on. */
const landed = async (res: Response, cookie: string) => {
  expect(res.headers.get("location")).toMatch(/^\/me\?settings_(ok|error)=.*#settings$/);
  return (await app.request(res.headers.get("location")!, { headers: { cookie } })).text();
};

/** An account with one linked node that has heartbeat once (so it is online), and a signer. */
async function linked(email: string, name: string, bots: { ign: string; seasonal: boolean }[] = [{ ign: `${name}Bot`, seasonal: false }]) {
  const who = person(db, email, name);
  const kp = generateNodeKeypair();
  const r = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(r.status).toBe(200);
  const nodeId = r.body.nodeId as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    return json(await app.request(path, { method, headers: { "content-type": "application/json", ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) }, body: body === undefined ? undefined : raw }));
  };
  await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0.0.2.0", bots: bots.map((b) => ({ ...b, online: true })) });
  const item = (ref: string, itemId: string, count = 0) => ({ ref, itemId, enchants: count ? Array.from({ length: count }, (_, i) => 100 + i) : null, count });
  const offer = async (give: { ref: string; itemId: string; count?: number }[], want: { itemId: string; qty: number; slotsMin?: number }[], seasonal = false, server = "USEast") => {
    const r = await call("POST", "/api/v1/offers", { botIgn: bots[0].ign, seasonal, server, give: give.map((g) => item(g.ref, g.itemId, g.count ?? 0)), want: want.map((w) => ({ itemId: w.itemId, qty: w.qty, slotsMin: w.slotsMin ?? 0, slotsExact: null, enchants: [] })) });
    expect(r.status).toBe(200);
    return r.body.offer as OfferWire;
  };
  const seen = (ago: number) => db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now() - ago, nodeId);
  return { ...who, nodeId, call, offer, seen, item };
}

describe("trading seen from the hub", () => {
  it("an offer names the poster's bot only to the poster's own node; the taker learns it from the meeting", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    const o = await a.offer([{ ref: "a1", itemId: "dbow" }], [{ itemId: "plife", qty: 1 }]);
    const theirs = ((await b.call("GET", "/api/v1/offers")).body.offers as OfferWire[]).find((x) => x.id === o.id)!;
    expect(theirs).toMatchObject({ botIgn: "", poster: "Alice", mine: false });
    const own = ((await a.call("GET", "/api/v1/offers")).body.offers as OfferWire[]).find((x) => x.id === o.id)!;
    expect(own).toMatchObject({ botIgn: "AliceBot", mine: true });
    // Accepted: now Bob's node is told whom to meet.
    const rv = (await b.call("POST", `/api/v1/offers/${o.id}/accept`, { botIgn: "BobBot", items: [b.item("b1", "plife")] })).body.rendezvous as RendezvousWire;
    expect(rv.partner.botIgn).toBe("AliceBot");
  });

  it("a display name is the person's to pick, and nobody else's", async () => {
    const a = person(db, "a@x.test", "Alice");
    person(db, "b@x.test", "Bob");
    const set = async (name: string) => landed(await form("/me", { do: "name", name }, a.cookie), a.cookie);
    expect(await set("bob")).toContain("Someone else already goes by that name.");
    expect(await set("x")).toContain("2-24 letters");
    expect(await set("<script>")).toContain("2-24 letters");
    expect(await set("  Night   Owl ")).toContain("You go by Night Owl now.");
    expect((db.prepare("SELECT display_name FROM users WHERE id = ?").get(a.id) as { display_name: string }).display_name).toBe("Night Owl");
    // Keeping one's own name in another case is fine.
    expect(await set("night owl")).toContain("You go by night owl now.");
  });

  it("a cross tells both posters, and watchers hear when someone gives or wants their item", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    const w = person(db, "w@x.test", "Wren");
    setWatch(db, w.id, "dbow", "give", true);
    await a.offer([{ ref: "a1", itemId: "dbow" }], [{ itemId: "plife", qty: 2 }]);
    expect(listEventsFor(db, w.id, 5)[0]).toMatchObject({ kind: "watch", text: expect.stringContaining("Alice is giving Doom Bow for 2× Potion of Life") });
    expect(listEventsFor(db, a.id, 5).some((e) => e.kind === "watch")).toBe(false);
    // Bob posts the mirror: both hear of the cross.
    await b.offer([{ ref: "b1", itemId: "plife" }, { ref: "b2", itemId: "plife" }], [{ itemId: "dbow", qty: 1 }]);
    expect(listEventsFor(db, a.id, 5)[0]).toMatchObject({ kind: "cross", text: expect.stringContaining("Bob gives 2× Potion of Life for Doom Bow") });
    expect(listEventsFor(db, b.id, 5)[0]).toMatchObject({ kind: "cross", text: expect.stringContaining("Alice gives Doom Bow for 2× Potion of Life") });
    // An ask with an enchant floor is not covered by a plain item.
    expect(covers([a.item("x", "dbow", 0)], [{ itemId: "dbow", qty: 1, slotsMin: 2, slotsExact: null, enchants: [] }])).toBe(false);
    expect(covers([a.item("x", "dbow", 2)], [{ itemId: "dbow", qty: 1, slotsMin: 2, slotsExact: null, enchants: [] }])).toBe(true);
  });
});
