// Player meetings (players.ts): a person with their own character takes a
// node's offer; the node's receipt alone closes it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type OfferWire, type ReceiptWire, type RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { openDb, setSettings, type Db } from "../db";
import { createApp } from "../app";
import { createUser, setIgn, setVerifiedIgn, type User } from "../auth";
import { listEventsFor } from "../events";
import { linkCodeFor, person } from "./people";
import { RENDEZVOUS_MS, operatorView, sweepRendezvous } from "../offers";
import { NO_SHOW_LIMIT, startPlayerMeeting } from "../players";
import { DEFAULT_PLAYER_STARTS_PER_HOUR, setPersonLimits } from "../personLimits";
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
const PLAYERS = { enabled: true, maxMeetings: 2, servers: ["USEast", "USWest4"] };
const status = (players: unknown = PLAYERS) => ({ gate: { held: false, reason: null, known: true }, proxies: 1, accounts: 1, suspended: 0, deskServer: "USEast", players });

/** An account with a linked node that has heartbeat (online, taking trades with players unless told otherwise), and a signer. */
async function linkedNode(email: string, name: string, players: unknown = PLAYERS) {
  const user = createUser(db, email, name);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  expect(link.status).toBe(200);
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  const beat = (p: unknown = players) => call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [{ ign: "GiverBot", seasonal: false, online: true }], status: status(p) });
  expect((await beat()).status).toBe(200);
  return { nodeId, call, beat, user };
}

const item = (ref: string, itemId: string, count = 0) => ({ ref, itemId, enchants: count ? [7] : [], count });
const want = (itemId: string, qty = 1) => ({ itemId, qty, slotsMin: 0, slotsExact: null, enchants: [] });
// Two Potions of Attack for two Potions of Defense.
const OFFER = { botIgn: "GiverBot", seasonal: false, server: "USEast", give: [item("g1", "patk"), item("g2", "patk", 1)], want: [want("pdef", 2)] };

const form = (path: string, fields: [string, string][], cookie?: string) => {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: body.toString(), redirect: "manual" });
};

/** Alice's node with one open offer, and Pat, who plays a character called PatChar and runs no node. */
async function setup(players: unknown = PLAYERS) {
  const alice = await linkedNode("alice@x.test", "Alice", players);
  const created = await alice.call("POST", "/api/v1/offers", OFFER);
  expect(created.status).toBe(200);
  const offerId = (created.body.offer as OfferWire).id;
  const pat = person(db, "pat@x.test", "Pat");
  setIgn(db, pat.id, "PatChar");
  return { alice, offerId, pat };
}
// Trade in game has no page of its own on the hub any more (the offer board is gone); the meetings still run.
type Played = ReturnType<typeof startPlayerMeeting>;
const play = (offerId: number, who: User, server = "USEast"): Played => startPlayerMeeting(db, who, offerId, { server });
const meetingIdOf = (r: Played): number => {
  expect(r).toMatchObject({ ok: true });
  return (r as { id: number }).id;
};
const errorOf = (r: Played): string => (r.ok ? "" : r.error);
const redirectError = (res: Response): string => decodeURIComponent(new URL(res.headers.get("location") ?? "", "http://x").searchParams.get("error") ?? "");
const receipt = (ok: boolean, extra: Partial<ReceiptWire> = {}): ReceiptWire => ({ window: 0, ok, gave: ok ? [{ itemId: "patk", qty: 2 }] : [], gaveRefs: ok ? ["g1", "g2"] : [], got: ok ? [{ itemId: "pdef", qty: 2 }] : [], partnerIgn: "PatChar", at: Date.now(), ...extra });
const row = (id: number) => db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(id) as Record<string, unknown>;
const offerStatus = (id: number) => (db.prepare("SELECT status FROM offers WHERE id = ?").get(id) as { status: string }).status;

describe("trades in game", () => {
  it("an item in two offers: while a player meeting has it the other offer is held, and the trade withdraws it", async () => {
    const alice = await linkedNode("alice@x.test", "Alice");
    db.prepare("UPDATE nodes SET completed_swaps = 3 WHERE id = ?").run(alice.nodeId);
    // The node names the item by its instance id in both offers.
    const potion = item(`${"0".repeat(31)}1`, "patk");
    const first = ((await alice.call("POST", "/api/v1/offers", { ...OFFER, give: [potion], want: [want("pdef")] })).body.offer as OfferWire).id;
    const second = ((await alice.call("POST", "/api/v1/offers", { ...OFFER, give: [potion], want: [want("pdef", 2)] })).body.offer as OfferWire).id;
    const pat = person(db, "pat@x.test", "Pat");
    setIgn(db, pat.id, "PatChar");
    const kim = person(db, "kim@x.test", "Kim");
    setIgn(db, kim.id, "KimChar");
    const id = meetingIdOf(await play(first, pat));
    expect(errorOf(await play(second, kim))).toBe("one of that offer's items is in another trade right now; try again once that is over");
    await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(true, { gave: [{ itemId: "patk", qty: 1 }], gaveRefs: [potion.ref], got: [{ itemId: "pdef", qty: 1 }] }));
    expect(offerStatus(first)).toBe("done");
    expect(offerStatus(second)).toBe("cancelled");
    expect(listEventsFor(db, alice.user.id).find((e) => e.kind === "offer-withdrawn")?.text).toBe(`Offer #${second} withdrawn: Potion of Attack was traded away in meeting #${id}.`);
  });

  it("a player takes an offer: the node sees a player meeting with the want lines, reports progress, and its receipt alone closes it", async () => {
    const { alice, offerId, pat } = await setup();
    const id = meetingIdOf(await play(offerId, pat, "USWest4"));
    expect(offerStatus(offerId)).toBe("accepted");
    expect(row(id)).toMatchObject({ kind: "player", taker_node_id: null, taker_user_id: pat.id, taker_bot_ign: "PatChar", server: "USWest4", state: "meet" });

    // The node's view: it gives, and whatever comes back must cover the offer's want lines.
    const mine = (await alice.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id, kind: "player", offerId, server: "USWest4", me: { role: "give", botIgn: "GiverBot", gives: OFFER.give, gets: [{ itemId: "pdef", qty: 2 }], getsLines: OFFER.want }, partner: { botIgn: "PatChar", poster: "Pat", player: true } });

    // Progress: the page follows it, and the bot reaching the nexus is a notification.
    expect((await alice.call("POST", `/api/v1/rendezvous/${id}/progress`, { stage: "queued", detail: "GiverBot is logging in to USWest4", botIgn: "GiverBot", server: "USWest4", at: 1 })).status).toBe(200);
    expect((await alice.call("POST", `/api/v1/rendezvous/${id}/progress`, { stage: "ready", detail: "GiverBot is in the USWest4 nexus: /trade GiverBot", botIgn: "GiverBot", server: "USWest4", at: 2 })).status).toBe(200);
    expect(listEventsFor(db, pat.id).some((e) => e.kind === "meeting-ready")).toBe(true);
    expect((db.prepare("SELECT notify FROM events WHERE user_id = ? AND kind = 'meeting-ready'").get(pat.id) as { notify: number }).notify).toBe(1);
    const page = await (await app.request(`/meetings/${id}`, { headers: { cookie: pat.cookie } })).text();
    expect(page).toContain("/trade GiverBot");
    expect(page).toContain("GiverBot is in the USWest4 nexus");
    expect(page).toContain("2× Potion of Defense");
    expect((await json(await app.request(`/meetings/${id}/state.json`, { headers: { cookie: pat.cookie } }))).body).toMatchObject({ state: "meet" });
    // A stranger sees nothing of it.
    const eve = person(db, "eve@x.test", "Eve");
    expect((await app.request(`/meetings/${id}`, { headers: { cookie: eve.cookie } })).status).toBe(404);

    // The node's receipt alone closes it.
    const done = await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(true, { gotItems: [{ itemId: "pdef", enchants: [], count: 0 }, { itemId: "pdef", enchants: [3], count: 1 }] }));
    expect(done.body).toMatchObject({ ok: true, state: "done" });
    expect(offerStatus(offerId)).toBe("done");
    expect(db.prepare("SELECT completed_swaps, completed_player_trades FROM nodes WHERE id = ?").get(alice.nodeId)).toEqual({ completed_swaps: 0, completed_player_trades: 1 });
    expect(db.prepare("SELECT ign, node_id FROM ign_sightings WHERE user_id = ?").all(pat.id)).toEqual([{ ign: "PatChar", node_id: alice.nodeId }]);
    expect(JSON.parse(row(id).taker_gives_json as string)).toEqual([{ ref: "p1", itemId: "pdef", enchants: [], count: 0 }, { ref: "p2", itemId: "pdef", enchants: [3], count: 1 }]);
    // Progress for a finished meeting is refused; the person can say thanks.
    expect((await alice.call("POST", `/api/v1/rendezvous/${id}/progress`, { stage: "ready", detail: "x", at: 3 })).status).toBe(409);
    expect((await form(`/meetings/${id}/confirm`, [], pat.cookie)).status).toBe(302);
    expect(row(id).player_confirmed_at).not.toBeNull();
  });

  it("refuses without an IGN, on your own node, on a node without trades with players, off its servers, and a second one at a time", async () => {
    const { alice, offerId, pat } = await setup();
    const nobody = person(db, "nobody@x.test", "Nobody");
    expect(errorOf(await play(offerId, nobody))).toContain("IGN");
    const own = person(db, "alice@x.test");
    setIgn(db, own.id, "AliceChar");
    expect(errorOf(await play(offerId, own))).toContain("your own node");
    expect(errorOf(await play(offerId, pat, "EUWest"))).toContain("meets on USEast, USWest4");
    await alice.beat({ enabled: false, maxMeetings: 2, servers: [] });
    expect(errorOf(await play(offerId, pat))).toContain("does not take trades with players");
    await alice.beat();
    const first = meetingIdOf(await play(offerId, pat));
    // Taken: the offer is off the board, so a second meeting on it is refused; another offer, while the first runs, too.
    expect(errorOf(await play(offerId, pat))).toContain("no longer open");
    const other = (await alice.call("POST", "/api/v1/offers", { ...OFFER, give: [item("g3", "patk")] })).body.offer as OfferWire;
    expect(errorOf(await play(other.id, pat))).toContain("already have a trade in game under way");
    expect(row(first).state).toBe("meet");
    // A login node on this hub: a typed IGN no longer counts, a proven one does.
    setSettings(db, { loginNodeId: alice.nodeId });
    const typed = person(db, "typed@x.test", "Typed");
    setIgn(db, typed.id, "TypedChar");
    await alice.call("POST", `/api/v1/rendezvous/${first}/abort`, { reason: "test" });
    expect(errorOf(await play(offerId, typed))).toContain("IGN");
    setVerifiedIgn(db, typed.id, "TypedChar");
    expect(meetingIdOf(await play(offerId, typed))).toBeGreaterThan(first);
  });

  it("a player who never came counts a no-show and is paused after two in a day; calling it off does not count", async () => {
    const { alice, offerId, pat } = await setup();
    for (let n = 1; n <= NO_SHOW_LIMIT; n++) {
      const id = meetingIdOf(await play(offerId, pat));
      const r = await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(false, { error: "the player never came before the meeting deadline", partnerAbsent: true }));
      expect(r.body).toMatchObject({ state: "failed" });
      expect(row(id).no_show).toBe(1);
      expect(offerStatus(offerId)).toBe("open");
    }
    expect(errorOf(await play(offerId, pat))).toContain("did not come to 2 trades");
    // Somebody else calls theirs off: the offer reopens, nothing counts against them.
    const sam = person(db, "sam@x.test", "Sam");
    setIgn(db, sam.id, "SamChar");
    const id = meetingIdOf(await play(offerId, sam));
    expect((await form(`/meetings/${id}/cancel`, [], sam.cookie)).headers.get("location")).toContain("ok=");
    expect(row(id)).toMatchObject({ state: "aborted", no_show: 0, reason: "called off by the player" });
    expect(offerStatus(offerId)).toBe("open");
    // The node hears the meeting is over on its next poll (its bot lets go).
    const mine = (await alice.call("GET", "/api/v1/rendezvous/mine")).body.rendezvous as RendezvousWire[];
    expect(mine.find((m) => m.id === id)?.state).toBe("aborted");
  });

  it("each node sets its own no-show rule, and the operator can lift the hourly limit for one person", async () => {
    const { alice, offerId, pat } = await setup();
    const noShow = async () => {
      const id = meetingIdOf(await play(offerId, pat));
      await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(false, { error: "never came", partnerAbsent: true }));
    };
    // This node pauses nobody: two no-shows, and Pat may still come.
    await alice.beat({ ...PLAYERS, noShow: { limit: 0, pauseHours: 24 } });
    await noShow();
    await noShow();
    const third = await play(offerId, pat);
    expect(third).toMatchObject({ ok: true });
    await alice.call("POST", `/api/v1/rendezvous/${(third as { id: number }).id}/abort`, { reason: "x" });
    // A strict node: one no-show within a day pauses for two hours.
    await alice.beat({ ...PLAYERS, noShow: { limit: 1, pauseHours: 2 } });
    expect(errorOf(await play(offerId, pat))).toMatch(/did not come to 2 trades in the last day; this node takes trades in game from you again/);

    // The hourly limit: six starts an hour, unless the operator gave this person more (0: no limit).
    const kim = person(db, "kim@x.test", "Kim");
    setIgn(db, kim.id, "KimChar");
    const startAndCancel = async () => { const id = meetingIdOf(await play(offerId, kim)); await form(`/meetings/${id}/cancel`, [], kim.cookie); };
    for (let i = 0; i < DEFAULT_PLAYER_STARTS_PER_HOUR; i++) await startAndCancel();
    expect(errorOf(await play(offerId, kim))).toBe(`at most ${DEFAULT_PLAYER_STARTS_PER_HOUR} trades in game an hour; try again later`);
    setPersonLimits(db, kim.id, { maxNodes: null, playerStartsPerHour: 0 });
    await startAndCancel();
  });

  it("the deadline fails a meeting the node never answered, without a no-show; a late success still completes it", async () => {
    const { alice, offerId, pat } = await setup();
    const id = meetingIdOf(await play(offerId, pat));
    sweepRendezvous(db, Date.now() + RENDEZVOUS_MS + 1);
    expect(row(id)).toMatchObject({ state: "failed", no_show: 0, reason: "deadline passed with no word from the node" });
    expect(offerStatus(offerId)).toBe("open");
    // The node's receipt arrives after all: the items moved, so it is done.
    expect((await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(true))).body).toMatchObject({ state: "done" });
    expect(offerStatus(offerId)).toBe("done");
    expect(String(row(id).reason)).toContain("completed late");
  });

  it("only the meeting's node reports progress; a player's report reaches the node's owner and the operator, and freezes nobody", async () => {
    const { alice, offerId, pat } = await setup();
    const bob = await linkedNode("bob@x.test", "Bob");
    const id = meetingIdOf(await play(offerId, pat));
    expect((await bob.call("POST", `/api/v1/rendezvous/${id}/progress`, { stage: "ready", detail: "x", at: 1 })).status).toBe(404);
    expect((await alice.call("POST", `/api/v1/rendezvous/${id}/progress`, { stage: "sideways", detail: "x", at: 1 })).status).toBe(400);
    expect(redirectError(await form(`/meetings/${id}/report`, [["text", "nothing arrived"]], pat.cookie))).toContain("still under way");
    await alice.call("POST", `/api/v1/rendezvous/${id}/receipt`, receipt(true));
    expect((await form(`/meetings/${id}/report`, [["text", "one ring was the wrong one"]], pat.cookie)).status).toBe(302);
    expect(operatorView(db).reports.map((r) => [r.id, r.player_report, r.taker_name])).toEqual([[id, "one ring was the wrong one", "Pat"]]);
    expect(listEventsFor(db, alice.user.id).some((e) => e.kind === "meeting-report")).toBe(true);
    expect(db.prepare("SELECT frozen FROM nodes WHERE id = ?").get(alice.nodeId)).toEqual({ frozen: 0 });
    // The owner sees the trade too, and the operator.
    const owner = person(db, "alice@x.test");
    expect(await (await app.request(`/meetings/${id}`, { headers: { cookie: owner.cookie } })).text()).toContain("one ring was the wrong one");
    const boss = person(db, "boss@x.test", "Boss");
    expect((await app.request(`/meetings/${id}`, { headers: { cookie: boss.cookie } })).status).toBe(200);
    expect(await (await app.request("/admin", { headers: { cookie: boss.cookie } })).text()).toContain("one ring was the wrong one");
  });
});
