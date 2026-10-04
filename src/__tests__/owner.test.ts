import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type GuestRequestWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { linkCodeFor, person as personOf } from "./people";
import { resetRateLimits } from "../ratelimit";
import { listEventsFor } from "../events";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null });
  vi.stubEnv("ADMIN_EMAILS", "");
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const form = (path: string, fields: Record<string, string>, cookie?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
async function person(email: string, name: string) {
  const p = personOf(db, email, name);
  return { cookie: p.cookie, id: p.id };
}
async function linked(email: string, name: string) {
  const kp = generateNodeKeypair();
  const r = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email, name), publicKey: kp.publicKeyPem, name, version: "0.1.0" }) }));
  expect(r.status).toBe(200);
  const nodeId = r.body.nodeId as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  // Every node here has heartbeat once so it counts as online.
  await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0.0.2.0", bots: [{ ign: `${name}Bot`, seasonal: false, online: true }] });
  return { nodeId, call };
}
const item = (ref: string, itemId: string, enchants: number[] | null = null) => ({ ref, itemId, enchants, count: enchants?.length ?? 0 });
const pending = async (n: { call: (m: string, p: string, b?: unknown) => Promise<{ body: Record<string, unknown> }> }) => (await n.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
const loc = (r: Response) => decodeURIComponent(r.headers.get("location")!);

describe("the owner acting from the hub", () => {
  it("a meeting under way shows on both owners' pages, and there is no offer board", async () => {
    const alice = await person("alice@x.test", "Alice");
    const bob = await person("bob@x.test", "Bob");
    const a = await linked("alice@x.test", "Alice");
    const b = await linked("bob@x.test", "Bob");
    const offer = (await b.call("POST", "/api/v1/offers", { botIgn: "BobBot", seasonal: false, server: "USEast", give: [item("b1", "plife")], want: [{ itemId: "pmana", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }] })).body.offer as { id: number };
    expect((await app.request("/board", { headers: { cookie: alice.cookie } })).status).toBe(404);
    expect(await (await app.request("/me", { headers: { cookie: alice.cookie } })).text()).not.toContain("Meetings under way");
    expect((await a.call("POST", `/api/v1/offers/${offer.id}/accept`, { botIgn: "AliceBot", items: [item("a1", "pmana")] })).status).toBe(200);
    for (const who of [alice, bob]) {
      const me = await (await app.request("/me", { headers: { cookie: who.cookie } })).text();
      expect(me).toContain("Meetings under way");
      expect(me).toContain("Swap on USEast");
    }
    expect(await (await app.request("/me", { headers: { cookie: bob.cookie } })).text()).toContain("AliceBot");
  });

  it("taking communism items with a node queues a communism-take per item naming the listed item; owners only, never your own", async () => {
    const alice = await person("alice@x.test", "Alice");
    const bob = await person("bob@x.test", "Bob");
    const cara = await person("cara@x.test", "Cara");
    const a = await linked("alice@x.test", "Alice");
    const b = await linked("bob@x.test", "Bob");
    await b.call("POST", "/api/v1/communism/publish", { at: 1, accounts: [{ ign: "BobBot", seasonal: false, slots: 8, free: 6, online: true }], items: [
      { ref: "k1", itemId: "wcinc", name: "Wine Cellar Incantation", enchants: null, count: 0, seasonal: false, botIgn: "BobBot" },
      { ref: "k2", itemId: "plife", name: "Potion of Life", enchants: null, count: 0, seasonal: false, botIgn: "BobBot" },
    ] });
    const page = await (await app.request("/communism?half=nonseasonal", { headers: { cookie: alice.cookie } })).text();
    expect(page).toContain("Wine Cellar Incantation");
    expect(page).toContain("take them with Alice");
    // Someone without a node sees the items but no node button.
    expect(await (await app.request("/communism?half=nonseasonal", { headers: { cookie: cara.cookie } })).text()).not.toContain("take them with");
    const take = await form("/communism/withdraw", { do: "take", taker: a.nodeId, node: b.nodeId, refs: "k1", server: "USWest4" }, alice.cookie);
    expect(take.headers.get("location")).toContain("/communism?ok=");
    const reqs = await pending(a);
    expect(reqs[0]).toMatchObject({ owner: true, kind: "communism-take", server: "USWest4", seasonal: false, refs: ["k1"], communism: { nodeId: b.nodeId, ref: "k1" } });
    // Bob taking his own, Cara with no node, and a stale ref are all refused.
    expect(loc(await form("/communism/withdraw", { do: "take", taker: b.nodeId, node: b.nodeId, refs: "k1", server: "USWest4" }, bob.cookie))).toContain("on this node already");
    expect(loc(await form("/communism/withdraw", { do: "take", taker: a.nodeId, node: b.nodeId, refs: "k1", server: "USWest4" }, cara.cookie))).toContain("only the node's owner");
    expect(loc(await form("/communism/withdraw", { do: "take", taker: a.nodeId, node: b.nodeId, refs: "gone", server: "USWest4" }, alice.cookie))).toContain("not listed");
    expect(loc(await form("/communism/withdraw", { do: "take", taker: a.nodeId, node: b.nodeId, server: "USWest4" }, alice.cookie))).toContain("at least one");
  });
});
