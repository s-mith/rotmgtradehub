// The review of 2026-10-01: unlinking keeps history, long polls re-offer what
// never reached the node, heartbeat claims are checked against the node's own
// bot list, replays are refused, communism room and items are not promised
// twice, and Realm sign-in cannot reach accounts that sign in another way.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type GuestRequestWire, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, setSettings, type Db } from "../db";
import { createApp } from "../app";
import { setIgn, setVerifiedIgn } from "../auth";
import { linkCodeFor, person } from "./people";
import { resetRateLimits } from "../ratelimit";
import { createGuestRequest, GUEST_REQUEST_TTL_MS, sweepGuestRequests, TAKE_LEASE_MS, takePendingRequests } from "../requests";
import { finishRealmLogin, LOGIN_LEASE_MS, markLoginReady, markLoginVerified, startRealmLogin, takePendingLogins } from "../realmLogin";
import { nodeById } from "../nodes";
import { acceptReports } from "../telemetry";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null, discord: null });
  vi.stubEnv("ADMIN_EMAILS", "");
});

type Reply = { status: number; body: Record<string, unknown> };
const json = async (res: Response): Promise<Reply> => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const STATUS = { gate: { held: false, reason: null, known: true }, proxies: 4, accounts: 4, suspended: 0, deskServer: "USEast", onlineCap: 4, maxTradeSlots: 8, players: { enabled: true, maxMeetings: 2, servers: ["USEast"] } };
const BOTS = [{ ign: "GiverBot", seasonal: false, online: true }, { ign: "TakerBot", seasonal: false, online: false }, { ign: "SeasonBot", seasonal: true, online: true }];

async function linkedNode(email: string, name: string, bots = BOTS) {
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email, name), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const sign = (method: string, path: string, raw: string) => signRequest(kp.privateKeyPem, nodeId, method, path, raw);
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown, headers?: object): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h: Record<string, string> = { ...((headers ?? sign(method, path, raw)) as Record<string, string>) };
    if (body !== undefined) h["content-type"] = "application/json";
    return json(await app.request(path, { method, headers: h, body: body === undefined ? undefined : raw }));
  };
  expect((await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots, status: STATUS })).status).toBe(200);
  return { nodeId, call, sign, user: person(db, email, name) };
}

const item = (ref: string, itemId: string) => ({ ref, itemId, enchants: null, count: 0 });
const want = (itemId: string, qty = 1) => ({ itemId, qty, slotsMin: 0, slotsExact: null, enchants: [] });
const OFFER = { botIgn: "GiverBot", seasonal: false, server: "USEast", give: [item("g1", "Sword")], want: [want("Ring")] };
const TAKE = { botIgn: "TakerBot", items: [item("t1", "Ring")] };
const receipt = (gave: { itemId: string; qty: number }[], got: { itemId: string; qty: number }[], partnerIgn: string, ok = true): ReceiptWire => ({ window: 0, ok, gave, gaveRefs: [], got, partnerIgn, at: Date.now() });
const offerRow = (id: number) => db.prepare("SELECT status, taker_node_id FROM offers WHERE id = ?").get(id) as { status: string; taker_node_id: string | null };
const loc = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");

describe("signed requests", () => {
  it("a request replayed as sent is refused; a fresh signature of the same call goes through", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const headers = a.sign("GET", "/api/v1/offers/mine", "");
    expect((await a.call("GET", "/api/v1/offers/mine", undefined, headers)).status).toBe(200);
    expect(await a.call("GET", "/api/v1/offers/mine", undefined, headers)).toMatchObject({ status: 401, body: { error: "signature refused: replayed" } });
    expect((await a.call("GET", "/api/v1/offers/mine")).status).toBe(200);
    const { "X-Node-Nonce": _n, ...noNonce } = a.sign("GET", "/api/v1/offers/mine", "");
    expect((await a.call("GET", "/api/v1/offers/mine", undefined, noNonce as Record<string, string>)).status).toBe(401);
  });

  it("an offer posted twice with one client key is one offer", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const first = await a.call("POST", "/api/v1/offers", { ...OFFER, clientKey: "post-0001" });
    const again = await a.call("POST", "/api/v1/offers", { ...OFFER, clientKey: "post-0001" });
    expect((again.body.offer as OfferWire).id).toBe((first.body.offer as OfferWire).id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n).toBe(1);
    expect((await a.call("POST", "/api/v1/offers", { ...OFFER, clientKey: "bad key" })).status).toBe(400);
  });
});

describe("accepting checks what the node said about itself", () => {
  it("the taker's bot must be one of its accounts and of the offer's side; servers must be the game's", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob");
    const offerId = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    expect(await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, botIgn: "MadeUp" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("not one of this node's accounts") } });
    expect(await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, botIgn: "SeasonBot" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("is seasonal and this offer is non-seasonal") } });
    expect((await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, server: "Atlantis" })).status).toBe(400);
    expect((await a.call("POST", "/api/v1/offers", { ...OFFER, server: "Atlantis" })).status).toBe(400);
    expect((await b.call("POST", `/api/v1/offers/${offerId}/accept`, { ...TAKE, botIgn: "takerbot" })).status).toBe(200);
  });

  it("takes at once stop at the accounts of that side the node lists, whatever proxies it claims", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob", [{ ign: "TakerBot", seasonal: false, online: true }]);
    const one = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    const two = ((await a.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g2", "Sword")] })).body.offer as OfferWire).id;
    expect((await b.call("POST", `/api/v1/offers/${one}/accept`, TAKE)).status).toBe(200);
    expect(await b.call("POST", `/api/v1/offers/${two}/accept`, { ...TAKE, items: [item("t2", "Ring")] })).toMatchObject({ status: 409, body: { error: expect.stringContaining("one per account of that side") } });
  });
});

describe("unlinking a node", () => {
  it("keeps its meetings and receipts, gives up its side, reopens the partner's offer, fails its requests and stops it signing", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob");
    const offerId = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    const rv = (await b.call("POST", `/api/v1/offers/${offerId}/accept`, TAKE)).body.rendezvous as RendezvousWire;
    // A finished, disputed meeting too: its evidence must survive.
    const other = ((await a.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g9", "Sword")] })).body.offer as OfferWire).id;
    const rv2 = (await b.call("POST", `/api/v1/offers/${other}/accept`, { ...TAKE, botIgn: "GiverBot", items: [item("t9", "Ring")] })).body.rendezvous as RendezvousWire;
    await a.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([{ itemId: "Sword", qty: 1 }], [{ itemId: "Ring", qty: 1 }], "GiverBot"));
    await b.call("POST", `/api/v1/rendezvous/${rv2.id}/receipt`, receipt([], [], "", false));
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    db.prepare("INSERT INTO communism_accounts (node_id, ign, seasonal, slots, free, online, updated_at) VALUES (?, 'BobComm', 0, 8, 8, 1, 0)").run(b.nodeId);
    const req = createGuestRequest(db, pat, b.nodeId, { kind: "deposit", seasonal: false, server: "USEast", count: 1 });
    expect(req.ok).toBe(true);

    expect((await b.call("POST", "/api/v1/nodes/unlink", {})).status).toBe(200);
    expect((db.prepare("SELECT state FROM rendezvous WHERE id = ?").get(rv2.id) as { state: string }).state).toBe("disputed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE rendezvous_id = ?").get(rv2.id) as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT state, taker_gave_up_at FROM rendezvous WHERE id = ?").get(rv.id) as { state: string; taker_gave_up_at: number | null })).toMatchObject({ state: "aborted", taker_gave_up_at: expect.any(Number) });
    expect(offerRow(offerId)).toEqual({ status: "open", taker_node_id: null });
    expect((await a.call("DELETE", `/api/v1/offers/${offerId}`)).status).toBe(200);
    expect((db.prepare("SELECT state FROM guest_requests WHERE id = ?").get((req as { request: { id: number } }).request.id) as { state: string }).state).toBe("failed");
    expect(db.prepare("SELECT COUNT(*) AS n FROM communism_accounts WHERE node_id = ?").get(b.nodeId)).toEqual({ n: 0 });
    expect(nodeById(db, b.nodeId)?.unlinked_at).toEqual(expect.any(Number));
    expect((await b.call("GET", "/api/v1/offers/mine")).status).toBe(401);
    // Its owner's page no longer lists it; a fresh link counts against the limit without it.
    expect(await (await app.request("/me", { headers: { cookie: b.user.cookie } })).text()).not.toContain("Bob-desk");
  });

  it("an offer a deleted meeting left accepted (a database from before) is open again", () => {
    db.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (90, 'z@x.test', 'Z', 0)").run();
    db.prepare("INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES ('n_z', 90, 'z', 'k', '0', 0)").run();
    db.prepare("INSERT INTO offers (id, node_id, bot_ign, seasonal, server, give_json, want_json, status, created_at, updated_at, expires_at) VALUES (77, 'n_z', 'B', 0, 'USEast', '[]', '[]', 'accepted', 0, 0, ?)").run(Date.now() + 1e9);
    // openDb on the same database runs the repair; for :memory: run the same statement it does.
    db.prepare("UPDATE offers SET status = 'open', taker_node_id = NULL WHERE status = 'accepted' AND NOT EXISTS (SELECT 1 FROM rendezvous r WHERE r.offer_id = offers.id)").run();
    expect(offerRow(77).status).toBe("open");
  });
});

describe("long polls hand out again what never reached the node", () => {
  it("a request taken and never answered goes out again after the lease; an answered one does not", async () => {
    const b = await linkedNode("b@x.test", "Bob");
    db.prepare("INSERT INTO communism_accounts (node_id, ign, seasonal, slots, free, online, updated_at) VALUES (?, 'BobComm', 0, 8, 8, 1, 0)").run(b.nodeId);
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    const node = nodeById(db, b.nodeId)!;
    const t0 = Date.now();
    const r1 = createGuestRequest(db, pat, b.nodeId, { kind: "deposit", seasonal: false, server: "USEast", count: 1 }, t0) as { request: GuestRequestWire };
    const r2 = createGuestRequest(db, pat, b.nodeId, { kind: "deposit", seasonal: false, server: "USEast", count: 1 }, t0) as { request: GuestRequestWire };
    expect(takePendingRequests(db, node, t0).map((r) => r.id)).toEqual([r1.request.id, r2.request.id]);
    expect(takePendingRequests(db, node, t0 + 1000)).toEqual([]);
    expect((await b.call("POST", `/api/v1/guest-requests/${r2.request.id}/result`, { ok: true, pending: true, detail: "queued" })).status).toBe(200);
    expect(takePendingRequests(db, node, t0 + TAKE_LEASE_MS + 1).map((r) => r.id)).toEqual([r1.request.id]);
    // A progress note restarts its half hour.
    db.prepare("UPDATE guest_requests SET progress_at = ? WHERE id = ?").run(t0 + GUEST_REQUEST_TTL_MS, r2.request.id);
    sweepGuestRequests(db, t0 + GUEST_REQUEST_TTL_MS + 1000);
    expect((db.prepare("SELECT state FROM guest_requests WHERE id = ?").get(r2.request.id) as { state: string }).state).toBe("taken");
    expect((db.prepare("SELECT state FROM guest_requests WHERE id = ?").get(r1.request.id) as { state: string }).state).toBe("expired");
  });

  it("a sign-in code taken and never answered goes out again after the lease", async () => {
    const l = await linkedNode("l@x.test", "Lena");
    setSettings(db, { loginNodeId: l.nodeId });
    const node = nodeById(db, l.nodeId)!;
    const t0 = Date.now();
    const s = startRealmLogin(db, { userId: null }, t0) as { id: number };
    expect(takePendingLogins(db, node, t0).map((x) => x.id)).toEqual([s.id]);
    expect(takePendingLogins(db, node, t0 + 1000)).toEqual([]);
    expect(takePendingLogins(db, node, t0 + LOGIN_LEASE_MS + 1).map((x) => x.id)).toEqual([s.id]);
    expect(markLoginReady(db, node, s.id, { botIgn: "DeskBot" }, t0 + LOGIN_LEASE_MS + 2)).toMatchObject({ ok: true });
    expect(takePendingLogins(db, node, t0 + 2 * LOGIN_LEASE_MS + 3)).toEqual([]);
  });
});

describe("Realm sign-in", () => {
  it("cannot land on an account that signs in with an email, Google or Discord", async () => {
    const l = await linkedNode("l@x.test", "Lena");
    setSettings(db, { loginNodeId: l.nodeId });
    const node = nodeById(db, l.nodeId)!;
    const boss = person(db, "boss@x.test", "Boss");
    setVerifiedIgn(db, boss.id, "BossChar");
    const s = startRealmLogin(db, { userId: null }) as { id: number; token: string };
    takePendingLogins(db, node);
    markLoginReady(db, node, s.id, { botIgn: "DeskBot" });
    markLoginVerified(db, node, s.id, { ign: "BossChar" });
    expect(finishRealmLogin(db, s.token)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("sign in that way") });
    // A character nobody has proven still makes a fresh account.
    const s2 = startRealmLogin(db, { userId: null }) as { id: number; token: string };
    takePendingLogins(db, node);
    markLoginReady(db, node, s2.id, { botIgn: "DeskBot" });
    markLoginVerified(db, node, s2.id, { ign: "NewChar" });
    expect(finishRealmLogin(db, s2.token)).toMatchObject({ ok: true, mode: "signed-in" });
  });
});

describe("communism items are promised once", () => {
  it("an open withdraw request holds its items: off the board, refused to a second request and to another node's take", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob");
    await b.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [{ ign: "BobComm", seasonal: false, slots: 8, free: 7, online: true }], items: [{ ref: "k1", itemId: "Sword", name: "Sword", enchants: null, count: 0, seasonal: false, botIgn: "BobComm" }] });
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    const quinn = person(db, "quinn@x.test", "Quinn");
    setIgn(db, quinn.id, "QuinnChar");
    expect(createGuestRequest(db, pat, b.nodeId, { kind: "withdraw", server: "USEast", refs: ["k1"] })).toMatchObject({ ok: true });
    expect(createGuestRequest(db, quinn, b.nodeId, { kind: "withdraw", server: "USEast", refs: ["k1"] })).toMatchObject({ ok: false, status: 409 });
    expect(await a.call("POST", "/api/v1/communism/withdraw", { nodeId: b.nodeId, ref: "k1", server: "USEast", botIgn: "GiverBot" })).toMatchObject({ status: 409, body: { error: "someone asked for that item first" } });
    expect(((await a.call("GET", "/api/v1/communism")).body.items as unknown[]).length).toBe(0);
  });

  it("a node carrying out its own take request is not refused by it; another node's take is", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob");
    const c = await linkedNode("c@x.test", "Cara");
    await b.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [{ ign: "BobComm", seasonal: false, slots: 8, free: 7, online: true }], items: [{ ref: "k1", itemId: "Sword", name: "Sword", enchants: null, count: 0, seasonal: false, botIgn: "BobComm" }] });
    expect(createGuestRequest(db, a.user, a.nodeId, { kind: "communism-take", server: "USEast", communism: { nodeId: b.nodeId, ref: "k1" } })).toMatchObject({ ok: true });
    expect((await c.call("POST", "/api/v1/communism/withdraw", { nodeId: b.nodeId, ref: "k1", server: "USEast", botIgn: "GiverBot" })).status).toBe(409);
    expect((await a.call("POST", "/api/v1/communism/withdraw", { nodeId: b.nodeId, ref: "k1", server: "USEast", botIgn: "GiverBot" })).status).toBe(200);
  });

  it("the website's withdraw form names each item's node, so equal refs on two nodes are told apart", async () => {
    const b = await linkedNode("b@x.test", "Bob");
    const c = await linkedNode("c@x.test", "Cara");
    for (const n of [b, c]) await n.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [{ ign: "CommBot", seasonal: false, slots: 8, free: 7, online: true }], items: [{ ref: "same", itemId: "Sword", name: "Sword", enchants: null, count: 0, seasonal: false, botIgn: "CommBot" }] });
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    const body = new URLSearchParams([["refs", `${b.nodeId}~same`], ["refs", `${c.nodeId}~same`], ["server", "USEast"]]);
    const res = await app.request("/communism/withdraw", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: pat.cookie }, body: body.toString(), redirect: "manual" });
    expect(loc(res)).toContain("2 requests queued");
    expect((db.prepare("SELECT node_id FROM guest_requests ORDER BY id").all() as { node_id: string }[]).map((r) => r.node_id)).toEqual([b.nodeId, c.nodeId]);
    // A bare ref two nodes list is ambiguous.
    const bare = await app.request("/communism/withdraw", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: pat.cookie }, body: new URLSearchParams([["refs", "same"], ["server", "USEast"]]).toString(), redirect: "manual" });
    expect(loc(bare)).toContain("not listed any more");
  });
});

describe("an offer's page", () => {
  it("lets a person trade in game and another node's owner take it with their node; the poster can cancel", async () => {
    const a = await linkedNode("a@x.test", "Alice");
    const b = await linkedNode("b@x.test", "Bob");
    const offerId = ((await a.call("POST", "/api/v1/offers", OFFER)).body.offer as OfferWire).id;
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    const page = await (await app.request(`/offers/${offerId}`, { headers: { cookie: pat.cookie } })).text();
    expect(page).toContain("Trade in game");
    expect(await (await app.request(`/offers/${offerId}`, { headers: { cookie: b.user.cookie } })).text()).toContain("Take it with my node");
    expect(await (await app.request("/me", { headers: { cookie: a.user.cookie } })).text()).toContain(`/offers/${offerId}`);
    const take = await app.request(`/offers/${offerId}/accept`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: b.user.cookie }, body: `node=${b.nodeId}`, redirect: "manual" });
    expect(loc(take)).toContain("queued");
    expect(((await b.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[])[0]).toMatchObject({ kind: "offer-accept", offerId, owner: true });
    const trade = await app.request(`/offers/${offerId}/trade`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: pat.cookie }, body: "server=USEast", redirect: "manual" });
    expect(trade.headers.get("location")).toMatch(/^\/meetings\/\d+$/);
    const cancel = await app.request(`/offers/${offerId}/cancel`, { method: "POST", headers: { cookie: a.user.cookie }, redirect: "manual" });
    expect(loc(cancel)).toContain("offer is accepted");
  });
});

describe("ban telemetry", () => {
  it("files an older node's communism lane under its current name", () => {
    db.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (91, 't@x.test', 'T', 0)").run();
    db.prepare("INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES ('n_t', 91, 't', 'k', '0', 0)").run();
    expect(acceptReports(db, "n_t", [{ account: "a".repeat(20), suspendedAt: 1, lastLane: "com" + "mons", heldItems: 0, nodeVersion: "0", build: "7" }])).toBe(1);
    expect((db.prepare("SELECT last_lane FROM ban_reports").get() as { last_lane: string }).last_lane).toBe("communism");
  });
});
