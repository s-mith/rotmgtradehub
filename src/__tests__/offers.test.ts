import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type OfferItemWire, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { register } from "../auth";
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

/** Register a user, link one node, and return a signer for every method. */
async function linkedNode(email: string, name: string) {
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
  return { nodeId, call, name };
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
  it("creates, browses, lists mine, cancels, and holds a fresh node to one open offer of four items per side", async () => {
    const { a, b } = await twoNodes();
    const created = await a.call("POST", "/api/v1/offers", OFFER);
    expect(created.status).toBe(200);
    const offer = created.body.offer as OfferWire;
    expect(offer).toMatchObject({ poster: "Alice", mine: true, botIgn: "GiverBot", server: "USEast", status: "open", give: OFFER.give, want: OFFER.want });
    expect(offer.expiresAt - offer.createdAt).toBe(14 * 24 * 3600 * 1000);

    // Browse from both sides: newest first, `mine` set only for the poster, limits attached.
    const browseA = await a.call("GET", "/api/v1/offers?open=1");
    expect(browseA.body.limits).toEqual({ maxOpenOffers: 1, maxItemsPerSide: 4, completedSwaps: 0, frozen: false });
    expect((browseA.body.offers as OfferWire[]).map((o) => [o.id, o.mine])).toEqual([[offer.id, true]]);
    const browseB = await b.call("GET", "/api/v1/offers?open=1");
    expect((browseB.body.offers as OfferWire[]).map((o) => [o.id, o.mine, o.poster])).toEqual([[offer.id, false, "Alice"]]);
    expect(((await b.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).length).toBe(0);

    // Limits: a second open offer, five items on a side, and a want total of five are refused with 409; shape problems are 400.
    expect((await a.call("POST", "/api/v1/offers", OFFER)).status).toBe(409);
    const five = { ...OFFER, give: [1, 2, 3, 4, 5].map((i) => item(`g${i}`, "Sword")) };
    expect((await b.call("POST", "/api/v1/offers", five)).status).toBe(409);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, want: [want("Ring", 5)] })).status).toBe(409);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "bad name!" })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, server: "US East" })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g1", "Sword", 9)] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g1", "Sword"), item("g1", "Sword")] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, want: [] })).status).toBe(400);
    expect((await b.call("POST", "/api/v1/offers", { ...OFFER, seasonal: "yes" })).status).toBe(400);

    // Cancel: only the owner, only while open. Then the slot frees up.
    expect((await b.call("DELETE", `/api/v1/offers/${offer.id}`)).status).toBe(404);
    expect((await a.call("DELETE", `/api/v1/offers/${offer.id}`)).body).toEqual({ ok: true });
    expect((await a.call("DELETE", `/api/v1/offers/${offer.id}`)).status).toBe(409);
    expect(((await b.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(0);
    const mine = (await a.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[];
    expect(mine.map((o) => o.status)).toEqual(["cancelled"]);
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
    expect(offerStatus(offerId).status).toBe("accepted");
    const done = ((await a.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(done).toMatchObject({ id: rv.id, state: "done", reported: { mine: true, partner: true } });
    expect((await a.call("GET", "/api/v1/offers/mine")).body.limits).toEqual({ maxOpenOffers: 1, maxItemsPerSide: 6, completedSwaps: 1, frozen: false });
    // A stranger cannot report on it.
    const c = await linkedNode("c@x.test", "Cara");
    expect((await c.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt([], [], "X"))).status).toBe(404);
    expect((await c.call("GET", "/api/v1/rendezvous/mine")).body).toEqual({ rendezvous: [] });
  });

  it("mismatched receipts dispute the swap and freeze both nodes, whose offers vanish and who can post no more", async () => {
    const { a, b, rv } = await acceptedPair();
    // Alice has a second, unrelated open offer that should disappear from the board once she is frozen.
    const c = await linkedNode("c@x.test", "Cara");
    expect((await a.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g9", "Bow")], want: [want("Ring")] })).status).toBe(200);
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(1);

    expect((await a.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    const bad = await b.call("POST", `/api/v1/rendezvous/${rv.id}/receipt`, receipt(RINGS, [{ itemId: "Sword", qty: 1 }], "GiverBot"));
    expect(bad.body).toEqual({ ok: true, state: "disputed" });
    expect(nodeRow(a.nodeId)).toMatchObject({ completed_swaps: 0, frozen: 1 });
    expect(nodeRow(b.nodeId).frozen_reason).toContain(`#${rv.id}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()).toEqual({ n: 0 });

    expect((await a.call("POST", "/api/v1/offers", OFFER)).status).toBe(409);
    expect((await b.call("POST", "/api/v1/offers", OFFER)).status).toBe(409);
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(0);
    expect((await a.call("GET", "/api/v1/offers?open=1")).body.limits).toMatchObject({ frozen: true });
    // Frozen nodes may not accept either; a stranger cannot accept a frozen poster's hidden offer.
    const cOffer = (await c.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "CaraBot" })).body.offer as OfferWire;
    expect((await b.call("POST", `/api/v1/offers/${cOffer.id}/accept`, TAKE)).status).toBe(409);
    const hidden = (db.prepare("SELECT id FROM offers WHERE node_id = ? AND status = 'open'").get(a.nodeId) as { id: number }).id;
    expect((await c.call("POST", `/api/v1/offers/${hidden}/accept`, { botIgn: "CaraBot", items: [item("r", "Ring")] })).status).toBe(409);

    // The operator sees the dispute and can unfreeze from the admin page.
    const form = (path: string, fields: Record<string, string>, cookie?: string) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    const reg = await form("/register", { name: "Boss", email: "boss@x.test", password: "correct horse battery" });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const admin = await (await app.request("/admin", { headers: { cookie } })).text();
    expect(admin).toContain("Disputed rendezvous");
    expect(admin).toContain("Alice-desk");
    expect(admin).toContain("0 completed swaps");
    expect((await form(`/admin/nodes/${a.nodeId}/unfreeze`, {}, cookie)).status).toBe(302);
    expect((await form(`/admin/nodes/${b.nodeId}/unfreeze`, {})).status).toBe(403); // not the operator: nothing changes
    expect(nodeRow(a.nodeId)).toMatchObject({ frozen: 0, frozen_reason: null });
    expect(nodeRow(b.nodeId)).toMatchObject({ frozen: 1 });
    expect((await a.call("POST", "/api/v1/offers", OFFER)).status).toBe(409); // still at her open-offer limit, just no longer frozen
    expect(((await c.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => o.poster)).toEqual(["Cara", "Alice"]); // newest first
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

    // An unconfirmed success claim at the deadline is a dispute, not a quiet failure.
    const rv4 = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    expect((await a.call("POST", `/api/v1/rendezvous/${rv4.id}/receipt`, receipt(SWORDS, RINGS, "TakerBot"))).body.state).toBe("meet");
    sweepRendezvous(db, rv4.deadlineAt);
    expect(db.prepare("SELECT state FROM rendezvous WHERE id = ?").get(rv4.id)).toEqual({ state: "disputed" });
    expect(nodeRow(b.nodeId).frozen).toBe(1);

    // Offers past their expiry are swept too.
    const c = await linkedNode("c@x.test", "Cara");
    const fresh = (await c.call("POST", "/api/v1/offers", { ...OFFER, botIgn: "CaraBot" })).body.offer as OfferWire;
    sweepRendezvous(db, fresh.expiresAt);
    expect(offerStatus(fresh.id).status).toBe("expired");
  });
});
