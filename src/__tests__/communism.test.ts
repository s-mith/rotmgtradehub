import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type CommunismAccountWire, type CommunismItemWire, type CommunismListingWire, type CommunismNodeWire, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { linkCodeFor, person } from "./people";
import { communismOperatorView, refsHash } from "../communism";
import { changesSince, currentRev, resetCommunismLive } from "../communismLive";
import { NODE_ONLINE_MS } from "../nodes";
import { RENDEZVOUS_MS, sweepRendezvous } from "../offers";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  resetCommunismLive();
  db = openDb(":memory:");
  app = createApp(db);
  vi.stubEnv("ADMIN_EMAILS", "boss@x.test");
});

type Reply = { status: number; body: Record<string, unknown> };
const json = async (res: Response): Promise<Reply> => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

/** Register a user, link one node, heartbeat once so it counts as online, and return a signer for every method. */
async function linked(email: string, name: string) {
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email, name), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
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

const citem = (ref: string, itemId: string, o: Partial<CommunismItemWire> = {}): CommunismItemWire =>
  ({ ref, itemId, name: `${itemId} name`, enchants: null, count: 0, seasonal: false, botIgn: "AliceBot", ...o });
const account = (ign: string, seasonal: boolean, slots = 8, free = slots, online = true): CommunismAccountWire => ({ ign, seasonal, slots, free, online });
const publish = (items: CommunismItemWire[], accounts: CommunismAccountWire[] = [account("AliceBot", false)]) => ({ items, accounts, at: Date.now() });
const NONE = { accounts: 0, slots: 0, free: 0 };
const receipt = (gave: { itemId: string; qty: number }[], got: { itemId: string; qty: number }[], partnerIgn: string, ok = true, extra: Partial<ReceiptWire> = {}): ReceiptWire =>
  ({ window: 0, ok, gave, gaveRefs: [], got, partnerIgn, at: Date.now(), ...extra });
const SWORD = [{ itemId: "Sword", qty: 1 }];
const refs = (items: unknown) => (items as CommunismListingWire[]).map((it) => it.ref);
const nodeRow = (id: string) => db.prepare("SELECT completed_swaps, frozen, frozen_reason, last_seen_at FROM nodes WHERE id = ?").get(id) as { completed_swaps: number; frozen: number; frozen_reason: string | null; last_seen_at: number | null };
const seenAt = (id: string, at: number | null) => db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(at, id);
const rvRow = (id: number) => db.prepare("SELECT offer_id, kind, state, reason, communism_node_id, communism_ref, taker_gives_json FROM rendezvous WHERE id = ?").get(id) as Record<string, unknown>;

/** Alice lists one Sword (s1) and one Ring (r1); Bob takes the Sword. */
async function taken() {
  const a = await linked("a@x.test", "Alice");
  const b = await linked("b@x.test", "Bob");
  expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { enchants: [3], count: 1 }), citem("r1", "Ring")]))).body).toMatchObject({ ok: true, listed: 2 });
  const w = await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" });
  expect(w.status).toBe(200);
  return { a, b, rv: w.body.rendezvous as RendezvousWire };
}

const form = (path: string, fields: Record<string, string>, cookie?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
async function loginCookie(email: string): Promise<string> {
  return person(db, email).cookie;
}

describe("communism", () => {
  it("publish lists accounts and items every online node sees, newest first with mine and node set, owners and other nodes' bots unsaid, filtered by half; the board's nodes carry room per half; a republish replaces and keeps listed_at; shapes are checked", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { seasonal: true, enchants: [1, 2], count: 2 }), citem("r1", "Ring")], [account("AliceBot", false, 8, 7), account("AliceSeas", true, 16, 15), account("AliceMore", true, 8, 8, false)]))).body).toMatchObject({ ok: true, listed: 2, accounts: 3 });
    expect((await b.call("POST", "/api/v1/communism/publish", publish([citem("c1", "Cloak", { botIgn: "BobBot" })], [account("BobBot", false, 8, 7)]))).body).toMatchObject({ ok: true, listed: 1, accounts: 1 });

    const seenByA = await a.call("GET", "/api/v1/communism");
    expect(seenByA.status).toBe(200);
    // Nobody is told who runs a node; a node sees its own bots' names and nobody else's (2026-09-25).
    expect((seenByA.body.items as CommunismListingWire[]).map((it) => [it.ref, it.mine, it.node, it.contributor, it.nodeId, it.botIgn])).toEqual([["c1", false, "Bob-desk", "", b.nodeId, ""], ["r1", true, "Alice-desk", "", a.nodeId, "AliceBot"], ["s1", true, "Alice-desk", "", a.nodeId, "AliceBot"]]);
    expect((seenByA.body.items as CommunismListingWire[])[2]).toMatchObject({ itemId: "Sword", name: "Sword name", enchants: [1, 2], count: 2, seasonal: true, botIgn: "AliceBot" });
    expect(JSON.stringify((await b.call("GET", "/api/v1/communism")).body)).not.toMatch(/AliceBot|"Alice"/);
    expect(seenByA.body.status).toEqual({ accounts: 3, slots: 32, free: 30, listed: 2 });
    expect(seenByA.body.nodes).toEqual([
      { nodeId: a.nodeId, name: "Alice-desk", owner: "", online: true, server: null, seasonal: { accounts: 2, slots: 24, free: 23 }, nonseasonal: { accounts: 1, slots: 8, free: 7 }, items: 2 },
      { nodeId: b.nodeId, name: "Bob-desk", owner: "", online: true, server: null, seasonal: NONE, nonseasonal: { accounts: 1, slots: 8, free: 7 }, items: 1 },
    ] satisfies CommunismNodeWire[]);
    expect((await b.call("GET", "/api/v1/communism")).body.status).toEqual({ accounts: 1, slots: 8, free: 7, listed: 1 });
    expect(refs((await b.call("GET", "/api/v1/communism?seasonal=1")).body.items)).toEqual(["s1"]);
    expect(refs((await b.call("GET", "/api/v1/communism?seasonal=0")).body.items)).toEqual(["c1", "r1"]);
    const mine = await a.call("GET", "/api/v1/communism/mine");
    expect((mine.body.items as CommunismItemWire[]).map((it) => it.ref)).toEqual(["r1", "s1"]);
    expect(mine.body.items).toEqual([citem("r1", "Ring"), citem("s1", "Sword", { seasonal: true, enchants: [1, 2], count: 2 })]);
    expect((mine.body.accounts as CommunismAccountWire[]).map((x) => x.ign)).toEqual(["AliceMore", "AliceSeas", "AliceBot"]);
    expect(mine.body.status).toEqual({ accounts: 3, slots: 32, free: 30, listed: 2 });

    // Shape problems are 400 and change nothing.
    const bad = async (items: unknown, accounts: unknown = []) => (await a.call("POST", "/api/v1/communism/publish", { items, accounts, at: Date.now() })).status;
    expect(await bad("nope")).toBe(400);
    expect(await bad([citem("bad ref!", "Sword")])).toBe(400);
    expect(await bad([citem("x", "Sword", { botIgn: "not a name" })])).toBe(400);
    expect(await bad([citem("x", "Sword", { count: 9 })])).toBe(400);
    expect(await bad([citem("x", "Sword", { enchants: ["a"] as unknown as number[] })])).toBe(400);
    expect(await bad([citem("x", "Sword", { seasonal: "yes" as unknown as boolean })])).toBe(400);
    expect(await bad([citem("x", "Sword", { name: "n".repeat(81) })])).toBe(400);
    expect(await bad([citem("x", "Sword"), citem("x", "Ring")])).toBe(400);
    expect(await bad([citem("x", "")])).toBe(400);
    expect(await bad([], "nope")).toBe(400);
    expect(await bad([], [{ ign: "bad name", seasonal: false, slots: 8, free: 8, online: true }])).toBe(400);
    expect(await bad([], [{ ign: "X", seasonal: false, slots: 8, free: 9, online: true }])).toBe(400);
    expect(await bad([], [{ ign: "X", seasonal: false, slots: -1, free: 0, online: true }])).toBe(400);
    expect(await bad([], [{ ign: "X", seasonal: "no", slots: 8, free: 8, online: true }])).toBe(400);
    expect(await bad([], [account("X", false), account("X", true)])).toBe(400);
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toEqual({ accounts: 3, slots: 32, free: 30, listed: 2 });

    // A republish replaces the listing; an item that stays keeps its listed_at (the board is ordered by it).
    db.prepare("UPDATE communism_items SET listed_at = 1000 WHERE node_id = ? AND ref = 'r1'").run(a.nodeId);
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("r1", "Ring", { count: 1, enchants: [7] }), citem("t1", "Tome")]))).body).toMatchObject({ ok: true, listed: 2 });
    expect(db.prepare("SELECT listed_at, count FROM communism_items WHERE node_id = ? AND ref = 'r1'").get(a.nodeId)).toEqual({ listed_at: 1000, count: 1 });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["t1", "c1", "r1"]);
    // Accounts are replaced too; a node with none left drops off the board's node list, though its items (if any) would stay.
    expect((await a.call("POST", "/api/v1/communism/publish", publish([], []))).body).toMatchObject({ ok: true, listed: 0, accounts: 0 });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["c1"]);
    expect(((await b.call("GET", "/api/v1/communism")).body.nodes as CommunismNodeWire[]).map((n) => n.nodeId)).toEqual([b.nodeId]);
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toEqual({ accounts: 0, slots: 0, free: 0, listed: 0 });
    // Unsigned requests never reach the board.
    expect((await app.request("/api/v1/communism")).status).toBe(401);
  });

  it("items of a contributor not seen within 3 minutes, never seen, or frozen are hidden, not deleted, and its node shows offline", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword")]));
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["s1"]);
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual([]);
    expect(((await b.call("GET", "/api/v1/communism")).body.nodes as CommunismNodeWire[]).map((n) => [n.nodeId, n.online, n.items])).toEqual([[a.nodeId, false, 1]]);
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toMatchObject({ listed: 1 });
    seenAt(a.nodeId, null);
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual([]);
    seenAt(a.nodeId, Date.now());
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["s1"]);
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(a.nodeId);
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual([]);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(a.nodeId);
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["s1"]);
  });

  it("withdraw makes a one-way communism rendezvous both sides see from their role and unlists the item; own items, unknown items, an offline contributor and a frozen taker are refused; there is no cap", async () => {
    const { a, b, rv } = await taken();
    expect(rv).toMatchObject({
      kind: "communism", offerId: null, communism: { nodeId: a.nodeId, ref: "s1" }, server: "USEast", seasonal: false, state: "meet",
      me: { role: "take", botIgn: "BobBot", gives: [], gets: [{ itemId: "Sword", qty: 1 }] },
      partner: { botIgn: "AliceBot", poster: "Alice" },
      reported: { mine: false, partner: false },
    });
    expect(rv.deadlineAt - rv.createdAt).toBe(RENDEZVOUS_MS);
    expect(rvRow(rv.id)).toEqual({ offer_id: null, kind: "communism", state: "meet", reason: null, communism_node_id: a.nodeId, communism_ref: "s1", taker_gives_json: "[]" });
    const mineA = (await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mineA).toHaveLength(1);
    expect(mineA[0]).toMatchObject({
      id: rv.id, kind: "communism", offerId: null, communism: { nodeId: a.nodeId, ref: "s1" },
      me: { role: "give", botIgn: "AliceBot", gives: [{ ref: "s1", itemId: "Sword", enchants: [3], count: 1 }], gets: [] },
      partner: { botIgn: "BobBot", poster: "Bob" },
    });
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[]).map((r) => [r.id, r.me.role])).toEqual([[rv.id, "take"]]);

    // Taken means unlisted for everyone, but still the contributor's as the hub holds it; a second taker gets 404.
    const c = await linked("c@x.test", "Cara");
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    expect(refs((await a.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toMatchObject({ listed: 2 });
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "nope", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: "n_nobody", ref: "r1", server: "USEast", botIgn: "CaraBot" })).status).toBe(404);
    // Own item, bad fields.
    const own = await a.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "AliceBot" });
    expect(own.status).toBe(409);
    expect(own.body.error).toContain("own");
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "US East", botIgn: "CaraBot" })).status).toBe(400);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "Cara Bot" })).status).toBe(400);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "bad ref", server: "USEast", botIgn: "CaraBot" })).status).toBe(400);
    // A communism meeting in flight does not use up the taker's swap slot: Bob can still accept a swap offer.
    const offer = (await c.call("POST", "/api/v1/offers", { botIgn: "CaraBot", seasonal: false, server: "USEast", give: [{ ref: "g1", itemId: "Bow", enchants: null, count: 0 }], want: [{ itemId: "Ring", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }] })).body.offer as OfferWire;
    expect((await b.call("POST", `/api/v1/offers/${offer.id}/accept`, { botIgn: "BobBot", items: [{ ref: "t1", itemId: "Ring", enchants: null, count: 0 }] })).status).toBe(200);

    // No cap: Bob may take as many as are listed, one meeting each.
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword"), citem("r1", "Ring"), citem("r2", "Ring"), citem("r3", "Ring")]));
    expect((await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).status).toBe(200);
    expect((await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r2", server: "USEast", botIgn: "BobBot" })).status).toBe(200);
    expect((await b.call("GET", "/api/v1/communism")).body.status).toEqual({ accounts: 0, slots: 0, free: 0, listed: 0 });
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["r3"]);

    // Contributor offline or frozen: 409, and the item is not on the board anyway. Frozen taker: 409.
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    const off = await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" });
    expect(off).toMatchObject({ status: 409, body: { error: "contributor offline" } });
    seenAt(a.nodeId, Date.now());
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(a.nodeId);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(409);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(a.nodeId);
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(c.nodeId);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(409);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(c.nodeId);
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r3", server: "USEast", botIgn: "CaraBot" })).status).toBe(200);
  });

  it("give makes a one-way communism rendezvous to the receiving node's account with the most room; needs an online node with room in that half, never your own", async () => {
    const a = await linked("a@x.test", "Alice");
    const b = await linked("b@x.test", "Bob");
    expect((await b.call("POST", "/api/v1/communism/publish", publish([], [account("BobComm", false, 8, 3), account("BobRoom", false, 16, 5), account("BobSeas", true, 8, 0)]))).status).toBe(200);
    const items = [{ ref: "g1", itemId: "Sword", enchants: null, count: 0 }, { ref: "g2", itemId: "Ring", enchants: [1], count: 1 }];
    const give = await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items, server: "USEast", botIgn: "AliceBot" });
    expect(give.status).toBe(200);
    const rv = give.body.rendezvous as RendezvousWire;
    expect(rv).toMatchObject({
      kind: "communism", offerId: null, communism: null, server: "USEast", seasonal: false, state: "meet",
      me: { role: "give", botIgn: "AliceBot", gives: items, gets: [] },
      partner: { botIgn: "BobRoom", poster: "Bob" },
      reported: { mine: false, partner: false },
    });
    expect(rvRow(rv.id)).toEqual({ offer_id: null, kind: "communism", state: "meet", reason: null, communism_node_id: b.nodeId, communism_ref: null, taker_gives_json: "[]" });
    const bobs = ((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(bobs).toMatchObject({ id: rv.id, kind: "communism", communism: null, me: { role: "take", botIgn: "BobRoom", gives: [], gets: [{ itemId: "Sword", qty: 1 }, { itemId: "Ring", qty: 1 }] }, partner: { botIgn: "AliceBot", poster: "Alice" } });
    // The two slots the give will take are spoken for while it is under way (a second give must not land on them), a publish of Bob's meanwhile included. Refusals: own node, no room in that half, offline, bad shapes.
    expect((await b.call("GET", "/api/v1/communism/mine")).body.status).toEqual({ accounts: 3, slots: 32, free: 6, listed: 0 });
    expect((await b.call("POST", "/api/v1/communism/publish", publish([], [account("BobComm", false, 8, 3), account("BobRoom", false, 16, 5), account("BobSeas", true, 8, 0)]))).status).toBe(200);
    expect((await b.call("GET", "/api/v1/communism/mine")).body.status).toEqual({ accounts: 3, slots: 32, free: 6, listed: 0 });
    expect((await b.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items, server: "USEast", botIgn: "BobComm" })).status).toBe(409);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: true, items, server: "USEast", botIgn: "AliceBot" })).status).toBe(409);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items: Array.from({ length: 6 }, (_, i) => ({ ref: `x${i}`, itemId: "Sword", enchants: null, count: 0 })), server: "USEast", botIgn: "AliceBot" })).status).toBe(409);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: "n_nobody", seasonal: false, items, server: "USEast", botIgn: "AliceBot" })).status).toBe(404);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items: [], server: "USEast", botIgn: "AliceBot" })).status).toBe(400);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items: [{ ref: "bad ref", itemId: "Sword", enchants: null, count: 0 }], server: "USEast", botIgn: "AliceBot" })).status).toBe(400);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: "no", items, server: "USEast", botIgn: "AliceBot" })).status).toBe(400);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items, server: "US East", botIgn: "AliceBot" })).status).toBe(400);
    seenAt(b.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items, server: "USEast", botIgn: "AliceBot" })).status).toBe(409);
    seenAt(b.nodeId, Date.now());
    db.prepare("UPDATE nodes SET frozen = 1 WHERE id = ?").run(a.nodeId);
    expect((await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items, server: "USEast", botIgn: "AliceBot" })).status).toBe(409);
    db.prepare("UPDATE nodes SET frozen = 0 WHERE id = ?").run(a.nodeId);
    // Receipts close it like a take: the giver gave, the receiver got, nothing came back; no listing is touched, no swap is counted.
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Sword", qty: 1 }, { itemId: "Ring", qty: 1 }], [], "BobRoom", true, { gaveRefs: ["g1", "g2"] }))).body).toEqual({ ok: true, state: "meet" });
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [{ itemId: "Ring", qty: 1 }, { itemId: "Sword", qty: 1 }], "AliceBot"))).body).toEqual({ ok: true, state: "done" });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    // Over, the meeting no longer speaks for the slots: the room is what Bob's node publishes, which now has the items.
    expect(communismOperatorView(db)).toMatchObject({ handovers: 1, accounts: 3, slots: 32, free: 8 });
    expect((await b.call("POST", "/api/v1/communism/publish", publish([], [account("BobComm", false, 8, 3), account("BobRoom", false, 16, 3), account("BobSeas", true, 8, 0)]))).status).toBe(200);
    expect(communismOperatorView(db)).toMatchObject({ free: 6 });
    // A give the receiver aborts does not dispute anything.
    const rv2 = (await a.call("POST", "/api/v1/communism/give", { nodeId: b.nodeId, seasonal: false, items: [items[0]], server: "USEast", botIgn: "AliceBot" })).body.rendezvous as RendezvousWire;
    expect((await b.call("POST", `/api/v1/rendezvous/${rv2.id}/abort`, { reason: "no room after all" })).body).toEqual({ ok: true, state: "aborted" });
  });

  it("matching receipts close a hand-over: done, the listing is gone, attestations recorded, no completedSwaps", async () => {
    const { a, b, rv } = await taken();
    const first = await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORD, [], "BobBot", true, { gaveRefs: ["s1"] }));
    expect(first.body).toEqual({ ok: true, state: "meet" });
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0].reported).toEqual({ mine: false, partner: true });
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], SWORD, "AliceBot"))).body).toEqual({ ok: true, state: "done" });

    expect((await b.call("GET", "/api/v1/communism")).body.status).toEqual({ accounts: 0, slots: 0, free: 0, listed: 0 });
    const mineA = await a.call("GET", "/api/v1/communism/mine");
    expect((mineA.body.items as CommunismItemWire[]).map((it) => it.ref)).toEqual(["r1"]);
    expect(mineA.body.status).toEqual({ accounts: 1, slots: 8, free: 8, listed: 1 });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(db.prepare("SELECT node_id, bot_ign, by_node_id FROM attestations ORDER BY bot_ign").all()).toEqual([
      { node_id: a.nodeId, bot_ign: "AliceBot", by_node_id: b.nodeId },
      { node_id: b.nodeId, bot_ign: "BobBot", by_node_id: a.nodeId },
    ]);
    const done = ((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(done).toMatchObject({ id: rv.id, kind: "communism", state: "done", communism: { nodeId: a.nodeId, ref: "s1" }, reported: { mine: true, partner: true } });
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "late" })).status).toBe(409);
    expect(communismOperatorView(db)).toEqual({ listed: 1, contributors: 1, handovers: 1, accounts: 1, slots: 8, free: 8 });
    // A stranger cannot report on it.
    const c = await linked("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "X"))).status).toBe(404);
  });

  it("a failed receipt, an abort or the deadline relist the item", async () => {
    const { a, b, rv } = await taken();
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "", false, { error: "contributor never showed" }))).body).toEqual({ ok: true, state: "failed" });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1", "s1"]);
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });

    // Take it again; the contributor aborts this time.
    const rv2 = (await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    expect(rv2.id).not.toBe(rv.id);
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    expect((await a.call("POST", `/api/v1/rendezvous/${rv2.id}/abort`, { reason: "bot crashed" })).body).toEqual({ ok: true, state: "aborted" });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1", "s1"]);

    // A third time, and let the clock run out.
    const rv3 = (await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    sweepRendezvous(db, rv3.deadlineAt - 1);
    expect(rvRow(rv3.id)).toMatchObject({ state: "meet" });
    sweepRendezvous(db, rv3.deadlineAt);
    expect(rvRow(rv3.id)).toMatchObject({ state: "failed", reason: "deadline passed" });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1", "s1"]);
    const rv4 = await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "s1", server: "USEast", botIgn: "BobBot" });
    expect(rv4.status).toBe(200);
    expect(((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[]).map((r) => [r.id, r.state])).toEqual([[(rv4.body.rendezvous as RendezvousWire).id, "meet"], [rv3.id, "failed"], [rv2.id, "aborted"], [rv.id, "failed"]]);
    expect(communismOperatorView(db)).toMatchObject({ listed: 2, contributors: 1, handovers: 0 });

    // The holder's own "traded" takes the item off the board at once; with the taker silent until the deadline it is done on that word, not counted, nobody frozen.
    const rv4w = rv4.body.rendezvous as RendezvousWire;
    expect((await a.call("POST", `/api/v1/rendezvous/${rv4w.id}/receipt`, receipt(SWORD, [], "BobBot"))).body.state).toBe("meet");
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toMatchObject({ listed: 1 });
    sweepRendezvous(db, rv4w.deadlineAt);
    expect(rvRow(rv4w.id)).toMatchObject({ state: "done", reason: "Alice's node reported the trade; Bob's sent nothing by the deadline" });
    expect(refs((await b.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    expect(nodeRow(b.nodeId)).toMatchObject({ frozen: 0 });
    expect(communismOperatorView(db)).toMatchObject({ handovers: 0 });
  });

  it("mismatched receipts, or a taker that handed something over, dispute the hand-over and freeze nobody", async () => {
    const { a, b, rv } = await taken();
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORD, [{ itemId: "Ring", qty: 1 }], "BobBot"))).body.state).toBe("meet");
    const bad = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], SWORD, "AliceBot"));
    expect(bad.body).toEqual({ ok: true, state: "disputed" });
    expect(rvRow(rv.id)).toMatchObject({ state: "disputed", reason: expect.stringContaining("one-way") });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 0 });
    // The holder said the sword left its bot, so its listing is gone on that word; the other listing stays, and both still trade.
    expect((await a.call("GET", "/api/v1/communism/mine")).body.status).toMatchObject({ listed: 1 });
    const c = await linked("c@x.test", "Cara");
    await c.call("POST", "/api/v1/communism/publish", publish([citem("k1", "Katana", { botIgn: "CaraBot" })]));
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["k1", "r1"]);

    // Plain disagreement between another pair: the taker says nothing arrived.
    const d = await linked("d@x.test", "Dan");
    const w = (await d.call("POST", "/api/v1/communism/withdraw", { nodeId: c.nodeId, ref: "k1", server: "USEast", botIgn: "DanBot" })).body.rendezvous as RendezvousWire;
    expect((await c.call("POST", `/api/v1/rendezvous/${w.id}/receipt`, receipt([{ itemId: "Katana", qty: 1 }], [], "DanBot"))).body.state).toBe("meet");
    expect((await d.call("POST", `/api/v1/rendezvous/${w.id}/receipt`, receipt([], [], "CaraBot"))).body).toEqual({ ok: true, state: "disputed" });
    expect(rvRow(w.id)).toMatchObject({ state: "disputed", reason: "the two receipts disagree on what changed hands" });
    expect(nodeRow(c.nodeId).frozen).toBe(0);
    expect(nodeRow(d.nodeId).frozen).toBe(0);

    // The operator sees both, with "communism" where a swap shows its offer.
    const cookie = person(db, "boss@x.test", "Boss").cookie;
    const admin = await (await app.request("/admin", { headers: { cookie } })).text();
    expect(admin).toContain("Disputed meetings");
    expect(admin).toContain(">communism</td>");
    expect(admin).toContain("Dan-desk");
  });

  it("a publish omitting an item someone is meeting for keeps it until the meeting closes", async () => {
    const { a, b, rv } = await taken();
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("r1", "Ring")]))).body).toMatchObject({ ok: true, listed: 2 });
    expect(((await a.call("GET", "/api/v1/communism/mine")).body.items as CommunismItemWire[]).map((it) => it.ref).sort()).toEqual(["r1", "s1"]);
    const c = await linked("c@x.test", "Cara");
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    // Publishing it again while met for updates it without touching the meeting.
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("r1", "Ring"), citem("s1", "Sword", { name: "Sword renamed" })]))).body).toMatchObject({ ok: true, listed: 2 });
    expect(rvRow(rv.id)).toMatchObject({ state: "meet" });
    expect(db.prepare("SELECT name FROM communism_items WHERE node_id = ? AND ref = 's1'").get(a.nodeId)).toEqual({ name: "Sword renamed" });
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("r1", "Ring")]))).body).toMatchObject({ ok: true, listed: 2 });
    // Once the meeting closes without a hand-over, the kept row is back on the board until the next publish drops it.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "no room" })).body).toEqual({ ok: true, state: "aborted" });
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1", "s1"]);
    expect((await a.call("POST", "/api/v1/communism/publish", publish([citem("r1", "Ring")]))).body).toMatchObject({ ok: true, listed: 1 });
    expect(refs((await c.call("GET", "/api/v1/communism")).body.items)).toEqual(["r1"]);
    // And a hand-over that completes takes the kept row with it.
    const rv2 = (await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    expect((await a.call("POST", "/api/v1/communism/publish", publish([]))).body).toMatchObject({ ok: true, listed: 1 });
    await a.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], [], "BobBot"));
    expect((await b.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([], [{ itemId: "Ring", qty: 1 }], "AliceBot"))).body).toEqual({ ok: true, state: "done" });
    expect((await a.call("GET", "/api/v1/communism/mine")).body).toMatchObject({ items: [], status: { listed: 0 } });
  });

  it("website: /communism needs a session, lists every online node's items grouped by node with room per half, filters by half; the admin page shows communism totals and no cap", async () => {
    const a = await linked("a@x.test", "Alice");
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { seasonal: true, count: 2, enchants: [1, 2], botIgn: "AliceSeas" }), citem("r1", "Ring")], [account("AliceBot", false, 8, 6), account("AliceSeas", true, 16, 10)]));
    expect((await app.request("/communism")).status).toBe(302);
    const cookie = person(db, "guest@x.test", "Gwen").cookie;
    expect(await (await app.request("/me", { headers: { cookie } })).text()).toContain('href="/communism"');
    const page = await app.request("/communism", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    // The board shows one half at a time, seasonal first, like the node's pool page.
    expect(html).toContain("Sword name");
    expect(html).not.toContain("Ring name");
    expect(html).toContain("Alice-desk");
    expect(html).toContain("10</b>/16 free on 1 account");
    expect(html).toContain("1 item · 10 of 16 slots free · 1 node online");
    const non = await (await app.request("/communism?half=nonseasonal", { headers: { cookie } })).text();
    expect(non).toContain("Ring name");
    expect(non).not.toContain("Sword name");
    expect(non).toContain("6</b>/8 free on 1 account");
    expect(html).not.toContain("up to <b>");
    const seasonal = await (await app.request("/communism?half=seasonal", { headers: { cookie } })).text();
    expect(seasonal).toContain("Sword name");
    expect(seasonal).not.toContain("Ring name");
    expect(seasonal).toContain("1 item · 10 of 16 slots free");
    seenAt(a.nodeId, Date.now() - NODE_ONLINE_MS - 1);
    const off = await (await app.request("/communism", { headers: { cookie } })).text();
    expect(off).toContain("No node with accounts in the pool is online");
    expect(off).toContain("Offline: Alice-desk.");
    expect(off).not.toContain("Alice-desk (Alice)");

    // Admin: totals, no cap field, and the settings form ignores one.
    expect((await app.request("/admin", { headers: { cookie } })).status).toBe(403);
    const boss = person(db, "boss@x.test", "Boss").cookie;
    const admin = await (await app.request("/admin", { headers: { cookie: boss } })).text();
    expect(admin).toContain("2 items listed by 1 node");
    expect(admin).toContain("communism accounts");
    expect(admin).toContain("<b>24</b><span>slots</span>");
    expect(admin).toContain("<b>16</b><span>free</span>");
    expect(admin).not.toContain('name="communismDailyCap"');
    expect((await form("/admin/settings", { communismDailyCap: "3", minNodeVersion: "0.1.0" }, boss)).status).toBe(302);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'communismDailyCap'").get()).toBeUndefined();
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
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["communism_node_id", "communism_ref"]));
      expect(up.prepare("SELECT id, offer_id, kind, state, closed_at, communism_ref FROM rendezvous").all()).toEqual([{ id: 7, offer_id: 1, kind: "swap", state: "done", closed_at: 15, communism_ref: null }]);
      expect(up.prepare("SELECT COUNT(*) AS n FROM receipts r JOIN rendezvous v ON v.id = r.rendezvous_id").get()).toEqual({ n: 2 });
      expect(up.pragma("foreign_key_check")).toEqual([]);
      expect(up.pragma("foreign_keys", { simple: true })).toBe(1);
      // The state index survives the rebuild; the player-meeting lookup (taker_user_id) and the communism board's are added after it.
      expect(up.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rendezvous' ORDER BY name").all()).toEqual(
        ["rendezvous_communism_in", "rendezvous_communism_out", "rendezvous_communism_ref", "rendezvous_player", "rendezvous_state"].map((name) => ({ name })));
      // The new shape takes a hand-over with no offer, still refuses a dangling one, and the cascade from offers survived the rebuild.
      up.prepare("INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json, communism_node_id, communism_ref) VALUES (NULL, 'communism', 'USEast', 0, 'meet', 0, 1, 'n_a', 'A', '[]', 'n_b', 'B', '[]', 'n_a', 's1')").run();
      expect(() => up.prepare("INSERT INTO rendezvous (offer_id, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json) VALUES (99, 'USEast', 0, 'meet', 0, 1, 'n_a', 'A', '[]', 'n_b', 'B', '[]')").run()).toThrow(/FOREIGN KEY/);
      up.prepare("DELETE FROM offers WHERE id = 1").run();
      expect(up.prepare("SELECT id, kind FROM rendezvous").all()).toEqual([{ id: 8, kind: "communism" }]);
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

  it("a publish can be a difference against the hub's fingerprint: added and removed apply, a stale base is refused, the reply carries the new fingerprint", async () => {
    const a = await linked("alice@x.test", "Alice");
    const full = await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword"), citem("r1", "Ring")]));
    expect(full.body).toMatchObject({ ok: true, listed: 2 });
    const h1 = full.body.hash as string;
    expect(h1).toBe(refsHash(db, a.nodeId));
    // A difference on a stale or bogus base changes nothing.
    expect((await a.call("POST", "/api/v1/communism/publish", { accounts: [], base: "nope", added: [citem("t1", "Tome")], removed: ["s1"], at: Date.now() })).status).toBe(409);
    expect((await a.call("POST", "/api/v1/communism/publish", { accounts: [], added: [], removed: [], at: Date.now() })).status).toBe(400);
    expect(refsHash(db, a.nodeId)).toBe(h1);
    // On the right base: s1 goes, t1 comes, r1 is updated in place and keeps its listed_at.
    const before = db.prepare("SELECT listed_at FROM communism_items WHERE ref = 'r1'").get() as { listed_at: number };
    const d = await a.call("POST", "/api/v1/communism/publish", { accounts: [account("AliceBot", false)], base: h1, added: [citem("t1", "Tome"), citem("r1", "Ring", { count: 3 })], removed: ["s1", "never-listed"], at: Date.now() + 5 });
    expect(d.body).toMatchObject({ ok: true, listed: 2, accounts: 1 });
    expect(d.body.hash).toBe(refsHash(db, a.nodeId));
    expect(d.body.hash).not.toBe(h1);
    expect(db.prepare("SELECT ref, count, listed_at FROM communism_items ORDER BY ref").all()).toEqual([{ ref: "r1", count: 3, listed_at: before.listed_at }, { ref: "t1", count: 0, listed_at: expect.any(Number) }]);
    // An empty difference on the right base is a cheap "still in sync" check.
    expect((await a.call("POST", "/api/v1/communism/publish", { accounts: [account("AliceBot", false)], base: d.body.hash, added: [], removed: [], at: Date.now() })).body).toMatchObject({ ok: true, listed: 2, hash: d.body.hash });
  });

  it("the board's revision moves with what changed, per half; open pages fetch only those tiles, or the whole grid past the log", async () => {
    const a = await linked("alice@x.test", "Alice");
    const r0 = currentRev();
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { seasonal: true }), citem("r1", "Ring"), citem("r2", "Ring")]));
    const r1 = currentRev();
    expect(r1).toBe(r0 + 1);
    // Both halves changed at r1; from r1 nothing has.
    expect(changesSince(r0, true)).toEqual({ full: false, keys: [`${a.nodeId}|AliceBot|Sword|`] });
    expect(changesSince(r0, false)).toEqual({ full: false, keys: [`${a.nodeId}|AliceBot|Ring|`] });
    expect(changesSince(r1, false)).toEqual({ full: false, keys: [] });
    expect(changesSince(-1, false)).toEqual({ full: true });
    expect(changesSince(r1 + 5, false)).toEqual({ full: true });
    // Dropping one ring changes the ring stack only, in the non-seasonal half.
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { seasonal: true }), citem("r1", "Ring")]));
    expect(changesSince(r1, true)).toEqual({ full: false, keys: [] });
    expect(changesSince(r1, false)).toEqual({ full: false, keys: [`${a.nodeId}|AliceBot|Ring|`] });
    // A take hides the item: its stack changes; the meeting closing changes it again.
    const b = await linked("bob@x.test", "Bob");
    const r2 = currentRev();
    const rv = (await b.call("POST", "/api/v1/communism/withdraw", { nodeId: a.nodeId, ref: "r1", server: "USEast", botIgn: "BobBot" })).body.rendezvous as RendezvousWire;
    expect(changesSince(r2, false)).toEqual({ full: false, keys: [`${a.nodeId}|AliceBot|Ring|`] });
    const r3 = currentRev();
    await b.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "changed my mind" });
    expect(changesSince(r3, false)).toEqual({ full: false, keys: [`${a.nodeId}|AliceBot|Ring|`] });

    // The page's delta route: only for the signed-in; tiles for changed stacks still on the board, keys for gone ones, the whole grid when it cannot say.
    const { cookie } = person(db, "viewer@x.test", "Viewer");
    expect((await app.request("/communism/delta?half=nonseasonal&since=0")).status).toBe(401);
    expect((await app.request("/communism/stream")).status).toBe(401);
    const page = await (await app.request("/communism?half=nonseasonal", { headers: { cookie } })).text();
    expect(page).toContain(`data-rev="${currentRev()}"`);
    expect(page).toContain('data-communism-live="/communism/stream"');
    const r4 = currentRev();
    const same = (await (await app.request(`/communism/delta?half=nonseasonal&since=${r4}`, { headers: { cookie } })).json()) as { rev: number; tiles: unknown[]; removed: string[] };
    expect(same).toMatchObject({ rev: r4, tiles: [], removed: [] });
    await a.call("POST", "/api/v1/communism/publish", publish([citem("s1", "Sword", { seasonal: true }), citem("t1", "Tome")]));
    const d = (await (await app.request(`/communism/delta?half=nonseasonal&since=${r4}`, { headers: { cookie } })).json()) as { rev: number; tiles: { key: string; html: string }[]; removed: string[]; count: number; rest: string; nodes: string };
    expect(d.rev).toBe(currentRev());
    // The page never sees a key with a bot's name in it, only its hash.
    const pub = (k: string) => createHash("sha256").update(k).digest("base64url").slice(0, 16);
    expect(d.removed).toEqual([pub(`${a.nodeId}|AliceBot|Ring|`)]);
    expect(d.tiles.map((t) => t.key)).toEqual([pub(`${a.nodeId}|AliceBot|Tome|`)]);
    expect(JSON.stringify(d)).not.toContain("AliceBot");
    expect(d.tiles[0].html).toContain('data-label="Tome name"');
    expect(d.count).toBe(1);
    expect(d.rest).toContain("1 node online");
    expect(d.nodes).toContain("Alice-desk");
    const whole = (await (await app.request("/communism/delta?half=nonseasonal&since=-1", { headers: { cookie } })).json()) as { full: string };
    expect(whole.full).toContain('data-label="Tome name"');
    // A node going offline or coming back is a whole-board change.
    const r5 = currentRev();
    db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now() - NODE_ONLINE_MS - 1, a.nodeId);
    (await import("../communismLive")).checkNodes(db);
    expect(changesSince(r5, false)).toEqual({ full: true });
  });
});
