import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type GrantWire, type GuestRequestWire, type OfferWire, type PublishVaultsRequest, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp, parseWantText } from "../app";
import { register, type User } from "../auth";
import { GUEST_REQUEST_TTL_MS, createGuestRequest, guestVaultsFor, sweepGuestRequests, takePendingRequests } from "../grants";
import { nodeById } from "../nodes";
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

async function linkedNode(email: string, name: string) {
  const user = register(db, email, "correct horse battery", name);
  expect(user.ok).toBe(true);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery", publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  return { nodeId, call, name, user: (user as { ok: true; user: User }).user };
}

const guest = (email = "guest@x.test", name = "Gwen"): User => {
  const r = register(db, email, "correct horse battery", name);
  expect(r.ok).toBe(true);
  return (r as { ok: true; user: User }).user;
};

const GRANT = { email: "guest@x.test", ign: "GwenVault", slotsSeasonal: 8, slotsNonseasonal: 4, role: "deposit", trade: false };

const vaultItem = (ref: string, itemId: string, count = 0, online = true) => ({ ref, itemId, name: `${itemId} name`, enchants: count ? [1] : null, count, online });
const publish = (userId: number, seasonalItems = [vaultItem("s1", "Sword", 2), vaultItem("s2", "Ring")], nonItems = [vaultItem("n1", "Cloak", 0, false)]): PublishVaultsRequest => ({
  guests: [{ userId, seasonal: { slots: 8, used: seasonalItems.length, items: seasonalItems }, nonseasonal: { slots: 4, used: nonItems.length, items: nonItems } }],
  at: Date.now(),
});
const want = (itemId: string, qty = 1) => ({ itemId, qty, slotsMin: 0, slotsExact: null, enchants: [] });

/** An owner node, a guest account, and one grant with the given overrides. */
async function granted(overrides: Partial<typeof GRANT> = {}) {
  const owner = await linkedNode("owner@x.test", "Olive");
  const g = guest();
  const r = await owner.call("POST", "/api/v1/grants", { ...GRANT, ...overrides });
  expect(r.status).toBe(200);
  return { owner, g, grant: r.body.grant as GrantWire };
}

const form = (path: string, fields: [string, string][], cookie?: string) => {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: body.toString(), redirect: "manual" });
};
async function loginCookie(email: string): Promise<string> {
  const r = await form("/login", [["email", email], ["password", "correct horse battery"]]);
  expect(r.status).toBe(302);
  return r.headers.get("set-cookie")!.split(";")[0];
}

describe("grants", () => {
  it("creates, lists, updates and deletes; unknown email 404, duplicate 409, the owner and bad fields 400, another node's grant 404", async () => {
    const owner = await linkedNode("owner@x.test", "Olive");
    const g = guest();
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, email: "nobody@x.test" })).status).toBe(404);
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, email: "owner@x.test" })).status).toBe(400);
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, ign: "bad name!" })).status).toBe(400);
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, slotsSeasonal: 201 })).status).toBe(400);
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, role: "boss" })).status).toBe(400);
    expect((await owner.call("POST", "/api/v1/grants", { ...GRANT, trade: "yes" })).status).toBe(400);
    const created = await owner.call("POST", "/api/v1/grants", GRANT);
    expect(created.status).toBe(200);
    const grant = created.body.grant as GrantWire;
    expect(grant).toMatchObject({ nodeId: owner.nodeId, guest: { userId: g.id, displayName: "Gwen", email: "guest@x.test" }, ign: "GwenVault", slotsSeasonal: 8, slotsNonseasonal: 4, role: "deposit", trade: false, paused: false });
    expect((await owner.call("POST", "/api/v1/grants", GRANT)).status).toBe(409);
    expect(((await owner.call("GET", "/api/v1/grants")).body.grants as GrantWire[]).map((x) => x.id)).toEqual([grant.id]);

    const upd = await owner.call("PUT", `/api/v1/grants/${grant.id}`, { role: "withdraw-own", trade: true, slotsSeasonal: 16, paused: true });
    expect(upd.status).toBe(200);
    expect(upd.body.grant).toMatchObject({ id: grant.id, role: "withdraw-own", trade: true, slotsSeasonal: 16, slotsNonseasonal: 4, paused: true, ign: "GwenVault" });
    expect((await owner.call("PUT", `/api/v1/grants/${grant.id}`, { role: "king" })).status).toBe(400);
    expect((await owner.call("PUT", `/api/v1/grants/999`, { role: "co-owner" })).status).toBe(404);

    // Another node cannot see, edit or revoke it.
    const other = await linkedNode("other@x.test", "Otto");
    expect((await other.call("GET", "/api/v1/grants")).body).toEqual({ grants: [] });
    expect((await other.call("PUT", `/api/v1/grants/${grant.id}`, { paused: false })).status).toBe(404);
    expect((await other.call("DELETE", `/api/v1/grants/${grant.id}`)).status).toBe(404);

    // Revoking drops the published vault and expires what was waiting.
    expect((await owner.call("PUT", `/api/v1/grants/${grant.id}`, { paused: false })).status).toBe(200);
    expect((await owner.call("POST", "/api/v1/vaults/publish", publish(g.id))).body).toEqual({ ok: true });
    const req = createGuestRequest(db, g, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 2 });
    expect(req.ok).toBe(true);
    expect((await owner.call("DELETE", `/api/v1/grants/${grant.id}`)).body).toEqual({ ok: true });
    expect((await owner.call("DELETE", `/api/v1/grants/${grant.id}`)).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM guest_vaults WHERE node_id = ?").get(owner.nodeId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM guest_requests").all()).toEqual([{ state: "expired" }]);
    expect(guestVaultsFor(db, g.id)).toEqual([]);
    // Unsigned callers never reach the grant routes.
    expect((await app.request("/api/v1/grants")).status).toBe(401);
  });

  it("publish replaces the node's guest vaults, ignores strangers, and the guest sees slots, used and items", async () => {
    const { owner, g } = await granted();
    const stranger = guest("s@x.test", "Sid");
    const body = publish(g.id);
    body.guests.push({ userId: stranger.id, seasonal: { slots: 1, used: 0, items: [] }, nonseasonal: { slots: 1, used: 0, items: [] } });
    expect((await owner.call("POST", "/api/v1/vaults/publish", body)).body).toEqual({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM guest_vaults").get()).toEqual({ n: 2 });
    const [v] = guestVaultsFor(db, g.id);
    expect(v).toMatchObject({ nodeId: owner.nodeId, nodeName: "Olive-desk", owner: "Olive", ign: "GwenVault", role: "deposit", trade: false, paused: false });
    expect(v.seasonal).toMatchObject({ granted: 8, slots: 8, used: 2 });
    expect(v.seasonal.items.map((i) => [i.ref, i.name, i.count, i.online])).toEqual([["s1", "Sword name", 2, true], ["s2", "Ring name", 0, true]]);
    expect(v.nonseasonal).toMatchObject({ granted: 4, slots: 4, used: 1, items: [expect.objectContaining({ ref: "n1", online: false })] });
    // A second publish replaces, never merges.
    expect((await owner.call("POST", "/api/v1/vaults/publish", publish(g.id, [], []))).status).toBe(200);
    expect(guestVaultsFor(db, g.id)[0].seasonal).toMatchObject({ used: 0, items: [] });
    expect((await owner.call("POST", "/api/v1/vaults/publish", { guests: [{ userId: g.id, seasonal: { slots: 1, used: 0, items: [{ ref: "x", itemId: "Y", name: "y", enchants: null, count: 9, online: true }] }, nonseasonal: { slots: 0, used: 0, items: [] } }], at: 1 })).status).toBe(400);
  });

  it("refuses requests the grant does not allow: over free slots, withdraw without the role, offer-* without trade, anything while paused", async () => {
    const { owner, g, grant } = await granted();
    await owner.call("POST", "/api/v1/vaults/publish", publish(g.id));
    const ask = (input: Parameters<typeof createGuestRequest>[3]) => createGuestRequest(db, g, owner.nodeId, input);
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 7 })).toMatchObject({ ok: false, status: 409 }); // 8 slots, 2 used
    expect(ask({ kind: "deposit", seasonal: false, server: "USEast", count: 3 })).toMatchObject({ ok: true });
    expect(ask({ kind: "deposit", seasonal: true, server: "US East", count: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", refs: ["s1"] })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "offer-create", seasonal: true, server: "USEast", refs: ["s1"], want: [want("Ring")] })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "offer-accept", offerId: 1 })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "offer-cancel", offerId: 1 })).toMatchObject({ ok: false, status: 403 });
    expect(ask({ kind: "steal", seasonal: true, server: "USEast" })).toMatchObject({ ok: false, status: 400 });

    // With the role and trade: refs must be in the published half; want lines are checked like an offer's.
    await owner.call("PUT", `/api/v1/grants/${grant.id}`, { role: "withdraw-own", trade: true });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", refs: ["s1", "n1"] })).toMatchObject({ ok: false, status: 409 });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", refs: [] })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", refs: ["s1", "s2"] })).toMatchObject({ ok: true });
    expect(ask({ kind: "offer-create", seasonal: false, server: "USEast", refs: ["n1"], want: [want("Ring", 9)] })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "offer-create", seasonal: false, server: "USEast", refs: ["n1"], want: [want("Ring", 5)] })).toMatchObject({ ok: false, status: 409 });
    const oc = ask({ kind: "offer-create", seasonal: false, server: "USEast", refs: ["n1"], want: [want("Ring", 2)] });
    expect(oc).toMatchObject({ ok: true, request: { kind: "offer-create", refs: ["n1"], want: [want("Ring", 2)], seasonal: false, ign: "GwenVault" } });
    expect(ask({ kind: "offer-accept", offerId: 999 })).toMatchObject({ ok: false, status: 404 });
    expect(ask({ kind: "offer-cancel", offerId: 999 })).toMatchObject({ ok: false, status: 404 });

    // Paused: nothing goes through; a stranger has no vault at all.
    await owner.call("PUT", `/api/v1/grants/${grant.id}`, { paused: true });
    expect(ask({ kind: "deposit", seasonal: true, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 403 });
    expect(createGuestRequest(db, guest("s@x.test", "Sid"), owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 })).toMatchObject({ ok: false, status: 404 });
  });

  it("the node takes pending requests, which become taken, and posts done or failed; the sweep expires the forgotten", async () => {
    const { owner, g } = await granted({ role: "co-owner" });
    await owner.call("POST", "/api/v1/vaults/publish", publish(g.id));
    const t0 = Date.now();
    const dep = createGuestRequest(db, g, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 2 }, t0);
    const wd = createGuestRequest(db, g, owner.nodeId, { kind: "withdraw", seasonal: false, server: "EUWest", refs: ["n1"] }, t0 + 1);
    expect(dep.ok && wd.ok).toBe(true);
    const depId = (dep as { ok: true; request: GuestRequestWire }).request.id;
    const wdId = (wd as { ok: true; request: GuestRequestWire }).request.id;

    // Another node sees nothing; the owner's node gets both, oldest first, and they are now taken.
    const other = await linkedNode("other@x.test", "Otto");
    expect((await other.call("GET", "/api/v1/guest-requests")).body).toEqual({ requests: [] });
    const taken = (await owner.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(taken.map((r) => [r.id, r.kind, r.state])).toEqual([[depId, "deposit", "taken"], [wdId, "withdraw", "taken"]]);
    expect(taken[0]).toMatchObject({ nodeId: owner.nodeId, guest: { userId: g.id, displayName: "Gwen" }, ign: "GwenVault", seasonal: true, server: "USEast", count: 2, refs: null, want: null, offerId: null, result: null });
    expect(taken[1]).toMatchObject({ seasonal: false, server: "EUWest", count: null, refs: ["n1"] });
    expect((await owner.call("GET", "/api/v1/guest-requests")).body).toEqual({ requests: [] });

    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: "yes" })).status).toBe(400);
    expect((await owner.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true, requestId: 7, detail: "met on USEast" })).body).toEqual({ ok: true, state: "done" });
    expect((await owner.call("POST", `/api/v1/guest-requests/${wdId}/result`, { ok: false, error: "guest never showed" })).body).toEqual({ ok: true, state: "failed" });
    expect((await owner.call("POST", `/api/v1/guest-requests/${wdId}/result`, { ok: true })).status).toBe(409);
    expect((await other.call("POST", `/api/v1/guest-requests/${depId}/result`, { ok: true })).status).toBe(404);
    expect(db.prepare("SELECT id, state, result_json FROM guest_requests ORDER BY id").all()).toEqual([
      { id: depId, state: "done", result_json: JSON.stringify({ ok: true, detail: "met on USEast", requestId: 7 }) },
      { id: wdId, state: "failed", result_json: JSON.stringify({ ok: false, error: "guest never showed" }) },
    ]);

    // Requests nobody answered within 30 minutes of queuing expire, whether pending or taken.
    const t1 = t0 + 10_000;
    const p = createGuestRequest(db, g, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 }, t1);
    const q = createGuestRequest(db, g, owner.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count: 1 }, t1 + 1);
    expect(p.ok && q.ok).toBe(true);
    const node = nodeById(db, owner.nodeId)!;
    expect(takePendingRequests(db, node, t1 + 2).map((r) => r.state)).toEqual(["taken", "taken"]);
    db.prepare("UPDATE guest_requests SET state = 'pending' WHERE id = ?").run((q as { ok: true; request: GuestRequestWire }).request.id);
    sweepGuestRequests(db, t1 + GUEST_REQUEST_TTL_MS - 1);
    expect(db.prepare("SELECT state FROM guest_requests WHERE id > ? ORDER BY id").all(wdId)).toEqual([{ state: "taken" }, { state: "pending" }]);
    sweepGuestRequests(db, t1 + GUEST_REQUEST_TTL_MS + 1);
    expect(db.prepare("SELECT state FROM guest_requests WHERE id > ? ORDER BY id").all(wdId)).toEqual([{ state: "expired" }, { state: "expired" }]);
    expect(takePendingRequests(db, node, t1 + GUEST_REQUEST_TTL_MS + 2)).toEqual([]);
  });
});

describe("offers on behalf of guests", () => {
  const OFFER = { botIgn: "OliveBot", seasonal: false, server: "USEast", give: [{ ref: "g1", itemId: "Sword", enchants: null, count: 0 }], want: [want("Ring", 2)] };
  const TAKE = { botIgn: "OttoBot", items: [{ ref: "t1", itemId: "Ring", enchants: null, count: 0 }, { ref: "t2", itemId: "Ring", enchants: null, count: 0 }] };

  it("needs a live trade grant (403 otherwise) and then shows the guest as poster, hides the offer while paused, and names the guest to the partner", async () => {
    const { owner, g, grant } = await granted({ trade: false });
    const other = await linkedNode("other@x.test", "Otto");
    expect((await owner.call("POST", "/api/v1/offers", { ...OFFER, onBehalfOf: g.id })).status).toBe(403);
    expect((await owner.call("POST", "/api/v1/offers", { ...OFFER, onBehalfOf: 999 })).status).toBe(403);
    expect((await owner.call("POST", "/api/v1/offers", { ...OFFER, onBehalfOf: "gwen" })).status).toBe(400);
    expect((await other.call("POST", "/api/v1/offers", { ...OFFER, onBehalfOf: g.id })).status).toBe(403); // no grant on that node
    await owner.call("PUT", `/api/v1/grants/${grant.id}`, { trade: true });
    const created = await owner.call("POST", "/api/v1/offers", { ...OFFER, onBehalfOf: g.id });
    expect(created.status).toBe(200);
    const offer = created.body.offer as OfferWire;
    expect(offer).toMatchObject({ poster: "Gwen", mine: true, onBehalfOf: g.id });
    expect(db.prepare("SELECT for_user_id FROM offers WHERE id = ?").get(offer.id)).toEqual({ for_user_id: g.id });
    // The node's own offers count against the same limit: a second one is refused as usual.
    expect((await owner.call("POST", "/api/v1/offers", OFFER)).status).toBe(409);
    expect(((await other.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).map((o) => [o.poster, o.mine, o.onBehalfOf])).toEqual([["Gwen", false, g.id]]);
    expect(((await owner.call("GET", "/api/v1/offers/mine")).body.offers as OfferWire[]).map((o) => o.poster)).toEqual(["Gwen"]);

    // Pausing the guest hides the offer and stops it being accepted; unpausing brings it back.
    await owner.call("PUT", `/api/v1/grants/${grant.id}`, { paused: true });
    expect(((await other.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(0);
    expect((await other.call("POST", `/api/v1/offers/${offer.id}/accept`, TAKE)).status).toBe(409);
    await owner.call("PUT", `/api/v1/grants/${grant.id}`, { paused: false });
    expect(((await other.call("GET", "/api/v1/offers?open=1")).body.offers as OfferWire[]).length).toBe(1);

    // Accepting on behalf of a guest of the taker's node needs a trade grant there too; then the giver sees that guest as the partner.
    expect((await other.call("POST", `/api/v1/offers/${offer.id}/accept`, { ...TAKE, onBehalfOf: g.id })).status).toBe(403);
    const otherGrant = (await other.call("POST", "/api/v1/grants", { ...GRANT, ign: "GwenAtOtto", trade: true })).body.grant as GrantWire;
    expect(otherGrant.guest.userId).toBe(g.id);
    const acc = await other.call("POST", `/api/v1/offers/${offer.id}/accept`, { ...TAKE, onBehalfOf: g.id });
    expect(acc.status).toBe(200);
    expect((acc.body.rendezvous as RendezvousWire).partner).toEqual({ botIgn: "OliveBot", poster: "Gwen" });
    const giverView = ((await owner.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[])[0];
    expect(giverView.partner).toEqual({ botIgn: "OttoBot", poster: "Gwen" });
    expect(db.prepare("SELECT taker_for_user_id FROM offers WHERE id = ?").get(offer.id)).toEqual({ taker_for_user_id: g.id });
  });
});

describe("vault website", () => {
  it("lists the grant on /vaults, shows the published vault, and a deposit form queues a pending request the node then takes", async () => {
    const { owner, g } = await granted({ role: "withdraw-own", trade: true });
    await owner.call("POST", "/api/v1/vaults/publish", publish(g.id));
    expect((await app.request("/vaults")).status).toBe(302);
    const cookie = await loginCookie("guest@x.test");
    const me = await (await app.request("/me", { headers: { cookie } })).text();
    expect(me).toContain('href="/vaults"');
    const list = await (await app.request("/vaults", { headers: { cookie } })).text();
    expect(list).toContain("Olive");
    expect(list).toContain("Olive-desk");
    expect(list).toContain("GwenVault");
    expect(list).toContain("2/8");
    expect(list).toContain("1/4");
    expect(list).toContain("withdraw-own");
    expect(list).toContain(`href="/vaults/${owner.nodeId}"`);

    const page = await app.request(`/vaults/${owner.nodeId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Sword name");
    expect(html).toContain("2 enchants");
    expect(html).toContain("Cloak name");
    expect(html).toContain('name="refs" value="s1"');
    expect(html).toContain("6 free");
    expect(html).toContain('name="want"');
    expect(html).toContain("none yet");
    // Someone without a grant gets nothing; a stranger's cookie sees no vault.
    const strangerCookie = (guest("s@x.test", "Sid"), await loginCookie("s@x.test"));
    expect((await app.request(`/vaults/${owner.nodeId}`, { headers: { cookie: strangerCookie } })).status).toBe(404);

    // Queue a deposit from the form: pending, listed on the page, then taken by the node.
    const dep = await form(`/vaults/${owner.nodeId}/requests`, [["kind", "deposit"], ["seasonal", "1"], ["server", "USEast"], ["count", "3"]], cookie);
    expect(dep.status).toBe(302);
    expect(dep.headers.get("location")).toMatch(new RegExp(`^/vaults/${owner.nodeId}\\?queued=\\d+$`));
    const tooMany = await form(`/vaults/${owner.nodeId}/requests`, [["kind", "deposit"], ["seasonal", "1"], ["server", "USEast"], ["count", "9"]], cookie);
    expect(tooMany.headers.get("location")).toContain("error=");
    const after = await (await app.request(`/vaults/${owner.nodeId}`, { headers: { cookie } })).text();
    expect(after).toContain("deposit 3 on USEast");
    expect(after).toContain("pending");
    expect(db.prepare("SELECT kind, state, seasonal, server, count, user_id FROM guest_requests").all()).toEqual([{ kind: "deposit", state: "pending", seasonal: 1, server: "USEast", count: 3, user_id: g.id }]);

    // A withdraw with two checked refs, and an offer with want lines from the textarea.
    const wd = await form(`/vaults/${owner.nodeId}/requests`, [["seasonal", "1"], ["refs", "s1"], ["refs", "s2"], ["server", "EUWest"], ["kind", "withdraw"]], cookie);
    expect(wd.headers.get("location")).toContain("queued=");
    const oc = await form(`/vaults/${owner.nodeId}/requests`, [["seasonal", "0"], ["refs", "n1"], ["server", "USEast"], ["want", "Ring 2 1\nCloak 1 0 3\n"], ["kind", "offer-create"]], cookie);
    expect(oc.headers.get("location")).toContain("queued=");
    expect(parseWantText("Ring 2 1\n\nCloak 1 0 3")).toEqual([{ itemId: "Ring", qty: 2, slotsMin: 1, slotsExact: null, enchants: [] }, { itemId: "Cloak", qty: 1, slotsMin: 0, slotsExact: 3, enchants: [] }]);
    const badWant = await form(`/vaults/${owner.nodeId}/requests`, [["seasonal", "0"], ["refs", "n1"], ["server", "USEast"], ["want", "Ring lots"], ["kind", "offer-create"]], cookie);
    expect(badWant.headers.get("location")).toContain("error=");

    const taken = (await owner.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(taken.map((r) => [r.kind, r.state])).toEqual([["deposit", "taken"], ["withdraw", "taken"], ["offer-create", "taken"]]);
    expect(taken[1].refs).toEqual(["s1", "s2"]);
    expect(taken[2]).toMatchObject({ refs: ["n1"], want: [{ itemId: "Ring", qty: 2, slotsMin: 1, slotsExact: null }, { itemId: "Cloak", qty: 1, slotsMin: 0, slotsExact: 3 }] });
    await owner.call("POST", `/api/v1/guest-requests/${taken[0].id}/result`, { ok: false, error: "guest never came" });
    const done = await (await app.request(`/vaults/${owner.nodeId}`, { headers: { cookie } })).text();
    expect(done).toContain("guest never came");
    expect(done).toContain("failed");
    expect(done).toContain("taken");
  });
});
