import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type CommonsItemWire, type CommonsListingWire, type CommonsStatusWire, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { getSettings, openDb, setSettings, type Db } from "../db";
import { createApp } from "../app";
import { register } from "../auth";
import { commonsOperatorView } from "../commons";
import { NODE_ONLINE_MS } from "../grants";
import { RENDEZVOUS_MS, sweepRendezvous } from "../offers";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db);
  vi.stubEnv("ADMIN_EMAILS", "boss@x.test");
});

type Reply = { status: number; body: Record<string, unknown> };
const json = async (res: Response): Promise<Reply> => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

/** Register a user, link one node, heartbeat once so it counts as online, and return a signer for every method. */
async function linked(email: string, name: string) {
  register(db, email, "correct horse battery", name);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery", publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  const bot = `${name}Bot`;
  expect((await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [{ ign: bot, seasonal: false, online: true }] })).status).toBe(200);
  return { nodeId, call, name, bot };
}

const citem = (ref: string, itemId: string, o: Partial<CommonsItemWire> = {}): CommonsItemWire =>
  ({ ref, itemId, name: `${itemId} name`, enchants: null, count: 0, seasonal: false, botIgn: "AliceBot", ...o });
const publish = (items: CommonsItemWire[]) => ({ items, at: Date.now() });
const receipt = (gave: { itemId: string; qty: number }[], got: { itemId: string; qty: number }[], partnerIgn: string, ok = true, extra: Partial<ReceiptWire> = {}): ReceiptWire =>
  ({ window: 0, ok, gave, gaveRefs: [], got, partnerIgn, at: Date.now(), ...extra });
const SWORD = [{ itemId: "Sword", qty: 1 }];
const refs = (items: unknown) => (items as CommonsListingWire[]).map((it) => it.ref);
const nodeRow = (id: string) => db.prepare("SELECT completed_swaps, frozen, frozen_reason, last_seen_at FROM nodes WHERE id = ?").get(id) as { completed_swaps: number; frozen: number; frozen_reason: string | null; last_seen_at: number | null };
const seenAt = (id: string, at: number | null) => db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(at, id);
const rvRow = (id: number) => db.prepare("SELECT offer_id, kind, state, reason, commons_node_id, commons_ref, taker_gives_json FROM rendezvous WHERE id = ?").get(id) as Record<string, unknown>;

/** Alice lists one Sword (s1) and one Ring (r1); Bob takes the Sword. */
async function taken() {
  const a = await linked("a@x.test", "Alice");
  const b = await linked("b@x.test", "Bob");
  expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword", { enchants: [3], count: 1 }), citem("r1", "Ring")]))).body).toEqual({ ok: true, listed: 2 });
  const w = await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" });
  expect(w.status).toBe(200);
  return { a, b, rv: w.body.rendezvous as RendezvousWire };
}

const form = (path: string, fields: Record<string, string>, cookie?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
async function loginCookie(email: string): Promise<string> {
  const r = await form("/login", { email, password: "correct horse battery" });
  expect(r.status).toBe(302);
  return r.headers.get("set-cookie")!.split(";")[0];
}

describe("commons", () => {
  it("publish lists items every online node sees newest first with mine and contributor set, filtered by half; a republish replaces and keeps listed_at; shapes are checked", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword", { seasonal: true, enchants: [1, 2], count: 2 }), citem("r1", "Ring")]))).body).toEqual({ ok: true, listed: 2 });
    expect((await b.call("POST", "/api/v1/commons/publish", publish([citem("c1", "Cloak", { botIgn: "BobBot" })]))).body).toEqual({ ok: true, listed: 1 });

    const seenByA = await a.call("GET", "/api/v1/commons");
    expect(seenByA.status).toBe(200);
    expect((seenByA.body.items as CommonsListingWire[]).map((it) => [it.ref, it.mine, it.contributor, it.nodeId])).toEqual([["c1", false, "Bob", b.nodeId], ["r1", true, "Alice", a.nodeId], ["s1", true, "Alice", a.nodeId]]);
    expect((seenByA.body.items as CommonsListingWire[])[2]).toMatchObject({ itemId: "Sword", name: "Sword name", enchants: [1, 2], count: 2, seasonal: true, botIgn: "AliceBot" });
    expect(seenByA.body.status).toEqual({ dailyCap: 8, usedToday: 0, listed: 2 });
    expect((await b.call("GET", "/api/v1/commons")).body.status).toEqual({ dailyCap: 8, usedToday: 0, listed: 1 });
    expect(refs((await b.call("GET", "/api/v1/commons?seasonal=1")).body.items)).toEqual(["s1"]);
    expect(refs((await b.call("GET", "/api/v1/commons?seasonal=0")).body.items)).toEqual(["c1", "r1"]);
    const mine = await a.call("GET", "/api/v1/commons/mine");
    expect((mine.body.items as CommonsItemWire[]).map((it) => it.ref)).toEqual(["r1", "s1"]);
    expect(mine.body.items).toEqual([citem("r1", "Ring"), citem("s1", "Sword", { seasonal: true, enchants: [1, 2], count: 2 })]);
    expect(mine.body.status).toEqual({ dailyCap: 8, usedToday: 0, listed: 2 });

    // Shape problems are 400 and change nothing.
    const bad = async (items: unknown) => (await a.call("POST", "/api/v1/commons/publish", { items, at: Date.now() })).status;
    expect(await bad("nope")).toBe(400);
    expect(await bad([citem("bad ref!", "Sword")])).toBe(400);
    expect(await bad([citem("x", "Sword", { botIgn: "not a name" })])).toBe(400);
    expect(await bad([citem("x", "Sword", { count: 9 })])).toBe(400);
    expect(await bad([citem("x", "Sword", { enchants: ["a"] as unknown as number[] })])).toBe(400);
    expect(await bad([citem("x", "Sword", { seasonal: "yes" as unknown as boolean })])).toBe(400);
    expect(await bad([citem("x", "Sword", { name: "n".repeat(81) })])).toBe(400);
    expect(await bad([citem("x", "Sword"), citem("x", "Ring")])).toBe(400);
    expect(await bad([citem("x", "")])).toBe(400);
    expect((await a.call("GET", "/api/v1/commons/mine")).body.status).toMatchObject({ listed: 2 });

    // A republish replaces the listing; an item that stays keeps its listed_at (the board is ordered by it).
    db.prepare("UPDATE commons_items SET listed_at = 1000 WHERE node_id = ? AND ref = 'r1'").run(a.nodeId);
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("r1", "Ring", { count: 1, enchants: [7] }), citem("t1", "Tome")]))).body).toEqual({ ok: true, listed: 2 });
    expect(db.prepare("SELECT listed_at, count FROM commons_items WHERE node_id = ? AND ref = 'r1'").get(a.nodeId)).toEqual({ listed_at: 1000, count: 1 });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["t1", "c1", "r1"]);
    expect((await a.call("POST", "/api/v1/commons/publish", publish([]))).body).toEqual({ ok: true, listed: 0 });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["c1"]);
    // Unsigned requests never reach the board.
    expect((await app.request("/api/v1/commons")).status).toBe(401);
  });

  it("items of a contributor not seen within 3 minutes, never seen, or frozen are hidden, not deleted", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword")]));
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["s1"]);
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual([]);
    expect((await a.call("GET", "/api/v1/commons/mine")).body.status).toMatchObject({ listed: 1 });
    seenAt(a.nodeId, null);
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual([]);
    seenAt(a.nodeId, Date.now());
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["s1"]);
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(a.nodeId);
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual([]);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(a.nodeId);
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["s1"]);
  });

  it("withdraw makes a one-way commons rendezvous both sides see from their role and unlists the item; own items, unknown items, the cap, an offline contributor and a frozen taker are refused", async () => {
    const { a, b, rv } = await taken();
    expect(rv).toMatchObject({
      kind: "commons", offerId: null, commons: { nodeId: a.nodeId, ref: "s1" }, server: "USEast", seasonal: false, state: "meet",
      me: { role: "take", botIgn: "BobBot", gives: [], gets: [{ itemId: "Sword", qty: 1 }] },
      partner: { botIgn: "AliceBot", poster: "Alice" },
      reported: { mine: false, partner: false },
    });
    expect(rv.deadlineAt - rv.createdAt).toBe(RENDEZVOUS_MS);
    expect(rvRow(rv.id)).toEqual({ offer_id: null, kind: "commons", state: "meet", reason: null, commons_node_id: a.nodeId, commons_ref: "s1", taker_gives_json: "[]" });
    const mineA = (await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mineA).toHaveLength(1);
    expect(mineA[0]).toMatchObject({
      id: rv.id, kind: "commons", offerId: null, commons: { nodeId: a.nodeId, ref: "s1" },
      me: { role: "give", botIgn: "AliceBot", gives: [{ ref: "s1", itemId: "Sword", enchants: [3], count: 1 }], gets: [] },
      partner: { botIgn: "BobBot", poster: "Bob" },
    });
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[]).map((r) => [r.id, r.me.role])).toEqual([[rv.id, "take"]]);

    // Taken means unlisted for everyone, but still the contributor's as the hub holds it; a second taker gets 404.
    const c = await linked("c@x.test", "Cara");
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    expect(refs((await a.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    expect((await a.call("GET", "/api/v1/commons/mine")).body.status).toMatchObject({ listed: 2 });
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "nope", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: "n_nobody", ref: "r1", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    // Own item, bad fields.
    const own = await a.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "AliceBot" });
    expect(own.status).toBe(409);
    expect(own.body.error).toContain("own");
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "US East", botIgn: "CaraBot" })).status).toBe(400);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "Cara Bot" })).status).toBe(400);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "bad ref", server: "USEast", botIgn: "CaraBot" })).status).toBe(400);
    // A commons meeting in flight does not use up the taker's swap slot: Bob can still accept a swap offer.
    const offer = (await c.call("POST", "/api/v1/offers", { botIgn: "CaraBot", seasonal: false, server: "USEast", give: [{ ref: "g1", itemId: "Bow", enchants: null, count: 0 }], want: [{ itemId: "Ring", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }] })).body.offer as OfferWire;
    expect((await b.call("POST", `/api/v1/offers/${offer.id}/accept`, { botIgn: "BobBot", items: [{ ref: "t1", itemId: "Ring", enchants: null, count: 0 }] })).status).toBe(200);

    // The cap counts meetings under way and done ones: with a cap of 2, Bob's second take fills it, the third is refused, Cara is unaffected.
    setSettings(db, { commonsDailyCap: 2 });
    await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword"), citem("r1", "Ring"), citem("r2", "Ring"), citem("r3", "Ring")]));
    expect((await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).status).toBe(200);
    const capped = await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r2", server: "USEast", botIgn: "BobBot" });
    expect(capped.status).toBe(409);
    expect(capped.body.error).toContain("cap");
    expect((await b.call("GET", "/api/v1/commons")).body.status).toEqual({ dailyCap: 2, usedToday: 0, listed: 0 });
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r2", server: "EUWest", botIgn: "CaraBot" })).status).toBe(200);
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["r3"]);

    // Contributor offline or frozen: 409, and the item is not on the board anyway. Frozen taker: 409.
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    const off = await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" });
    expect(off).toMatchObject({ status: 409, body: { error: "contributor offline" } });
    seenAt(a.nodeId, Date.now());
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(a.nodeId);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(409);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(a.nodeId);
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(c.nodeId);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(409);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(c.nodeId);
    expect((await c.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(200);
    // A cap of 0 closes the commons to takers.
    setSettings(db, { commonsDailyCap: 0 });
    const d = await linked("d@x.test", "Dan");
    await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword"), citem("r1", "Ring"), citem("r2", "Ring"), citem("r3", "Ring"), citem("r4", "Ring")]));
    expect((await d.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r4", server: "USEast", botIgn: "DanBot" })).status).toBe(409);
  });

  it("matching receipts close a hand-over: done, usedToday counts it, the listing is gone, attestations recorded, no completedSwaps", async () => {
    const { a, b, rv } = await taken();
    const first = await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORD, [], "BobBot", true, { gaveRefs: ["s1"] }));
    expect(first.body).toEqual({ ok: true, state: "meet" });
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0].reported).toEqual({ mine: false, partner: true });
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], SWORD, "AliceBot"))).body).toEqual({ ok: true, state: "done" });

    expect((await b.call("GET", "/api/v1/commons")).body.status).toEqual({ dailyCap: 8, usedToday: 1, listed: 0 });
    const mineA = await a.call("GET", "/api/v1/commons/mine");
    expect((mineA.body.items as CommonsItemWire[]).map((it) => it.ref)).toEqual(["r1"]);
    expect(mineA.body.status).toEqual({ dailyCap: 8, usedToday: 0, listed: 1 });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(db.prepare("SELECT node_id, bot_ign, by_node_id FROM attestations ORDER BY bot_ign").all()).toEqual([
      { node_id: a.nodeId, bot_ign: "AliceBot", by_node_id: b.nodeId },
      { node_id: b.nodeId, bot_ign: "BobBot", by_node_id: a.nodeId },
    ]);
    const done = ((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(done).toMatchObject({ id: rv.id, kind: "commons", state: "done", commons: { nodeId: a.nodeId, ref: "s1" }, reported: { mine: true, partner: true } });
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "late" })).status).toBe(409);
    expect(commonsOperatorView(db)).toEqual({ listed: 1, contributors: 1, handovers: 1 });
    // A stranger cannot report on it.
    const c = await linked("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "X"))).status).toBe(404);
  });

  it("a failed receipt, an abort or the deadline relist the item and do not count against the cap", async () => {
    setSettings(db, { commonsDailyCap: 1 });
    const { a, b, rv } = await taken();
    expect((await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).status).toBe(409); // the meeting under way fills a cap of 1
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "", false, { error: "contributor never showed" }))).body).toEqual({ ok: true, state: "failed" });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1", "s1"]);
    expect((await b.call("GET", "/api/v1/commons")).body.status).toEqual({ dailyCap: 1, usedToday: 0, listed: 0 });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });

    // Take it again; the contributor aborts this time.
    const rv2 = (await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    expect(rv2.id).not.toBe(rv.id);
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    expect((await a.call("POST", `/api/v1/rendezvous/${rv2.id}/abort`, { reason: "bot crashed" })).body).toEqual({ ok: true, state: "aborted" });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1", "s1"]);

    // A third time, and let the clock run out.
    const rv3 = (await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    sweepRendezvous(db, rv3.deadlineAt - 1);
    expect(rvRow(rv3.id)).toMatchObject({ state: "meet" });
    sweepRendezvous(db, rv3.deadlineAt);
    expect(rvRow(rv3.id)).toMatchObject({ state: "failed", reason: "deadline passed" });
    expect(refs((await b.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1", "s1"]);
    const rv4 = await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" });
    expect(rv4.status).toBe(200);
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[]).map((r) => [r.id, r.state])).toEqual([[(rv4.body.rendezvous as RendezvousWire).id, "meet"], [rv3.id, "failed"], [rv2.id, "aborted"], [rv.id, "failed"]]);
    expect(commonsOperatorView(db)).toEqual({ listed: 2, contributors: 1, handovers: 0 });

    // An unconfirmed success claim at the deadline is a dispute, as for swaps.
    const rv4w = rv4.body.rendezvous as RendezvousWire;
    expect((await a.call("POST", `/api/v1/rendezvous/${rv4w.id}/receipt`, receipt(SWORD, [], "BobBot"))).body.state).toBe("meet");
    sweepRendezvous(db, rv4w.deadlineAt);
    expect(rvRow(rv4w.id)).toMatchObject({ state: "disputed" });
    expect(nodeRow(b.nodeId).frozen).toBe(1);
  });

  it("mismatched receipts, or a taker that handed something over, dispute the hand-over and freeze both nodes", async () => {
    const { a, b, rv } = await taken();
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORD, [{ itemId: "Ring", qty: 1 }], "BobBot"))).body.state).toBe("meet");
    const bad = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], SWORD, "AliceBot"));
    expect(bad.body).toEqual({ ok: true, state: "disputed" });
    expect(rvRow(rv.id)).toMatchObject({ state: "disputed", reason: expect.stringContaining("one-way") });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 1 });
    expect(nodeRow(b.nodeId).frozen_reason).toContain(`#${rv.id}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 0 });
    // The item was not taken as far as the hub knows, but a frozen contributor's listing is hidden; a frozen taker may not take.
    const c = await linked("c@x.test", "Cara");
    await c.call("POST", "/api/v1/commons/publish", publish([citem("k1", "Katana", { botIgn: "CaraBot" })]));
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["k1"]);
    expect((await b.call("POST", "/api/v1/commons/withdraw", { nodeId: c.nodeId, ref: "k1", server: "USEast", botIgn: "BobBot" })).status).toBe(409);
    expect((await a.call("GET", "/api/v1/commons/mine")).body.status).toMatchObject({ listed: 2 });

    // Plain disagreement between another pair: the taker says nothing arrived.
    const d = await linked("d@x.test", "Dan");
    const w = (await d.call("POST", "/api/v1/commons/withdraw", { nodeId: c.nodeId, ref: "k1", server: "USEast", botIgn: "DanBot" })).body.rendezvous as RendezvousWire;
    expect((await c.call("POST", `/api/v1/rendezvous/${w.id}/receipt`, receipt([{ itemId: "Katana", qty: 1 }], [], "DanBot"))).body.state).toBe("meet");
    expect((await d.call("POST", `/api/v1/rendezvous/${w.id}/receipt`, receipt([], [], "CaraBot"))).body).toEqual({ ok: true, state: "disputed" });
    expect(rvRow(w.id)).toMatchObject({ state: "disputed", reason: "the two receipts disagree on what changed hands" });
    expect(nodeRow(c.nodeId).frozen).toBe(1);
    expect(nodeRow(d.nodeId).frozen).toBe(1);

    // The operator sees both, with "commons" where a swap shows its offer.
    const reg = await form("/register", { name: "Boss", email: "boss@x.test", password: "correct horse battery" });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const admin = await (await app.request("/admin", { headers: { cookie } })).text();
    expect(admin).toContain("Disputed rendezvous");
    expect(admin).toContain("<td>commons</td>");
    expect(admin).toContain("Dan-desk");
  });

  it("a publish omitting an item someone is meeting for keeps it until the meeting closes", async () => {
    const { a, b, rv } = await taken();
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("r1", "Ring")]))).body).toEqual({ ok: true, listed: 2 });
    expect(((await a.call("GET", "/api/v1/commons/mine")).body.items as CommonsItemWire[]).map((it) => it.ref).sort()).toEqual(["r1", "s1"]);
    const c = await linked("c@x.test", "Cara");
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    // Publishing it again while met for updates it without touching the meeting.
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("r1", "Ring"), citem("s1", "Sword", { name: "Sword renamed" })]))).body).toEqual({ ok: true, listed: 2 });
    expect(rvRow(rv.id)).toMatchObject({ state: "meet" });
    expect(db.prepare("SELECT name FROM commons_items WHERE node_id = ? AND ref = 's1'").get(a.nodeId)).toEqual({ name: "Sword renamed" });
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("r1", "Ring")]))).body).toEqual({ ok: true, listed: 2 });
    // Once the meeting closes without a hand-over, the kept row is back on the board until the next publish drops it.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "no room" })).body).toEqual({ ok: true, state: "aborted" });
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1", "s1"]);
    expect((await a.call("POST", "/api/v1/commons/publish", publish([citem("r1", "Ring")]))).body).toEqual({ ok: true, listed: 1 });
    expect(refs((await c.call("GET", "/api/v1/commons")).body.items)).toEqual(["r1"]);
    // And a hand-over that completes takes the kept row with it.
    const rv2 = (await b.call("POST", "/api/v1/commons/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    expect((await a.call("POST", "/api/v1/commons/publish", publish([]))).body).toEqual({ ok: true, listed: 1 });
    await a.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], [], "BobBot"));
    expect((await b.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([], [{ itemId: "Ring", qty: 1 }], "AliceBot"))).body).toEqual({ ok: true, state: "done" });
    expect((await a.call("GET", "/api/v1/commons/mine")).body).toMatchObject({ items: [], status: { listed: 0 } });
  });

  it("website: /commons needs a session and lists the board read-only; the admin page shows the commons line and sets the daily cap", async () => {
    const a = await linked("a@x.test", "Alice");
    await a.call("POST", "/api/v1/commons/publish", publish([citem("s1", "Sword", { seasonal: true, count: 2, enchants: [1, 2] }), citem("r1", "Ring")]));
    expect((await app.request("/commons")).status).toBe(302);
    register(db, "guest@x.test", "correct horse battery", "Gwen");
    const cookie = await loginCookie("guest@x.test");
    expect(await (await app.request("/me", { headers: { cookie } })).text()).toContain('href="/commons"');
    const page = await app.request("/commons", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Sword name");
    expect(html).toContain("Ring name");
    expect(html).toContain("Alice");
    expect(html).toContain("seasonal");
    expect(html).toContain("online");
    expect(html).toContain("up to <b>8</b>");
    expect(html).not.toContain("<form");
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    expect(await (await app.request("/commons", { headers: { cookie } })).text()).toContain("Nothing is listed");

    // Admin: the line and the cap field; only 0..100 is taken.
    expect((await app.request("/admin", { headers: { cookie } })).status).toBe(403);
    const reg = await form("/register", { name: "Boss", email: "boss@x.test", password: "correct horse battery" });
    const boss = reg.headers.get("set-cookie")!.split(";")[0];
    const admin = await (await app.request("/admin", { headers: { cookie: boss } })).text();
    expect(admin).toContain("2 items listed by 1 node");
    expect(admin).toContain('name="commonsDailyCap"');
    expect(admin).toContain('value="8"');
    expect((await form("/admin/settings", { commonsDailyCap: "3" }, boss)).status).toBe(302);
    expect(getSettings(db).commonsDailyCap).toBe(3);
    expect((await a.call("GET", "/api/v1/commons/mine")).body.status).toMatchObject({ dailyCap: 3 });
    await form("/admin/settings", { commonsDailyCap: "200" }, boss);
    await form("/admin/settings", { commonsDailyCap: "lots" }, boss);
    await form("/admin/settings", { commonsDailyCap: "-1" }, boss);
    expect(getSettings(db).commonsDailyCap).toBe(3);
    expect((await form("/admin/settings", { commonsDailyCap: "5" })).status).toBe(403);
    expect(getSettings(db).commonsDailyCap).toBe(3);
  });

  it("a phase 3 database gets rendezvous rebuilt with a nullable offer_id and the new columns, rows and receipts intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-legacy-"));
    const file = path.join(dir, "hub.db");
    try {
      // Today's layout, then rendezvous put back the way phase 3 made it, with one swap and its two receipts.
      const seed = openDb(file);
      seed.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (1, 'a@x.test', 'A', 'x', 0)").run();
      seed.prepare("INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES ('n_a', 1, 'a', 'k', '0.1.0', 0), ('n_b', 1, 'b', 'k', '0.1.0', 0)").run();
      seed.prepare("INSERT INTO offers (id, node_id, bot_ign, seasonal, server, give_json, want_json, status, created_at, updated_at, expires_at) VALUES (1, 'n_a', 'A', 0, 'USEast', '[]', '[]', 'accepted', 0, 0, 1)").run();
      seed.exec(`DROP TABLE rendezvous;
        CREATE TABLE rendezvous (
          id INTEGER PRIMARY KEY,
          offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
          server TEXT NOT NULL, seasonal INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
          giver_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, giver_bot_ign TEXT NOT NULL, giver_gives_json TEXT NOT NULL,
          taker_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, taker_bot_ign TEXT NOT NULL, taker_gives_json TEXT NOT NULL,
          closed_at INTEGER, reason TEXT);
        CREATE INDEX rendezvous_state ON rendezvous (state, deadline_at);
        INSERT INTO rendezvous VALUES (7, 1, 'USEast', 0, 'done', 10, 20, 'n_a', 'A', '[]', 'n_b', 'B', '[]', 15, NULL);
        INSERT INTO receipts (rendezvous_id, node_id, window, ok, gave_json, gave_refs_json, got_json, partner_ign, at) VALUES (7, 'n_a', 0, 1, '[]', '[]', '[]', 'B', 15), (7, 'n_b', 0, 1, '[]', '[]', '[]', 'A', 15);`);
      expect((seed.pragma("table_info(rendezvous)") as { name: string; notnull: number }[]).find((c) => c.name === "offer_id")?.notnull).toBe(1);
      seed.close();

      const up = openDb(file);
      const cols = up.pragma("table_info(rendezvous)") as { name: string; notnull: number; dflt_value: string | null }[];
      expect(cols.find((c) => c.name === "offer_id")).toMatchObject({ notnull: 0 });
      expect(cols.find((c) => c.name === "kind")).toMatchObject({ notnull: 1, dflt_value: "'swap'" });
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["commons_node_id", "commons_ref"]));
      expect(up.prepare("SELECT id, offer_id, kind, state, closed_at, commons_ref FROM rendezvous").all()).toEqual([{ id: 7, offer_id: 1, kind: "swap", state: "done", closed_at: 15, commons_ref: null }]);
      expect(up.prepare("SELECT COUNT(*) AS n FROM receipts r JOIN rendezvous v ON v.id = r.rendezvous_id").get()).toEqual({ n: 2 });
      expect(up.pragma("foreign_key_check")).toEqual([]);
      expect(up.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(up.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rendezvous'").all()).toEqual([{ name: "rendezvous_state" }]);
      // The new shape takes a hand-over with no offer, still refuses a dangling one, and the cascade from offers survived the rebuild.
      up.prepare("INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json, commons_node_id, commons_ref) VALUES (NULL, 'commons', 'USEast', 0, 'meet', 0, 1, 'n_a', 'A', '[]', 'n_b', 'B', '[]', 'n_a', 's1')").run();
      expect(() => up.prepare("INSERT INTO rendezvous (offer_id, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json) VALUES (99, 'USEast', 0, 'meet', 0, 1, 'n_a', 'A', '[]', 'n_b', 'B', '[]')").run()).toThrow(/FOREIGN KEY/);
      up.prepare("DELETE FROM offers WHERE id = 1").run();
      expect(up.prepare("SELECT id, kind FROM rendezvous").all()).toEqual([{ id: 8, kind: "commons" }]);
      expect(up.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toEqual({ n: 0 });
      up.close();
      // Opening once more is a no-op.
      const again = openDb(file);
      expect(again.prepare("SELECT COUNT(*) AS n FROM rendezvous").get()).toEqual({ n: 1 });
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
