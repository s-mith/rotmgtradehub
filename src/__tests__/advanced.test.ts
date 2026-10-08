// Advanced management on the hub (docs/relay/ADVANCED.md): a node whose
// heartbeat says it runs it for communism takes "N of this item" withdraws
// and takes deposits across its accounts; a full communism passes its surplus
// on to another node's; the communism board stays one pass over what is held
// however big it grows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type GuestRequestWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { createUser, setIgn, type User } from "../auth";
import { linkCodeFor, person } from "./people";
import { availableCopies, createGuestRequest } from "../requests";
import { nodeStatus } from "../nodes";
import { BOARD_SQL, communismBoard, communismNodes } from "../communism";
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
const status = (advanced?: { pool: boolean; communism: boolean }) => ({ gate: { held: false, reason: null, known: true }, proxies: 1, accounts: 2, suspended: 0, deskServer: null, ...(advanced ? { advanced } : {}) });

async function linkedNode(email: string, name: string, advanced?: { pool: boolean; communism: boolean }) {
  const user = createUser(db, email, name);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  const beat = (a?: { pool: boolean; communism: boolean }) => call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [{ ign: `${name}Bot`, seasonal: true, online: true }], status: status(a) });
  await beat(advanced);
  return { nodeId, call, beat, user };
}
const account = (ign: string, seasonal: boolean, slots = 8, free = slots) => ({ ign, seasonal, slots, free, online: true });
const item = (ref: string, itemId: string, botIgn: string, o: { seasonal?: boolean; count?: number } = {}) =>
  ({ ref, itemId, name: `${itemId} name`, enchants: o.count ? Array.from({ length: o.count }, (_, i) => i + 1) : null, count: o.count ?? 0, seasonal: o.seasonal ?? true, botIgn });
const reqOf = (r: ReturnType<typeof createGuestRequest>): GuestRequestWire => {
  expect(r).toMatchObject({ ok: true });
  return (r as { ok: true; request: GuestRequestWire }).request;
};
function guest(email = "guest@x.test", ign = "Gwen"): User {
  const u = createUser(db, email, ign);
  setIgn(db, u.id, ign);
  return u;
}

/** Olive's communism: two seasonal accounts (8 and 4 free), three plain Defense potions, an enchanted one, a non-seasonal one. */
async function olive(advanced = true) {
  const node = await linkedNode("owner@x.test", "Olive", advanced ? { pool: false, communism: true } : undefined);
  const r = await node.call("POST", "/api/v1/communism/publish", {
    at: Date.now(),
    accounts: [account("OliveComm", true, 8, 8), account("OliveTwo", true, 8, 4), account("OliveNon", false, 8, 8)],
    items: [item("p1", "pdef", "OliveComm"), item("p2", "pdef", "OliveComm"), item("p3", "pdef", "OliveTwo"), item("p4", "pdef", "OliveTwo", { count: 1 }), item("p5", "pdef", "OliveNon", { seasonal: false }), item("s1", "Sword", "OliveComm")],
  });
  expect(r.body).toMatchObject({ ok: true, listed: 6 });
  return node;
}
const countOf = (itemId: string, qty: number) => [{ itemId, qty }];

describe("N of this item", () => {
  it("only from a node that takes them; counts plain copies nobody holds, less what open counts ask for", async () => {
    const node = await olive(false);
    const gwen = guest();
    const ask = (input: Parameters<typeof createGuestRequest>[3], who: User = gwen) => createGuestRequest(db, who, node.nodeId, input);
    expect(communismNodes(db)[0].byCount).toBeUndefined();
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 1) })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("item by item") });
    await node.beat({ pool: false, communism: true });
    expect(communismNodes(db)[0]).toMatchObject({ byCount: true });
    // Shapes.
    expect(ask({ kind: "withdraw", server: "USEast", want: countOf("pdef", 1) })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("seasonal") });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("nope", 1) })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 0) })).toMatchObject({ ok: false, status: 400 });
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: [{ itemId: "pdef", qty: 5 }, { itemId: "pdef", qty: 4 }] })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("at most 8") });
    // Three plain seasonal copies: the enchanted and the non-seasonal one never count.
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 4) })).toMatchObject({ ok: false, status: 409, error: "only 3 Potion of Defense left in that node's seasonal pool" });
    const two = reqOf(ask({ kind: "withdraw", seasonal: true, server: "USEast", refs: [], want: countOf("pdef", 2) }));
    expect(two).toMatchObject({ kind: "withdraw", seasonal: true, refs: null, want: [{ itemId: "pdef", qty: 2, slotsMin: 0, slotsExact: 0, enchants: [] }], communism: null });
    // Two of the three are asked for; a pick by ref of a third leaves none.
    const pia = guest("pia@x.test", "Pia");
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 2) }, pia)).toMatchObject({ ok: false, error: "only 1 Potion of Defense left in that node's seasonal pool" });
    reqOf(ask({ kind: "withdraw", server: "USEast", refs: ["p3"] }, pia));
    expect(ask({ kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 1) }, pia)).toMatchObject({ ok: false, error: "no Potion of Defense left in that node's seasonal pool" });
    // The node gets the lines; the person's page says what they asked for.
    const handed = (await node.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(handed.find((r) => r.id === two.id)).toMatchObject({ refs: null, want: [{ itemId: "pdef", qty: 2 }] });
    expect(await (await app.request("/me", { headers: { cookie: person(db, "guest@x.test").cookie } })).text()).toContain("Withdraw 2× Potion of Defense from Olive-desk&#39;s seasonal communism on USEast");
  });

  it("the communism page offers a count of the potions such a node lists, and queues it", async () => {
    const node = await olive();
    guest();
    const cookie = person(db, "guest@x.test").cookie;
    const page = await (await app.request("/communism?half=seasonal", { headers: { cookie } })).text();
    expect(page).toContain("data-by-count");
    expect(page).toContain(`<option value="${node.nodeId}~pdef">Potion of Defense · 3 there</option>`);
    expect(page).not.toContain("~Sword\">");
    // Deposits ask how many items, any number up to 24, as the node's own form does.
    expect(page).toContain('<input id="deposit-count" type="number" name="count" min="1" max="24" value="8"');
    expect(page).not.toContain("size-btn");
    const body = new URLSearchParams([["pick", `${node.nodeId}~pdef`], ["qty", "2"], ["server", "USEast"], ["seasonal", "1"]]);
    const res = await app.request("/communism/take-count", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: body.toString(), redirect: "manual" });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toMatch(/^\/me\?ok=Request #\d+ queued\. The node picks the copies/);
    const handed = (await node.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(handed).toMatchObject([{ kind: "withdraw", ign: "Gwen", server: "USEast", seasonal: true, refs: null, want: [{ itemId: "pdef", qty: 2 }] }]);
  });
});

describe("deposits into a node's communism", () => {
  it("count the room across its accounts, advanced management or not: a deposit carries on with the next character with room", async () => {
    const node = await olive(false);
    const gwen = guest();
    const ask = (count: number) => createGuestRequest(db, gwen, node.nodeId, { kind: "deposit", seasonal: true, server: "USEast", count });
    reqOf(ask(10));
    expect(ask(13)).toMatchObject({ ok: false, status: 409, error: "that node's seasonal pool has room for 12 items right now" });
    await node.beat({ pool: false, communism: true });
    reqOf(ask(10));
    expect(ask(13)).toMatchObject({ ok: false, status: 409, error: "that node's seasonal pool has room for 12 items right now" });
  });
});

describe("passing surplus on", () => {
  async function three() {
    const giver = await olive();
    const bob = await linkedNode("bob@x.test", "Bob");
    const carl = await linkedNode("carl@x.test", "Carl");
    await bob.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("BobComm", true, 8, 1)], items: [] });
    await carl.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("CarlComm", true, 8, 3), account("CarlNon", false, 8, 8)], items: [] });
    return { giver, bob, carl };
  }
  const wire = (ref: string, itemId = "pdef") => ({ ref, itemId, enchants: null, count: 0 });
  const pass = (refs: string[], o: Record<string, unknown> = {}) => ({ nodeId: "", seasonal: true, items: refs.map((r) => wire(r, r === "s1" ? "Sword" : "pdef")), server: "USEast", botIgn: "OliveComm", pass: true, ...o });

  it("goes to the roomiest communism account of that half on another node, as many as it has room for, and takes the items off the board", async () => {
    const { giver, carl } = await three();
    const r = await giver.call("POST", "/api/v1/communism/give", pass(["p1", "p2", "s1", "p3"]));
    expect(r.status).toBe(200);
    expect(r.body.nodeId).toBe(carl.nodeId);
    const rv = r.body.rendezvous as RendezvousWire;
    expect(rv).toMatchObject({ kind: "communism", me: { role: "give", botIgn: "OliveComm" }, partner: { botIgn: "CarlComm" } });
    expect(rv.me.gives.map((g) => g.ref)).toEqual(["p1", "p2", "s1"]);
    // Off the board at once, and nobody can ask for them meanwhile.
    expect(communismBoard(db).map((i) => i.ref).sort()).toEqual(["p3", "p4", "p5"]);
    const gwen = guest();
    expect(createGuestRequest(db, gwen, giver.nodeId, { kind: "withdraw", server: "USEast", refs: ["p1"] })).toMatchObject({ ok: false, status: 409 });
    // Carl's account room counts the items coming: the next pass goes to Bob (1 free) with one item.
    const next = await giver.call("POST", "/api/v1/communism/give", pass(["p3"]));
    expect(next.body.nodeId).not.toBe(carl.nodeId);
    expect((next.body.rendezvous as RendezvousWire).partner.botIgn).toBe("BobComm");
  });

  it("leaves behind items the giver did not list or someone holds, is refused when none is left or no other node has room; a plain give still names its node", async () => {
    const { giver, bob, carl } = await three();
    const gwen = guest();
    reqOf(createGuestRequest(db, gwen, giver.nodeId, { kind: "withdraw", server: "USEast", refs: ["p2"] }));
    expect((await giver.call("POST", "/api/v1/communism/give", pass(["zz"]))).body).toMatchObject({ error: "none of those items is listed and free in your seasonal communism any more" });
    expect((await giver.call("POST", "/api/v1/communism/give", pass(["p2"]))).status).toBe(409);
    const some = await giver.call("POST", "/api/v1/communism/give", pass(["zz", "p2", "p1"]));
    expect((some.body.rendezvous as RendezvousWire).me.gives.map((g) => g.ref)).toEqual(["p1"]);
    // A non-seasonal pass looks for non-seasonal room: only Carl has some.
    expect((await giver.call("POST", "/api/v1/communism/give", pass(["p5"], { seasonal: false }))).body.nodeId).toBe(carl.nodeId);
    for (const n of [bob, carl]) await n.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account(`${n === bob ? "Bob" : "Carl"}Comm`, true, 8, 0)], items: [] });
    expect((await giver.call("POST", "/api/v1/communism/give", pass(["s1"]))).body).toMatchObject({ error: "no other node's seasonal communism has room right now" });
    expect((await giver.call("POST", "/api/v1/communism/give", { ...pass(["s1"]), pass: undefined })).status).toBe(400);
  });

  it("goes to a node running advanced management only into its spare room, never to one passing its own, so it never comes back", async () => {
    const giver = await olive();
    const dora = await linkedNode("dora@x.test", "Dora");
    const erin = await linkedNode("erin@x.test", "Erin");
    const spare = (seasonal: number) => ({ pool: false, communism: true, spare: { seasonal, nonseasonal: 0 } });
    // Erin has free slots but no spare (it is passing its own); Dora has 8 free and spare for 2.
    await erin.call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [], status: status(spare(0)) });
    await dora.call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [], status: status(spare(2)) });
    await erin.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("ErinComm", true, 8, 8)], items: [] });
    await dora.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("DoraComm", true, 8, 8)], items: [] });
    const first = await giver.call("POST", "/api/v1/communism/give", pass(["p1", "p2", "p3"]));
    expect(first.body.nodeId).toBe(dora.nodeId);
    expect((first.body.rendezvous as RendezvousWire).me.gives.map((g) => g.ref)).toEqual(["p1", "p2"]);
    // Dora's spare is spoken for by the pass under way, and Erin's is none: nowhere to go.
    expect((await giver.call("POST", "/api/v1/communism/give", pass(["p3"]))).body).toMatchObject({ error: "no other node's seasonal communism has room right now" });
    // A node that says nothing about spare room while running it for communism has none.
    expect(nodeStatus(db, erin.nodeId)?.advanced).toEqual({ pool: false, communism: true, spare: { seasonal: 0, nonseasonal: 0 } });
  });
});

describe("what the hub holds for a withdraw by count", () => {
  it("goes with it to the node, and once the node has answered, its count no longer comes off what is left", async () => {
    const node = await olive();
    const gwen = guest();
    const pia = guest("pia@x.test", "Pia");
    reqOf(createGuestRequest(db, pia, node.nodeId, { kind: "withdraw", server: "USEast", refs: ["p3"] }));
    const byCount = reqOf(createGuestRequest(db, gwen, node.nodeId, { kind: "withdraw", seasonal: true, server: "USEast", want: countOf("pdef", 1) }));
    expect(availableCopies(db, node.nodeId, true, "pdef")).toBe(1);
    const handed = (await node.call("GET", "/api/v1/guest-requests")).body.requests as GuestRequestWire[];
    expect(handed.find((r) => r.id === byCount.id)?.held).toEqual(["p3"]);
    expect(handed.find((r) => r.id !== byCount.id)?.held).toBeUndefined();
    // Handed out and not answered yet: still counted.
    expect(availableCopies(db, node.nodeId, true, "pdef")).toBe(1);
    // Answered: the node has spoken for its copy and is taking it off its listing.
    expect((await node.call("POST", `/api/v1/guest-requests/${byCount.id}/result`, { ok: true, pending: true, detail: "queued" })).status).toBe(200);
    expect(availableCopies(db, node.nodeId, true, "pdef")).toBe(2);
    await node.call("POST", "/api/v1/communism/publish", { at: Date.now(), accounts: [account("OliveComm", true, 8, 8)], items: [item("p2", "pdef", "OliveComm"), item("p3", "pdef", "OliveTwo")] });
    expect(availableCopies(db, node.nodeId, true, "pdef")).toBe(1);
  });
});

describe("a self-report that does not read", () => {
  it("keeps the node's card but not its advanced management", async () => {
    const node = await olive();
    expect(communismNodes(db)[0]).toMatchObject({ byCount: true });
    await node.call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [], status: { gate: "broken" } });
    expect(communismNodes(db)[0].byCount).toBeUndefined();
    expect(nodeStatus(db, node.nodeId)).toMatchObject({ proxies: 1, accounts: 2 });
    expect(nodeStatus(db, node.nodeId)?.advanced).toBeUndefined();
  });
});

describe("the communism board's queries", () => {
  it("work out what is held once per query, and look items up by index", () => {
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join("\n");
    const board = plan(BOARD_SQL, 0, null, null);
    expect(board).not.toMatch(/CORRELATED/);
    expect(board).toMatch(/LIST SUBQUERY/);
    // An item's meeting, gives landing on an account, a node's own gives, copies of one item: each by its index.
    expect(plan("SELECT 1 FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_node_id = ? AND rv.communism_ref = ?", "n", "r")).toContain("rendezvous_communism_ref");
    expect(plan("SELECT 1 FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL AND rv.taker_node_id = ? AND rv.taker_bot_ign = ?", "n", "b")).toContain("rendezvous_communism_in");
    expect(plan("SELECT 1 FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL AND rv.giver_node_id = ?", "n")).toContain("rendezvous_communism_out");
    expect(plan("SELECT COUNT(*) FROM communism_items ci WHERE ci.node_id = ? AND ci.item_id = ? AND ci.seasonal = ? AND ci.count = 0", "n", "pdef", 1)).toContain("communism_items_item");
  });
});
