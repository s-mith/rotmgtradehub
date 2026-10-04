import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type NodeStatusWire, type OfferItemWire, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { linkCodeFor, person } from "./people";
import { MAX_OPEN_OFFERS, RENDEZVOUS_EXTEND_MS, RENDEZVOUS_MAX_MS, RENDEZVOUS_MS, sweepRendezvous } from "../offers";
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

/** What a node says about itself in a heartbeat: four bots online at most, 8-slot characters. */
const STATUS: NodeStatusWire = { gate: { held: false, reason: null, known: true }, proxies: 4, accounts: 4, suspended: 0, deskServer: null, onlineCap: 4, maxTradeSlots: 8 };

const BOTS = [...["GiverBot", "TakerBot", "BobBot", "CaraBot"].map((ign) => ({ ign, seasonal: false, online: true })), { ign: "SeasonBot", seasonal: true, online: true }];

/** Register a user, link one node that has sent a heartbeat (so it is online), and return a signer for every method. */
async function linkedNode(email: string, name: string, status: Partial<NodeStatusWire> = {}) {
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
  // Its accounts: the bots these tests post and take with, all non-seasonal, plus one seasonal.
  const beat = async (more: Partial<NodeStatusWire> = {}, bots = BOTS) => expect((await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots, status: { ...STATUS, ...status, ...more } })).status).toBe(200);
  await beat();
  return { nodeId, call, name, beat };
}

const item = (ref: string, itemId: string, count = 0): OfferItemWire => ({ ref, itemId, enchants: count ? [1] : null, count });
const want = (itemId: string, qty = 1) => ({ itemId, qty, slotsMin: 0, slotsExact: null, enchants: [] });
const OFFER = { botIgn: "GiverBot", seasonal: false, server: "USEast", give: [item("g1", "Sword"), item("g2", "Sword")], want: [want("Ring", 2), want("Cloak")] };
const TAKE = { botIgn: "TakerBot", items: [item("t1", "Ring"), item("t2", "Ring"), item("t3", "Cloak")] };
const receipt = (gave: { itemId: string; qty: number }[], got: { itemId: string; qty: number }[], partnerIgn: string, ok = true, extra: Partial<ReceiptWire> = {}): ReceiptWire =>
  ({ window: 0, ok, gave, gaveRefs: [], got, partnerIgn, at: Date.now(), ...extra });
const SWORDS = [{ itemId: "Sword", qty: 2 }];
const RINGS = [{ itemId: "Ring", qty: 2 }, { itemId: "Cloak", qty: 1 }];

async function twoNodes() {
  const a = await linkedNode("a@x.test", "Alice");
  const b = await linkedNode("b@x.test", "Bob");
  return { a, b };
}

async function acceptedPair() {
  const { a, b } = await twoNodes();
  const created = await a.call("POST", "/api/v1/offers", OFFER);
  expect(created.status).toBe(200);
  const offerId = (created.body.offer as OfferWire).id;
  const acc = await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE);
  expect(acc.status).toBe(200);
  const rv = acc.body.rendezvous as RendezvousWire;
  return { a, b, offerId, rv };
}

const nodeRow = (id: string) => db.prepare("SELECT completed_swaps, frozen, frozen_reason FROM nodes WHERE id = ?").get(id) as { completed_swaps: number; frozen: number; frozen_reason: string | null };
const offerStatus = (id: number) => db.prepare("SELECT status, taker_node_id FROM offers WHERE id = ?").get(id) as { status: string; taker_node_id: string | null };

describe("offers", () => {
  it("creates, browses, lists mine and cancels; every node gets 30 open offers, and items up to its biggest trade inventory", async () => {
    const { a, b } = await twoNodes();
    const created = await a.call("POST", "/api/v1/offers", OFFER);
    expect(created.status).toBe(200);
    const offer = created.body.offer as OfferWire;
    expect(offer).toMatchObject({ poster: "Alice", mine: true, botIgn: "GiverBot", server: "USEast", status: "open", give: OFFER.give, want: OFFER.want });
    expect(offer.expiresAt - offer.createdAt).toBe(14 * 24 * 3600 * 1000);

    // Browse from both sides: newest first, `mine` set only for the poster, limits attached.
    const browseA = await a.call("GET", "/api/v1/offers?open=1");
    expect(browseA.body.limits).toEqual({ maxOpenOffers: MAX_OPEN_OFFERS, maxItemsPerSide: 8, completedSwaps: 0, frozen: false, maxTakes: 4 });
    expect((browseA.body.offers as OfferWire[]).map((o) => [o.id, o.mine])).toEqual([[offer.id, true]]);
    const browseB = await b.call("GET", "/api/v1/offers?open=1");
    expect((browseB.body.offers as OfferWire[]).map((o) => [o.id, o.mine, o.poster])).toEqual([[offer.id, false, "Alice"]]);
    expect(((await b.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).length).toBe(0);

    // Items per side follow the node's biggest trade inventory: 8-slot characters refuse nine on a side or a want of nine.
    const nine = { ...OFFER, give: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => item(`g${i}`, "Sword")) };
    expect((await b.call("POST", "/api/v1/offers", nine)).status).toBe(409);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, want: [want("Ring", 9)] })).status).toBe(409);
    await b.beat({ maxTradeSlots: 24 });
    expect((await b.call("GET", "/api/v1/offers/mine")).body.limits).toMatchObject({ maxItemsPerSide: 24 });
    expect((await b.call("POST", "/api/v1/offers", { ...nine, want: [want("Ring", 20)] })).status).toBe(200);
    // The same 30 open offers for everyone, new or not.
    for (let i = 1; i < MAX_OPEN_OFFERS; i++) expect((await a.call("POST", "/api/v1/offers", OFFER)).status).toBe(200);
    expect((await a.call("POST", "/api/v1/offers", OFFER)).body).toEqual({ error: `at most ${MAX_OPEN_OFFERS} open offers at once` });
    for (const o of ((await a.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).filter((o) => o.id !== offer.id)) await a.call("DELETE", `/api/v1/offers/${o.id}`);
    for (const o of (await b.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]) await b.call("DELETE", `/api/v1/offers/${o.id}`);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "bad name!" })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, server: "US East" })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g1", "Sword", 9)] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g1", "Sword"), item("g1", "Sword")] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, want: [] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, seasonal: "yes" })).status).toBe(400);

    // Cancel: only the owner, only while open.
    expect((await b.call("DELETE", `/api/v1/offers/${offer.id}`)).status).toBe(404);
    expect((await a.call("DELETE", `/api/v1/offers/${offer.id}`)).body).toEqual({ ok: true });
    expect((await a.call("DELETE", `/api/v1/offers/${offer.id}`)).status).toBe(409);
    expect(((await b.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(0);
    expect(((await a.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).find((o) => o.id === offer.id)?.status).toBe("cancelled");
    expect((await a.call("POST", "/api/v1/offers", OFFER)).status).toBe(200);
    // Unsigned requests never reach the board.
    expect((await app.request("/api/v1/offers?open=1")).status).toBe(401);
  });

  it("accept makes a rendezvous both sides see from their own role; own offers, double accepts and wrong items are refused", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    expect(rv).toMatchObject({
      offerId, server: "USEast", seasonal: false, state: "meet",
      me: { role: "take", botIgn: "TakerBot", gives: TAKE.items, gets: [{ itemId: "Sword", qty: 2 }] },
      partner: { botIgn: "GiverBot", poster: "Alice" },
      reported: { mine: false, partner: false },
    });
    expect(rv.deadlineAt - rv.createdAt).toBe(RENDEZVOUS_MS);
    expect(offerStatus(offerId)).toEqual({ status: "accepted", taker_node_id: b.nodeId });

    const mineA = (await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mineA).toHaveLength(1);
    expect(mineA[0]).toMatchObject({
      id: rv.id, me: { role: "give", botIgn: "GiverBot", gives: OFFER.give, gets: [{ itemId: "Ring", qty: 2 }, { itemId: "Cloak", qty: 1 }] },
      partner: { botIgn: "TakerBot", poster: "Bob" },
    });
    // The accepted offer left the board; a second accept and the poster's own accept are refused.
    expect(((await b.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(0);
    expect((await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).status).toBe(409);
    expect((await a.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).status).toBe(409);
    expect((await b.call("POST", `/api/v1/offers/999/accept`, TAKE)).status).toBe(404);

    // Items must cover the want lines exactly, in order.
    const second = (await b.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "TakerBot" })).body.offer as OfferWire;
    const c = await linkedNode("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/offers/${second.id}/accept`, { botIgn: "CaraBot", items: TAKE.items.slice(0, 2) })).status).toBe(400);
    expect((await c.call("POST", `/api/v1/offers/${second.id}/accept`, { botIgn: "CaraBot", items: [item("x1", "Cloak"), item("x2", "Ring"), item("x3", "Ring")] })).status).toBe(400);
    expect((await c.call("POST", `/api/v1/offers/${second.id}/accept`, { botIgn: "CaraBot", items: TAKE.items })).status).toBe(200);
  });

  it("matching receipts close the swap: done, completedSwaps on both, attestations, and wider limits", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    const first = await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot", true, { gaveRefs: ["g1", "g2"] }));
    expect(first.body).toEqual({ ok: true, state: "meet" });
    const seenByB = ((await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(seenByB.reported).toEqual({ mine: false, partner: true });
    // Same-window duplicate from the same node is ignored, not an error.
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body).toEqual({ ok: true, state: "meet" });
    const second = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Cloak", qty: 1 }, { itemId: "Ring", qty: 2 }], SWORDS, "GiverBot", true, { gaveRefs: ["t1", "t2", "t3"] }));
    expect(second.body).toEqual({ ok: true, state: "done" });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 1, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 1, frozen: 0 });
    expect(db.prepare("SELECT node_id, bot_ign, by_node_id FROM attestations ORDER BY bot_ign").all()).toEqual([
      { node_id: a.nodeId, bot_ign: "GiverBot", by_node_id: b.nodeId },
      { node_id: b.nodeId, bot_ign: "TakerBot", by_node_id: a.nodeId },
    ]);
    expect(offerStatus(offerId).status).toBe("done");
    const done = ((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(done).toMatchObject({ id: rv.id, state: "done", reported: { mine: true, partner: true } });
    expect((await a.call("GET", "/api/v1/offers/mine")).body.limits).toEqual({ maxOpenOffers: MAX_OPEN_OFFERS, maxItemsPerSide: 8, completedSwaps: 1, frozen: false, maxTakes: 4 });
    // A stranger cannot report on it.
    const c = await linkedNode("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "X"))).status).toBe(404);
    expect((await c.call("GET", "/api/v1/rendezvous/mine")).body).toEqual({ rendezvous: [] });
  });

  it("receipts that contradict each other dispute the swap and freeze nobody: each side's own word settled its side, and nothing counts", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    // Alice has a second, unrelated open offer; it stays on the board throughout.
    const c = await linkedNode("c@x.test", "Cara");
    const aliceSecond = (await a.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g9", "Bow")], want: [want("Ring")] })).body.offer as OfferWire;
    // The poster's bot traded: her offer is done on her own word, while the meeting waits for Bob's.
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    expect(offerStatus(offerId).status).toBe("done");
    const bad = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(RINGS, [{ itemId: "Sword", qty: 1 }], "GiverBot"));
    expect(bad.body).toEqual({ ok: true, state: "disputed" });
    expect((db.prepare("SELECT reason FROM rendezvous WHERE id = ?").get(rv.id) as { reason: string }).reason).toBe("the two receipts disagree on what changed hands");
    expect(nodeRow(a.nodeId)).toEqual({ completed_swaps: 0, frozen: 0, frozen_reason: null });
    expect(nodeRow(b.nodeId)).toEqual({ completed_swaps: 0, frozen: 0, frozen_reason: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 0 });
    expect(offerStatus(offerId).status).toBe("done");
    // Both keep trading: Bob posts, Cara sees it and takes it.
    const bobs = (await b.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "TakerBot" })).body.offer as OfferWire;
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.id)).toEqual([bobs.id, aliceSecond.id]);
    expect((await a.call("GET", "/api/v1/offers?open=1")).body.limits).toMatchObject({ frozen: false });

    // The operator sees the dispute, and a count of disputes per node.
    const form = (path: string, fields: Record<string, string>, cookie?: string) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    const cookie = person(db, "boss@x.test", "Boss").cookie;
    const admin = await (await app.request("/admin", { headers: { cookie } })).text();
    expect(admin).toContain("Disputed meetings");
    expect(admin).toContain("Alice-desk");
    expect(admin).toContain("0 completed swaps");
    expect(admin).toContain('<td data-th="disputes"><span class="bad">1</span></td>');
    // Freezing is the operator's call alone: a frozen node posts and accepts nothing, and its offers are hidden, until unfrozen.
    expect((await form(`/admin/nodes/${b.nodeId}/freeze`, { reason: "keeps disagreeing" })).status).toBe(403);
    expect(nodeRow(b.nodeId).frozen).toBe(0);
    expect((await form(`/admin/nodes/${b.nodeId}/freeze`, { reason: "keeps disagreeing" }, cookie)).status).toBe(302);
    expect(nodeRow(b.nodeId)).toMatchObject({ frozen: 1, frozen_reason: "keeps disagreeing" });
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.id)).toEqual([aliceSecond.id]);
    expect((await c.call("POST", `/api/v1/offers/${bobs.id}/accept`, TAKE)).status).toBe(409);
    const cOffer = (await c.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "CaraBot" })).body.offer as OfferWire;
    expect((await b.call("POST", `/api/v1/offers/${cOffer.id}/accept`, TAKE)).body).toMatchObject({ error: "the hub operator has frozen this node" });
    expect(await (await app.request("/admin", { headers: { cookie } })).text()).toContain("keeps disagreeing");
    expect((await form(`/admin/nodes/${b.nodeId}/unfreeze`, {})).status).toBe(403);
    expect((await form(`/admin/nodes/${b.nodeId}/unfreeze`, {}, cookie)).status).toBe(302);
    expect(nodeRow(b.nodeId)).toMatchObject({ frozen: 0, frozen_reason: null });
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.poster)).toEqual(["Cara", "Bob", "Alice"]);
  });

  it("a node claiming a trade that never happened closes, freezes and counts nothing on the other side", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    // Bob (the taker) says the swap happened before any bot met; Alice's offer is hers to close, so it stays accepted.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(RINGS, SWORDS, "GiverBot"))).body.state).toBe("meet");
    expect(offerStatus(offerId)).toEqual({ status: "accepted", taker_node_id: b.nodeId });
    // Having reported, he cannot give up.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "never mind" })).status).toBe(409);
    // Alice's bot waited and never saw his: her own word reopens her offer. The two words contradict: disputed, nobody frozen.
    const hers = await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "", false, { error: "the partner never came", partnerAbsent: true }));
    expect(hers.body).toEqual({ ok: true, state: "disputed" });
    expect((db.prepare("SELECT reason FROM rendezvous WHERE id = ?").get(rv.id) as { reason: string }).reason).toBe("Bob's node reports the trade happened, Alice's that it did not");
    expect(offerStatus(offerId)).toEqual({ status: "open", taker_node_id: null });
    expect(nodeRow(a.nodeId)).toEqual({ completed_swaps: 0, frozen: 0, frozen_reason: null });
    expect(nodeRow(b.nodeId)).toEqual({ completed_swaps: 0, frozen: 0, frozen_reason: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 0 });
    // Someone else can take the reopened offer at once.
    const c = await linkedNode("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, botIgn: "CaraBot" })).status).toBe(200);

    // The same claim with Alice's node silent until the deadline: done on Bob's word, Alice's offer open again on her silence, still nothing counted.
    const second = await acceptedPair();
    expect((await second.b.call("POST", `/api/v1/rendezvous/${second.rv.id}/receipt`, receipt(RINGS, SWORDS, "GiverBot"))).body.state).toBe("meet");
    sweepRendezvous(db, second.rv.deadlineAt);
    expect(db.prepare("SELECT state, reason, counted FROM rendezvous WHERE id = ?").get(second.rv.id)).toEqual({ state: "done", reason: "Bob's node reported the trade; Alice's sent nothing by the deadline", counted: 0 });
    expect(offerStatus(second.offerId)).toEqual({ status: "open", taker_node_id: null });
    expect(nodeRow(second.a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
  });

  it("a lone failed receipt or an abort reopens the offer; the deadline sweep does too", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    const failed = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "", false, { error: "partner never showed" }));
    expect(failed.body).toEqual({ ok: true, state: "failed" });
    expect(offerStatus(offerId)).toEqual({ status: "open", taker_node_id: null });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[]).map((r) => r.state)).toEqual(["failed"]);
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "late" })).status).toBe(409);

    // Accept again, abort this time.
    const rv2 = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    expect(rv2.id).not.toBe(rv.id);
    expect((await a.call("POST", `/api/v1/rendezvous/${rv2.id}/abort`, { reason: "bot crashed" })).body).toEqual({ ok: true, state: "aborted" });
    expect(offerStatus(offerId)).toEqual({ status: "open", taker_node_id: null });

    // Accept a third time and let the clock run out.
    const rv3 = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    sweepRendezvous(db, rv3.deadlineAt - 1);
    expect(offerStatus(offerId).status).toBe("accepted");
    sweepRendezvous(db, rv3.deadlineAt);
    expect(offerStatus(offerId)).toEqual({ status: "open", taker_node_id: null });
    expect(db.prepare("SELECT state, reason FROM rendezvous WHERE id = ?").get(rv3.id)).toEqual({ state: "failed", reason: "deadline passed" });
    const mine = (await b.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mine.map((r) => r.state)).toEqual(["failed", "aborted", "failed"]);

    // The poster's success that the taker never answers: done at the deadline on her word, which closed her offer; not counted, nobody frozen.
    const rv4 = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    expect((await a.call("POST", `/api/v1/rendezvous/${rv4.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    expect(offerStatus(offerId).status).toBe("done");
    sweepRendezvous(db, rv4.deadlineAt);
    expect(db.prepare("SELECT state, reason, counted FROM rendezvous WHERE id = ?").get(rv4.id)).toEqual({ state: "done", reason: "Alice's node reported the trade; Bob's sent nothing by the deadline", counted: 0 });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });

    // Offers past their expiry are swept too.
    const c = await linkedNode("c@x.test", "Cara");
    const fresh = (await c.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "CaraBot" })).body.offer as OfferWire;
    sweepRendezvous(db, fresh.expiresAt);
    expect(offerStatus(fresh.id).status).toBe("expired");
  });
});

describe("offer lifetime, offline nodes, takes at once", () => {
  it("an offline node's offers leave the board and cannot be taken; renewing keeps an offer going or brings an expired one back", async () => {
    const { a, b } = await twoNodes();
    const offer = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire);
    const seen = async () => ((await b.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.id);
    expect(await seen()).toEqual([offer.id]);
    // Alice's node stops beating: after three minutes its offers are gone from the board and refused.
    db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now() - 4 * 60_000, a.nodeId);
    expect(await seen()).toEqual([]);
    expect(await b.call("POST", `/api/v1/offers/${offer.id}/accept`, TAKE)).toMatchObject({ status: 409, body: { error: "that offer's node is offline right now" } });
    await a.beat();
    expect(await seen()).toEqual([offer.id]);

    // Renew: another fourteen days from now; only the owner's, only open or expired.
    expect((await b.call("POST", `/api/v1/offers/${offer.id}/renew`)).status).toBe(404);
    db.prepare("UPDATE offers SET expires_at = ? WHERE id = ?").run(Date.now() + 1000, offer.id);
    const renewed = (await a.call("POST", `/api/v1/offers/${offer.id}/renew`)).body.offer as OfferWire;
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 13 * 24 * 3600 * 1000);
    sweepRendezvous(db, renewed.expiresAt);
    expect(offerStatus(offer.id).status).toBe("expired");
    expect((await a.call("POST", `/api/v1/offers/${offer.id}/renew`)).body.offer).toMatchObject({ status: "open" });
    expect(await seen()).toEqual([offer.id]);
    await a.call("DELETE", `/api/v1/offers/${offer.id}`);
    expect((await a.call("POST", `/api/v1/offers/${offer.id}/renew`)).status).toBe(409);
  });

  it("a node takes as many offers at once as it can have bots online", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob", { onlineCap: 1 });
    const first = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    const second = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    expect((await b.call("POST", `/api/v1/offers/${first}/accept`, TAKE)).status).toBe(200);
    expect(await b.call("POST", `/api/v1/offers/${second}/accept`, TAKE)).toMatchObject({ status: 409, body: { error: "at most 1 offer taken at a time, one per bot this node can have online" } });
    // A second proxy, a second bot online at once: a second take.
    await b.beat({ onlineCap: 2 });
    expect((await b.call("POST", `/api/v1/offers/${second}/accept`, TAKE)).status).toBe(200);
  });
});

describe("meetings: server choice, enchantments, late and lost receipts, extensions", () => {
  const plain = (itemId: string) => ({ itemId, enchants: [] as number[], count: 0 });
  const RINGS_ITEMS = [plain("Ring"), plain("Ring"), plain("Cloak")];

  it("the taker may move the meeting to a server it can trade on, and each side learns the other's items with enchantments", async () => {
    const { a, b } = await twoNodes();
    const offerId = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    expect((await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, server: "US West" })).status).toBe(400);
    const acc = await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, server: "USWest4" });
    expect(acc.status).toBe(200);
    const rv = acc.body.rendezvous as RendezvousWire;
    expect(rv.server).toBe("USWest4");
    expect(rv.me.getsItems).toEqual([{ itemId: "Sword", enchants: null, count: 0 }, { itemId: "Sword", enchants: null, count: 0 }]);
    const mineA = ((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(mineA.server).toBe("USWest4");
    expect(mineA.me.getsItems).toEqual([{ itemId: "Ring", enchants: null, count: 0 }, { itemId: "Ring", enchants: null, count: 0 }, { itemId: "Cloak", enchants: null, count: 0 }]);
  });

  it("receipts that agree on counts but not on enchantments dispute the swap; an unreadable record matches by kind", async () => {
    const { a, b, rv } = await acceptedPair();
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot", true, { gaveItems: [{ itemId: "Sword", enchants: [1], count: 1 }, plain("Sword")], gotItems: RINGS_ITEMS }))).body.state).toBe("meet");
    const r2 = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(RINGS, SWORDS, "GiverBot", true, { gaveItems: RINGS_ITEMS, gotItems: [plain("Sword"), plain("Sword")] }));
    expect(r2.body).toEqual({ ok: true, state: "disputed" });
    expect((db.prepare("SELECT reason FROM rendezvous WHERE id = ?").get(rv.id) as { reason: string }).reason).toContain("disagree");

    const second = await acceptedPair();
    expect((await second.a.call("POST", `/api/v1/rendezvous/${second.rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot", true, { gaveItems: [{ itemId: "Sword", enchants: [1], count: 1 }, plain("Sword")], gotItems: RINGS_ITEMS }))).body.state).toBe("meet");
    const r3 = await second.b.call("POST", `/api/v1/rendezvous/${second.rv.id}/receipt`, receipt(RINGS, SWORDS, "GiverBot", true, { gaveItems: RINGS_ITEMS, gotItems: [{ itemId: "Sword", enchants: null, count: 0 }, plain("Sword")] }));
    expect(r3.body).toEqual({ ok: true, state: "done" });
    expect((await second.b.call("POST", `/api/v1/rendezvous/${second.rv.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], [], "X", true, { gaveItems: [{ itemId: "Ring", enchants: [1, 2, 3, 4, 5, 6, 7, 8, 9], count: 9 }] }))).status).toBe(400);
  });

  it("a success the other side confirms late counts then; meeting #1's case, one side traded and the other gave up, is done", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    sweepRendezvous(db, rv.deadlineAt);
    expect(db.prepare("SELECT state, counted FROM rendezvous WHERE id = ?").get(rv.id)).toEqual({ state: "done", counted: 0 });
    expect(offerStatus(offerId).status).toBe("done");
    const late = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Cloak", qty: 1 }, { itemId: "Ring", qty: 2 }], SWORDS, "GiverBot"));
    expect(late.body).toEqual({ ok: true, state: "done" });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 1, frozen: 0 });
    expect(nodeRow(b.nodeId)).toMatchObject({ completed_swaps: 1, frozen: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 2 });
    expect((db.prepare("SELECT reason FROM rendezvous WHERE id = ?").get(rv.id) as { reason: string }).reason).toContain("both receipts agree (late:");
    // Sent again, nothing counts twice.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Cloak", qty: 1 }, { itemId: "Ring", qty: 2 }], SWORDS, "GiverBot"))).body.state).toBe("done");
    expect(nodeRow(a.nodeId).completed_swaps).toBe(1);

    // One side traded, then the other gave up: done on the first side's word, and the one giving up is not frozen for it.
    const second = await acceptedPair();
    expect((await second.a.call("POST", `/api/v1/rendezvous/${second.rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    expect((await second.b.call("POST", `/api/v1/rendezvous/${second.rv.id}/abort`, { reason: "aborted by the operator" })).body).toEqual({ ok: true, state: "done" });
    expect(db.prepare("SELECT state, reason, counted FROM rendezvous WHERE id = ?").get(second.rv.id)).toEqual({ state: "done", reason: "Alice's node reported the trade; Bob's gave up without confirming it", counted: 0 });
    expect(offerStatus(second.offerId).status).toBe("done");
    expect(nodeRow(second.b.nodeId)).toMatchObject({ frozen: 0 });
  });

  it("a side's word after the meeting ended still settles its own side, and never the other's", async () => {
    const { a, b, offerId, rv } = await acceptedPair();
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "bot stuck" })).body.state).toBe("aborted");
    expect(offerStatus(offerId).status).toBe("open");
    // Bob says the trade went through after all: the meeting is done on his word, but Alice's offer is hers and stays open.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Cloak", qty: 1 }, { itemId: "Ring", qty: 2 }], SWORDS, "GiverBot"))).body).toEqual({ ok: true, state: "done" });
    expect(offerStatus(offerId).status).toBe("open");
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 0 });
    expect((db.prepare("SELECT reason FROM rendezvous WHERE id = ?").get(rv.id) as { reason: string }).reason).toBe("Bob's node reported the trade; Alice's gave up without confirming it (late: was aborted: bot stuck)");
    // The same receipt again changes nothing; Alice's own late look (her bot's items are gone) closes her offer, and both agreeing count the swap.
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Cloak", qty: 1 }, { itemId: "Ring", qty: 2 }], SWORDS, "GiverBot"))).body).toEqual({ ok: true, state: "done" });
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body).toEqual({ ok: true, state: "done" });
    expect(offerStatus(offerId).status).toBe("done");
    expect(nodeRow(a.nodeId).completed_swaps).toBe(1);
    expect(nodeRow(b.nodeId).completed_swaps).toBe(1);
  });

  it("a meeting still under way can get more time, never past sixteen minutes from its start", async () => {
    const { a, b, rv } = await acceptedPair();
    expect(rv.deadlineAt - rv.createdAt).toBe(RENDEZVOUS_MS);
    const c = await linkedNode("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: "x" })).status).toBe(404);
    // Six minutes and ten more would be past the cap: one ask reaches it, and the next is refused.
    expect(RENDEZVOUS_MS + RENDEZVOUS_EXTEND_MS).toBeGreaterThanOrEqual(RENDEZVOUS_MAX_MS);
    const first = await a.call("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: "bot logging in" });
    expect(first.body).toEqual({ ok: true, deadlineAt: rv.createdAt + RENDEZVOUS_MAX_MS });
    const last = first.body.deadlineAt as number;
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: "queue" })).status).toBe(409);
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: "more" })).status).toBe(409);
    expect(((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0].deadlineAt).toBe(last);
    // Not before the old deadline: the sweep leaves it alone.
    sweepRendezvous(db, rv.deadlineAt + 1);
    expect(((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0].state).toBe("meet");
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "done trying" })).body.state).toBe("aborted");
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: "late" })).status).toBe(409);
  });
});

describe("one item in several offers", () => {
  // A node names a physical item by its instance id wherever it offers or hands it over.
  const iid = (n: number) => n.toString(16).padStart(32, "0");
  const BOW = item(iid(1), "Bow");
  const HELM = item(iid(2), "Helm");
  const MY_RING = item(iid(3), "Ring");
  type Node = Awaited<ReturnType<typeof linkedNode>>;
  /** Alice and Bob with room for several open offers and takes each. */
  async function roomy() {
    return twoNodes();
  }
  const post = async (n: Node, give: OfferItemWire[], wanted: string): Promise<number> => {
    const r = await n.call("POST", "/api/v1/offers", { ...OFFER, botIgn: `${n.name}Bot`, give, want: [want(wanted)] });
    expect(r.status).toBe(200);
    return (r.body.offer as OfferWire).id;
  };
  const listed = async (n: Node) => ((await n.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.id).sort((x, y) => x - y);
  const mine = async (n: Node) => new Map(((await n.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).map((o) => [o.id, o]));
  const eventsOf = (nodeId: string, kind: string) => (db.prepare("SELECT e.text FROM events e JOIN nodes n ON n.user_id = e.user_id WHERE n.id = ? AND e.kind = ? ORDER BY e.id").all(nodeId, kind) as { text: string }[]).map((e) => e.text);

  it("while a meeting has the item its other offers are held; traded away there, they are withdrawn and the owner hears why", async () => {
    const { a, b } = await roomy();
    const c = await linkedNode("c@x.test", "Cara");
    const first = await post(a, [BOW], "Ring");
    const second = await post(a, [BOW, HELM], "Cloak");
    const apart = await post(a, [item(iid(4), "Sword")], "Ring");
    expect(await listed(c)).toEqual([first, second, apart]);

    const rv = (await b.call("POST", `/api/v1/offers/${first}/accept`, { botIgn: "BobBot", items: [MY_RING] })).body.rendezvous as RendezvousWire;
    // The meeting has the bow: the other offer with it is off the list and nobody can take it; Alice sees which meeting holds it.
    expect(await listed(c)).toEqual([apart]);
    const held = await c.call("POST", `/api/v1/offers/${second}/accept`, { botIgn: "CaraBot", items: [item("c1", "Cloak")] });
    expect(held).toMatchObject({ status: 409, body: { error: "one of that offer's items is in another trade right now; try again once that is over" } });
    const during = await mine(a);
    expect(during.get(second)).toMatchObject({ status: "open", heldBy: rv.id });
    expect(during.get(apart)?.heldBy).toBeUndefined();

    // Both bots traded: the offer taken is done, the other one with the bow withdrawn, the unrelated one untouched.
    await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Bow", qty: 1 }], [{ itemId: "Ring", qty: 1 }], "BobBot"));
    expect((await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], [{ itemId: "Bow", qty: 1 }], "AliceBot"))).body.state).toBe("done");
    expect(offerStatus(first).status).toBe("done");
    expect(offerStatus(second).status).toBe("cancelled");
    expect(offerStatus(apart).status).toBe("open");
    const after = await mine(a);
    expect(after.get(second)).toMatchObject({ status: "cancelled", closedReason: `Bow was traded away in meeting #${rv.id}` });
    expect(after.get(second)?.heldBy).toBeUndefined();
    expect(eventsOf(a.nodeId, "offer-withdrawn")).toEqual([`Offer #${second} withdrawn: Bow was traded away in meeting #${rv.id}.`]);
    expect(await listed(c)).toEqual([apart]);
    // Nobody else hears about it, and a node's refs mean nothing in another node's offers.
    expect(eventsOf(b.nodeId, "offer-withdrawn")).toEqual([]);
  });

  it("a meeting that ends without the trade frees them; the taker's own offers are held and withdrawn the same way", async () => {
    const { a, b } = await roomy();
    const c = await linkedNode("c@x.test", "Cara");
    const first = await post(a, [BOW], "Ring");
    const second = await post(a, [BOW], "Cloak");
    // Bob offers the ring he is about to take the bow with.
    const bobs = await post(b, [MY_RING], "Helm");
    const cara = await post(c, [HELM], "Ring");

    const rv1 = (await b.call("POST", `/api/v1/offers/${first}/accept`, { botIgn: "BobBot", items: [MY_RING] })).body.rendezvous as RendezvousWire;
    expect(await listed(c)).toEqual([cara]);
    expect((await mine(b)).get(bobs)).toMatchObject({ status: "open", heldBy: rv1.id });
    // The ring is spoken for: Bob cannot take Cara's offer with it too.
    expect(await b.call("POST", `/api/v1/offers/${cara}/accept`, { botIgn: "BobBot", items: [MY_RING] })).toMatchObject({ status: 409, body: { error: "one of the items you would give is in another trade of yours right now" } });

    // Alice gives up: nobody traded, and everything the meeting held is open again.
    expect((await a.call("POST", `/api/v1/rendezvous/${rv1.id}/abort`, { reason: "server full" })).body.state).toBe("aborted");
    expect(await listed(c)).toEqual([first, second, bobs, cara]);
    expect((await mine(a)).get(second)?.heldBy).toBeUndefined();

    // Taken again and traded this time: both sides' other offers naming what they handed over are withdrawn.
    const rv2 = (await b.call("POST", `/api/v1/offers/${first}/accept`, { botIgn: "BobBot", items: [MY_RING] })).body.rendezvous as RendezvousWire;
    await b.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([{ itemId: "Ring", qty: 1 }], [{ itemId: "Bow", qty: 1 }], "AliceBot"));
    // Bob's word settles Bob's side at once; Alice's offers wait for hers.
    expect(offerStatus(bobs).status).toBe("cancelled");
    expect(offerStatus(second).status).toBe("open");
    expect((await mine(a)).get(second)?.heldBy).toBe(rv2.id);
    await a.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([{ itemId: "Bow", qty: 1 }], [{ itemId: "Ring", qty: 1 }], "BobBot"));
    expect(offerStatus(second).status).toBe("cancelled");
    expect(eventsOf(b.nodeId, "offer-withdrawn")).toEqual([`Offer #${bobs} withdrawn: Ring was traded away in meeting #${rv2.id}.`]);
    expect(await listed(c)).toEqual([cara]);
  });

  it("refs from an older node (r1, r2… in each offer) name nothing across offers", async () => {
    const { a, b } = await roomy();
    const c = await linkedNode("c@x.test", "Cara");
    const first = await post(a, [item("r1", "Bow")], "Ring");
    const second = await post(a, [item("r1", "Helm")], "Cloak");
    await b.call("POST", `/api/v1/offers/${first}/accept`, { botIgn: "BobBot", items: [item("r1", "Ring")] });
    expect(await listed(c)).toEqual([second]);
    expect((await mine(a)).get(second)?.heldBy).toBeUndefined();
  });
});

describe("a database from before meetings settled per side", () => {
  it("is settled once: a lone success is done and its offer closed, completed meetings count, and only the freezes disputes caused lift", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-settle-")), "hub.db");
    db = openDb(file);
    app = createApp(db);
    // A meeting that completed.
    const { a, b, rv: rv2 } = await acceptedPair();
    await a.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"));
    expect((await b.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt(RINGS, SWORDS, "GiverBot"))).body.state).toBe("done");
    // Meeting #1's shape: the poster reported the trade, then the taker gave up.
    const offerId = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    const rv = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    // One whose receipts contradicted each other.
    const third = ((await b.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "TakerBot" })).body.offer as OfferWire).id;
    const rv3 = (await a.call("POST", `/api/v1/offers/${third}/accept`, { ...TAKE, botIgn: "GiverBot" })).body.rendezvous as RendezvousWire;
    await b.call("POST", `/api/v1/rendezvous/${rv3.id}/receipt`, receipt(SWORDS, RINGS, "GiverBot"));
    expect((await a.call("POST", `/api/v1/rendezvous/${rv3.id}/receipt`, receipt(RINGS, [{ itemId: "Sword", qty: 1 }], "TakerBot"))).body.state).toBe("disputed");
    // Now what the old hub made of meeting #1's shape: disputed, the offer void, both nodes frozen.
    db.prepare("UPDATE rendezvous SET state = 'disputed', reason = 'aborted after the partner reported success: aborted by the operator', closed_at = ? WHERE id = ?").run(Date.now(), rv.id);
    db.prepare("UPDATE offers SET status = 'void' WHERE id = ?").run(offerId);
    db.prepare("UPDATE nodes SET frozen = 1, frozen_reason = ? WHERE id IN (?, ?)").run(`disputed rendezvous #${rv.id}: aborted after the partner reported success: aborted by the operator`, a.nodeId, b.nodeId);
    // A freeze the operator made for another reason.
    const c = await linkedNode("c@x.test", "Cara");
    db.prepare("UPDATE nodes SET frozen = 1, frozen_reason = 'spamming offers' WHERE id = ?").run(c.nodeId);
    // What the old hub had: none of the per-side columns.
    db.exec("ALTER TABLE rendezvous DROP COLUMN counted; ALTER TABLE rendezvous DROP COLUMN giver_gave_up_at; ALTER TABLE rendezvous DROP COLUMN taker_gave_up_at;");
    db.close();

    db = openDb(file);
    const row = (id: number) => db.prepare("SELECT state, reason, counted, giver_gave_up_at, taker_gave_up_at FROM rendezvous WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row(rv.id)).toMatchObject({ state: "done", counted: 0, giver_gave_up_at: null, taker_gave_up_at: expect.any(Number), reason: "one side reported the trade; the other gave up (was disputed: aborted after the partner reported success: aborted by the operator)" });
    expect(offerStatus(offerId).status).toBe("done");
    expect(row(rv2.id)).toMatchObject({ state: "done", counted: 1 });
    expect(row(rv3.id)).toMatchObject({ state: "disputed", counted: 0 });
    expect(nodeRow(a.nodeId)).toMatchObject({ frozen: 0, frozen_reason: null });
    expect(nodeRow(b.nodeId)).toMatchObject({ frozen: 0, frozen_reason: null });
    expect(nodeRow(c.nodeId)).toMatchObject({ frozen: 1, frozen_reason: "spamming offers" });
    // Once only: opening again changes nothing.
    db.prepare("UPDATE rendezvous SET counted = 0 WHERE id = ?").run(rv2.id);
    db.close();
    db = openDb(file);
    expect(row(rv2.id)).toMatchObject({ counted: 0 });
    db.close();
  });
});
