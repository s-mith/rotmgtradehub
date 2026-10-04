import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type GuestRequestWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { addTypedCharacter, createUser, ignOf, setIgn, type User } from "../auth";
import { listEventsFor } from "../events";
import { linkCodeFor, person } from "./people";
import { GUEST_REQUEST_TTL_MS, MAX_OPEN_REQUESTS, createGuestRequest, recentRequestsFor, sweepGuestRequests, takePendingRequests } from "../requests";
import { nodeById } from "../nodes";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null, discord: null });
  vi.stubEnv("ADMIN_EMAILS", "boss@x.test");
});

type Reply = { status: number; body: Record<string, unknown> };
const json = async (res: Response): Promise<Reply> => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

/** An account with one linked node that has heartbeat once (online), and a signer. */
async function linkedNode(email: string, name: string) {
  const user = createUser(db, email, name);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  await call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [{ ign: `${name}Bot`, seasonal: false, online: true }] });
  return { nodeId, call, name, user };
}

const account = (ign: string, seasonal: boolean, slots = 8, free = slots) => ({ ign, seasonal, slots, free, online: true });
const citem = (ref: string, itemId: string, seasonal = false, botIgn = "OliveComm") => ({ ref, itemId, name: `${itemId} name`, enchants: null, count: 0, seasonal, botIgn });
const want = (itemId: string, qty = 1) => ({ itemId, qty, slotsMin: 0, slotsExact: null, enchants: [] });

/** A settings form posts to /me and lands back on its settings section: the page it lands on. */
const landed = async (res: Response, cookie: string) => {
  expect(res.headers.get("location")).toMatch(/^\/me\?settings_(ok|error)=.*#settings$/);
  return (await app.request(res.headers.get("location")!, { headers: { cookie } })).text();
};
const form = (path: string, fields: [string, string][], cookie?: string) => {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: body.toString(), redirect: "manual" });
};
const gwenId = (d: Db) => (d.prepare("SELECT id FROM users WHERE email = 'guest@x.test'").get() as { id: number }).id;
const reqOf = (r: ReturnType<typeof createGuestRequest>): GuestRequestWire => {
  expect(r.ok).toBe(true);
  return (r as { ok: true; request: GuestRequestWire }).request;
};

/** Olive's node with a communism: two seasonal accounts (8 + 4 free) and one non-seasonal (16 slots, 3 free), a few items. */
async function communismNode() {
  const owner = await linkedNode("owner@x.test", "Olive");
  const r = await owner.call("POST", "/api/v1/communism/publish", {
    at: Date.now(),
    accounts: [account("OliveComm", true, 8, 8), account("OliveTwo", true, 8, 4), account("OliveNon", false, 16, 3)],
    items: [citem("s1", "Sword", true), citem("s2", "Ring", true, "OliveTwo"), citem("n1", "Cloak", false, "OliveNon")],
  });
  expect(r.body).toMatchObject({ ok: true, listed: 3, accounts: 3 });
  return owner;
}

describe("deposits and withdraws by anyone signed in", () => {
  it("need an IGN, an online node with room in that half (deposit) or the listed refs of one half (withdraw); shapes are checked", async () => {
    const owner = await communismNode();
    const gwen: User = createUser(db, "guest@x.test", "Gwen");
    const ask = (input: Parameters<typeof createGuestRequest>[3]) => createGuestRequest(db, gwen, owner.nodeId, input);
    // No IGN yet: nothing in game can be arranged.
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 2 })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("IGN") });
    expect(setIgn(db, gwen.id, "Gw en")).toMatchObject({ ok: false });
    expect(setIgn(db, gwen.id, "Gwen")).toEqual({ ok: true });
    expect(ignOf(db, gwen.id)).toBe("Gwen");
    // Deposit: count within one account's free slots of that half.
    expect(ask({ kind: "deposit", seasonal: true, server: "US East", count: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 25 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "deposit", seasonal: "yes" as unknown as boolean, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 9 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("room for 8") });
    expect(ask({ kind: "deposit", seasonal: false, server: "USEast", count: 4 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("room for 3") });
    const dep = reqOf(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 8 }));
    expect(dep).toMatchObject({ nodeId: owner.nodeId, requester: { userId: gwen.id, displayName: "Gwen" }, owner: false, ign: "Gwen", kind: "deposit", seasonal: true, server: "USEast", count: 8, refs: null, want: null, offerId: null, communism: null, state: "pending", result: null });
    // Withdraw: refs must be listed on that node, in one half, at most 8.
    expect(ask({ kind: "withdraw", server: "USEast", refs: [] })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["s1", "s1"] })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["bad ref"] })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["s1", "gone"] })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("gone") });
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["s1", "n1"] })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("one pool half") });
    expect(ask({ kind: "withdraw", server: "USEast", refs: Array.from({ length: 9 }, (_, i) => `r${i}`) })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("at most 8") });
    const wd = reqOf(ask({ kind: "withdraw", server: "EUWest", refs: ["s2", "s1"] }));
    expect(wd).toMatchObject({ kind: "withdraw", ign: "Gwen", seasonal: true, server: "EUWest", count: null, refs: ["s2", "s1"] });
    // Owner-only kinds are refused to a guest; unknown kinds too.
    expect(ask({ kind: "offer-create", seasonal: true, server: "USEast", refs: ["s1"], want: [want("Ring")] })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "communism-give", seasonal: true, server: "USEast", refs: ["x"], communism: { nodeId: "n_x" } })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "steal", seasonal: true, server: "USEast" })).toMatchObject({ ok: false, status: 400 });
    expect(createGuestRequest(db, gwen, "n_nobody", { kind: "deposit", seasonal: true, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 404 });
    // An item someone's node is meeting the contributor for is not withdrawable; an offline node takes nothing.
    const bob = await linkedNode("bob@x.test", "Bob");
    expect((await bob.call("POST", "/api/v1/communism/withdraw", { nodeId: owner.nodeId, ref: "n1", server: "USEast", botIgn: "BobBot" })).status).toBe(200);
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["n1"] })).toMatchObject({ ok: false, status: 409 });
    db.prepare("UPDATE nodes SET last_seen_at = 1 WHERE id = ?").run(owner.nodeId);
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("offline") });
    expect(ask({ kind: "withdraw", server: "USEast", refs: ["s1"] })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("offline") });
    // The owner may deposit into their own communism too, as any person would.
    setIgn(db, owner.user.id, "Olive");
    db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now(), owner.nodeId);
    expect(reqOf(createGuestRequest(db, owner.user, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 }))).toMatchObject({ owner: true, ign: "Olive", kind: "deposit" });
    // At most ten open per node per person.
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) createGuestRequest(db, owner.user, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 });
    expect(createGuestRequest(db, owner.user, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 409 });
  });

  it("the node takes pending requests oldest first, posts progress notes that keep them open, then done or failed; the sweep expires the forgotten", async () => {
    const owner = await communismNode();
    const gwen = createUser(db, "guest@x.test", "Gwen");
    setIgn(db, gwen.id, "Gwen");
    const t0 = Date.now();
    const depId = reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 2 }, t0)).id;
    const wdId = reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "withdraw", server: "EUWest", refs: ["n1"] }, t0 + 1)).id;

    // Another node sees nothing; the owner's node gets both, oldest first, and they are now taken.
    const other = await linkedNode("other@x.test", "Otto");
    expect((await other.call("GET", "/api/v1/guest-requests")).body).toEqual({ requests: [] });
    const taken = (await owner.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(taken.map((r) => [r.id, r.kind, r.state])).toEqual([[depId, "deposit", "taken"], [wdId, "withdraw", "taken"]]);
    expect(taken[0]).toMatchObject({ nodeId: owner.nodeId, requester: { userId: gwen.id, displayName: "Gwen" }, owner: false, ign: "Gwen", seasonal: true, server: "USEast", count: 2, refs: null, want: null, offerId: null, communism: null, result: null });
    expect(taken[0]).not.toHaveProperty("nodeName");
    expect(taken[1]).toMatchObject({ seasonal: false, server: "EUWest", count: null, refs: ["n1"] });
    expect((await owner.call("GET", "/api/v1/guest-requests")).body).toEqual({ requests: [] });

    // Bad reports are 400; a progress note keeps the row taken and is shown; the bot named reaches the person.
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: "yes" })).status).toBe(400);
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true, pending: true, botIgn: "not a name" })).status).toBe(400);
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true, pending: true, requestId: 7, detail: "queued" })).body).toEqual({ ok: true, state: "taken" });
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true, pending: true, requestId: 7, detail: "OliveComm is logging in", botIgn: "OliveComm" })).body).toEqual({ ok: true, state: "taken" });
    expect(db.prepare("SELECT state, result_json FROM guest_requests WHERE id = ?").get(depId)).toEqual({ state: "taken", result_json: JSON.stringify({ ok: true, pending: true, detail: "OliveComm is logging in", requestId: 7, botIgn: "OliveComm" }) });
    const progress = listEventsFor(db, gwen.id, 5);
    expect(progress[0]).toMatchObject({ kind: "request-progress", text: expect.stringContaining("/trade OliveComm on USEast") });
    expect(recentRequestsFor(db, gwen.id)[1]).toMatchObject({ id: depId, nodeName: "Olive-desk", state: "taken", result: { pending: true, botIgn: "OliveComm" } });
    const me = await (await app.request("/me", { headers: { cookie: person(db, "guest@x.test").cookie } })).text();
    expect(me).toContain("/trade OliveComm");
    expect(me).toContain("the node is on it");
    expect(me).toContain('data-live="/activity/stream"');

    // Final reports close; a closed request takes no more; a stranger node gets 404.
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true, requestId: 7, detail: "traded on USEast" })).body).toEqual({ ok: true, state: "done" });
    expect((await owner.call("POST", `/api/v1/guest-requests/${wdId}/result`, { ok: false, error: "player never showed" })).body).toEqual({ ok: true, state: "failed" });
    expect((await owner.call("POST", `/api/v1/guest-requests/${wdId}/result`, { ok: true })).status).toBe(409);
    expect((await other.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true })).status).toBe(404);
    expect(db.prepare("SELECT id, state, result_json FROM guest_requests ORDER BY id").all()).toEqual([
      { id: depId, state: "done", result_json: JSON.stringify({ ok: true, detail: "traded on USEast", requestId: 7 }) },
      { id: wdId, state: "failed", result_json: JSON.stringify({ ok: false, error: "player never showed" }) },
    ]);
    const events = listEventsFor(db, gwen.id, 5);
    expect(events[0]).toMatchObject({ kind: "request-failed", href: "/me", text: expect.stringContaining("player never showed") });
    expect(events[1]).toMatchObject({ kind: "request-done", href: "/me", text: expect.stringContaining("is done: traded on USEast") });
    const done = await (await app.request("/me", { headers: { cookie: person(db, "guest@x.test").cookie } })).text();
    expect(done).toContain("player never showed");
    expect(done).toContain("traded on USEast");

    // Requests nobody answered within 30 minutes of queuing expire, whether pending or taken.
    const t1 = t0 + 10_000;
    const p = reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 }, t1));
    const q = reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 }, t1 + 1));
    const node = nodeById(db, owner.nodeId)!;
    expect(takePendingRequests(db, node, t1 + 2).map((r) => r.state)).toEqual(["taken", "taken"]);
    db.prepare("UPDATE guest_requests SET state = 'pending' WHERE id = ?").run(q.id);
    sweepGuestRequests(db, t1 + GUEST_REQUEST_TTL_MS - 1);
    expect(db.prepare("SELECT state FROM guest_requests WHERE id >= ? ORDER BY id").all(p.id)).toEqual([{ state: "taken" }, { state: "pending" }]);
    sweepGuestRequests(db, t1 + GUEST_REQUEST_TTL_MS + 1);
    expect(db.prepare("SELECT state FROM guest_requests WHERE id >= ? ORDER BY id").all(p.id)).toEqual([{ state: "expired" }, { state: "expired" }]);
    expect(takePendingRequests(db, node, t1 + GUEST_REQUEST_TTL_MS + 2)).toEqual([]);
  });

  it("website: communism page queues a deposit and a withdraw of picked items for a person with an IGN, and points those without to settings", async () => {
    const owner = await communismNode();
    createUser(db, "guest@x.test", "Gwen");
    const cookie = person(db, "guest@x.test").cookie;
    const page = await (await app.request("/communism", { headers: { cookie } })).text();
    expect(page).toContain("Sword name");
    expect(page).toContain('href="/me#settings"');
    expect(page).not.toContain('action="/communism/deposit"');
    expect(page).not.toContain("items as Gwen");
    // Settings takes the IGN (letters only).
    expect(await landed(await form("/me", [["do", "ign"], ["ign", "Gw3n"]], cookie), cookie)).toContain("letters only");
    expect(ignOf(db, gwenId(db))).toBeNull();
    expect(await landed(await form("/me", [["do", "ign"], ["ign", "Gwen"]], cookie), cookie)).toContain('value="Gwen"');
    const ready = await (await app.request("/communism", { headers: { cookie } })).text();
    expect(ready).toContain('action="/communism/deposit"');
    expect(ready).toContain("items as Gwen");
    expect(ready).toContain("12</b>/16 free on 2 accounts"); // seasonal: 8 + 4 free of 16 slots on two accounts
    const dep = await form("/communism/deposit", [["node", owner.nodeId], ["seasonal", "1"], ["count", "3"], ["server", "USEast"]], cookie);
    expect(dep.status).toBe(302);
    expect(dep.headers.get("location")).toMatch(/^\/me\?ok=.*#request-\d+$/);
    const tooMany = await form("/communism/deposit", [["node", owner.nodeId], ["seasonal", "0"], ["count", "9"], ["server", "USEast"]], cookie);
    expect(tooMany.headers.get("location")).toContain("/communism?error=");
    const wd = await form("/communism/withdraw", [["node", owner.nodeId], ["refs", "s1"], ["refs", "s2"], ["server", "EUWest"], ["do", "withdraw"]], cookie);
    expect(wd.headers.get("location")).toMatch(/^\/me\?ok=/);
    const taken = (await owner.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(taken.map((r) => [r.kind, r.state, r.ign])).toEqual([["deposit", "taken", "Gwen"], ["withdraw", "taken", "Gwen"]]);
    expect(taken[0]).toMatchObject({ seasonal: true, count: 3, server: "USEast" });
    expect(taken[1]).toMatchObject({ seasonal: true, refs: ["s1", "s2"], server: "EUWest" });
    const me = await (await app.request("/me", { headers: { cookie } })).text();
    expect(me).toContain("Deposit 3 items into Olive-desk");
    expect(me).toContain("Withdraw 2 items from Olive-desk");
    // An empty name adds nothing; removing the character forgets it.
    expect(await landed(await form("/me", [["do", "ign"], ["ign", ""]], cookie), cookie)).toContain("Type the character");
    expect(await landed(await form("/me", [["do", "ign-remove"], ["ign", "Gwen"]], cookie), cookie)).toContain("Gwen removed.");
    expect(ignOf(db, gwenId(db))).toBeNull();
  });

  it("a person with several characters picks which one meets the bot; the main one when they do not", async () => {
    const owner = await communismNode();
    const gwen = createUser(db, "guest@x.test", "Gwen");
    addTypedCharacter(db, gwen.id, "Gwen");
    addTypedCharacter(db, gwen.id, "GwenAlt");
    expect(reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 2 })).ign).toBe("Gwen");
    expect(reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "withdraw", server: "USEast", refs: ["s1"], ign: "gwenalt" })).ign).toBe("GwenAlt");
    expect(createGuestRequest(db, gwen, owner.nodeId, { kind: "withdraw", server: "USEast", refs: ["s2"], ign: "Stranger" })).toMatchObject({ ok: false, status: 403, error: "Stranger is not one of your characters" });
    // The page offers the choice once there is one to make.
    const page = await (await app.request("/communism", { headers: { cookie: person(db, "guest@x.test").cookie } })).text();
    expect(page).toContain('<select id="withdraw-ign" name="ign" form="withdraw-form"><option value="Gwen">Gwen</option><option value="GwenAlt">GwenAlt</option></select>');
  });

  it("a withdraw from several nodes is a request per node, handed out one after another; each waits its turn without ageing", async () => {
    const olive = await communismNode();
    const pia = await linkedNode("pia@x.test", "Pia");
    expect((await pia.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("PiaComm", true)], items: [citem("p1", "Helm", true, "PiaComm")] })).body).toMatchObject({ ok: true });
    createUser(db, "guest@x.test", "Gwen");
    setIgn(db, gwenId(db), "Gwen");
    const cookie = person(db, "guest@x.test").cookie;
    const wd = await form("/communism/withdraw", [["refs", "s1"], ["refs", "p1"], ["refs", "s2"], ["server", "EUWest"], ["do", "withdraw"]], cookie);
    expect(decodeURIComponent(wd.headers.get("location") ?? "")).toMatch(/^\/me\?ok=2 requests queued, one per node/);
    // Olive's goes out at once; Pia's waits until Olive's is over.
    const first = (await olive.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(first.map((r) => r.refs)).toEqual([["s1", "s2"]]);
    expect((await pia.call("GET", "/api/v1/guest-requests")).body.requests).toEqual([]);
    expect(await (await app.request("/me", { headers: { cookie } })).text()).toContain(`after #${first[0].id}`);
    // Its half hour has not started: a sweep long after it was queued leaves it alone while it waits.
    sweepGuestRequests(db, Date.now() + GUEST_REQUEST_TTL_MS - 1000);
    expect((await olive.call("POST", `/api/v1/guest-requests/${first[0].id}/result`, { ok: true, detail: "traded" })).body).toMatchObject({ state: "done" });
    const second = (await pia.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(second.map((r) => [r.refs, r.state])).toEqual([[["p1"], "taken"]]);
    // One half of the pool per withdraw, whatever the nodes.
    const mixed = await form("/communism/withdraw", [["refs", "n1"], ["refs", "p1"], ["server", "EUWest"], ["do", "withdraw"]], cookie);
    expect(decodeURIComponent(mixed.headers.get("location") ?? "")).toContain("one half of the pool");
    // One node refusing (Pia's is offline now) queues none of them.
    const before = recentRequestsFor(db, gwenId(db)).length;
    db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now() - 10 * 60_000, pia.nodeId);
    const refused = await form("/communism/withdraw", [["refs", "s1"], ["refs", "p1"], ["server", "EUWest"], ["do", "withdraw"]], cookie);
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("nothing queued: that node is offline right now");
    expect(recentRequestsFor(db, gwenId(db)).length).toBe(before);
  });

  it("a node waiting on the queue is answered the moment a request lands, and after the wait otherwise", async () => {
    const owner = await communismNode();
    const gwen = createUser(db, "guest@x.test", "Gwen");
    setIgn(db, gwen.id, "Gwen");
    // Nothing pending: an empty answer after the wait (short here), not before.
    const t0 = Date.now();
    expect((await owner.call("GET", "/api/v1/guest-requests?wait=0.2")).body).toEqual({ requests: [] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    // A request queued while waiting ends the wait with it.
    const waiting = owner.call("GET", "/api/v1/guest-requests?wait=20");
    await new Promise((r) => setTimeout(r, 30));
    const t1 = Date.now();
    const id = reqOf(createGuestRequest(db, gwen, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 2 })).id;
    const got = (await waiting).body.requests as { id: number }[];
    expect(got.map((r) => r.id)).toEqual([id]);
    expect(Date.now() - t1).toBeLessThan(2000);
    // The wait is capped.
    const t2 = Date.now();
    expect((await owner.call("GET", "/api/v1/guest-requests?wait=0")).body).toEqual({ requests: [] });
    expect(Date.now() - t2).toBeLessThan(200);
  });
});
