// Signing in with a Realm character through the login node (realmLogin.ts),
// and proving the IGN a person trades with.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest, type RealmLoginWire } from "rotmgtradenode/shared/hubWire";
import { getSettings, openDb, type Db } from "../db";
import { createApp } from "../app";
import { charactersOf, createUser, ignStatusOf, setIgn, setVerifiedIgn, tradingIgnOf } from "../auth";
import { nodeById } from "../nodes";
import { REALM_LOGIN_TTL_MS, startRealmLogin, takePendingLogins } from "../realmLogin";
import { linkCodeFor, person } from "./people";
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

async function linkedNode(email: string, name: string) {
  createUser(db, email, name);
  const kp = generateNodeKeypair();
  const link = await json(await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name: `${name}-desk`, version: "0.1.0" }) }));
  const nodeId = link.body.nodeId as string;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...signRequest(kp.privateKeyPem, nodeId, method, path, raw) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return json(await app.request(path, { method, headers, body: body === undefined ? undefined : raw }));
  };
  const beat = () => call("POST", "/api/v1/nodes/heartbeat", { version: "0.1.0", build: "7.0", bots: [], status: { gate: { held: false, reason: null, known: true }, proxies: 1, accounts: 1, suspended: 0, deskServer: null, login: { botIgn: "DeskBot", server: "USWest4" } } });
  expect((await beat()).status).toBe(200);
  return { nodeId, call, beat };
}

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
/** Cookies a response set, as a request header. */
const cookiesOf = (res: Response): string => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

/** The login node set by the operator from the admin page, and a second node that is not it. */
async function loginSetup() {
  const desk = await linkedNode("desk@x.test", "Desk");
  const other = await linkedNode("other@x.test", "Other");
  const boss = person(db, "boss@x.test", "Boss");
  expect((await form("/admin/login-node", [["nodeId", desk.nodeId]], boss.cookie)).status).toBe(302);
  expect(getSettings(db).loginNodeId).toBe(desk.nodeId);
  return { desk, other, boss };
}

/** Walk one code through the desk: taken, the bot to whisper, the whisper. Returns the page text shown once the bot has it. */
async function whisper(desk: Awaited<ReturnType<typeof linkedNode>>, cookie: string, ign: string): Promise<string> {
  const taken = (await desk.call("GET", "/api/v1/realm-logins/pending")).body.logins as RealmLoginWire[];
  expect(taken).toHaveLength(1);
  expect((await json(await app.request("/auth/realm/state", { headers: { cookie } }))).body).toMatchObject({ state: "taken", code: taken[0].code });
  expect((await desk.call("POST", `/api/v1/realm-logins/${taken[0].id}/ready`, { botIgn: "DeskBot", server: "USWest4" })).body).toMatchObject({ state: "ready" });
  const page = await (await app.request("/auth/realm", { headers: { cookie } })).text();
  expect((await desk.call("POST", `/api/v1/realm-logins/${taken[0].id}/verified`, { ign })).body).toMatchObject({ state: "verified" });
  expect((await json(await app.request("/auth/realm/state", { headers: { cookie } }))).body).toMatchObject({ state: "verified" });
  return page;
}

describe("signing in with a Realm character", () => {
  it("the operator names the login node; only it hears so, and only it gets codes", async () => {
    const { desk, other } = await loginSetup();
    expect((await desk.beat()).body).toMatchObject({ loginNode: true });
    expect((await other.beat()).body).toMatchObject({ loginNode: false });
    expect((await other.call("GET", "/api/v1/realm-logins/pending")).status).toBe(403);
    expect((await desk.call("GET", "/api/v1/realm-logins/pending")).body).toEqual({ logins: [] });
    const page = await (await app.request("/")).text();
    expect(page).toContain('href="/auth/realm"');
  });

  it("a whisper signs a stranger in: a new account with no email, proven; the next time lands on the same account", async () => {
    const { desk, other } = await loginSetup();
    const start = await app.request("/auth/realm", { redirect: "manual" });
    expect(start.status).toBe(200);
    const cookie = cookiesOf(start);
    expect(cookie).toContain("hub_realm=");
    expect(await start.text()).toContain("Getting the login bot into the game");
    // Another node cannot claim the code.
    const page = await whisper(desk, cookie, "Somebody");
    expect(page).toContain("/tell DeskBot logging into rotmg trade ");
    const code = ((await json(await app.request("/auth/realm/state", { headers: { cookie } }))).body.code as string);
    expect((await other.call("POST", "/api/v1/realm-logins/1/verified", { ign: "Mallory" })).status).toBe(404);

    const fin = await app.request("/auth/realm/finish", { headers: { cookie }, redirect: "manual" });
    expect(fin.status).toBe(302);
    expect(fin.headers.get("location")).toBe("/me");
    const session = cookiesOf(fin);
    expect(session).toContain("hub_session=");
    const u = db.prepare("SELECT id, email, display_name, ign FROM users WHERE ign = 'Somebody'").get() as { id: number; email: string | null; display_name: string; ign: string };
    // The character is not the display name: a neutral one, so offers do not name it to everyone.
    expect(u).toMatchObject({ email: null, ign: "Somebody" });
    expect(u.display_name).toMatch(/^Trader\d{4}$/);
    expect(charactersOf(db, u.id)).toEqual([{ ign: "Somebody", provenAt: expect.any(Number), main: true }]);
    expect(await (await app.request("/me", { headers: { cookie: session } })).text()).toContain("proven");
    // The code works once.
    expect((await app.request("/auth/realm/finish", { headers: { cookie }, redirect: "manual" })).headers.get("location")).toContain("error=");
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    // Signing in again with the same character, from another browser: the same account.
    const again = await app.request("/auth/realm", { redirect: "manual" });
    const cookie2 = cookiesOf(again);
    await whisper(desk, cookie2, "somebody");
    await app.request("/auth/realm/finish", { headers: { cookie: cookie2 }, redirect: "manual" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(ign) = 'somebody'").get() as { n: number }).n).toBe(1);
  });

  it("proving while signed in makes the character the account's IGN and takes it off any other account; typed names stop counting", async () => {
    const pat = person(db, "pat@x.test", "Pat");
    const bob = person(db, "bob@x.test", "Bob");
    setIgn(db, pat.id, "PatChar");
    // No login node yet: a typed name is the IGN people trade with.
    expect(tradingIgnOf(db, pat.id)).toBe("PatChar");
    const { desk } = await loginSetup();
    expect(tradingIgnOf(db, pat.id)).toBeNull();
    expect(await landed(await form("/me", [["do", "ign"], ["ign", "Whatever"]], pat.cookie), pat.cookie)).toContain("use the prove button");
    setVerifiedIgn(db, bob.id, "PatChar");
    expect(tradingIgnOf(db, bob.id)).toBe("PatChar");

    const start = await app.request("/auth/realm", { headers: { cookie: pat.cookie }, redirect: "manual" });
    expect(await start.text()).toContain("Prove the character you play");
    const cookie = `${pat.cookie}; ${cookiesOf(start)}`;
    await whisper(desk, cookie, "PatChar");
    const fin = await app.request("/auth/realm/finish", { headers: { cookie }, redirect: "manual" });
    expect(fin.headers.get("location")).toMatch(/^\/me\?settings_ok=.*#settings$/);
    expect(ignStatusOf(db, pat.id)).toMatchObject({ ign: "PatChar" });
    expect(ignStatusOf(db, pat.id).verifiedAt).not.toBeNull();
    expect(tradingIgnOf(db, pat.id)).toBe("PatChar");
    // Bob had it proven: whoever whispered last has it now.
    expect(tradingIgnOf(db, bob.id)).toBeNull();
    expect(await (await app.request("/me", { headers: { cookie: pat.cookie } })).text()).toContain("proven");
    // The old settings address sends people to the section.
    expect((await app.request("/me/settings", { headers: { cookie: pat.cookie }, redirect: "manual" })).headers.get("location")).toBe("/me#settings");
  });

  it("a code the desk could not take fails and is not handed out again, nor minted anew by itself; an expired code is never handed out", async () => {
    const { desk } = await loginSetup();
    const start = await app.request("/auth/realm", { redirect: "manual" });
    const cookie = cookiesOf(start);
    const taken = (await desk.call("GET", "/api/v1/realm-logins/pending")).body.logins as RealmLoginWire[];
    expect((await desk.call("POST", `/api/v1/realm-logins/${taken[0].id}/ready`, { error: "no login bot is in the game right now" })).body).toMatchObject({ state: "failed" });
    const page = await (await app.request("/auth/realm", { headers: { cookie } })).text();
    expect(page).toContain("could not be used: no login bot is in the game right now");
    expect((db.prepare("SELECT COUNT(*) AS n FROM realm_logins").get() as { n: number }).n).toBe(1);
    expect((await desk.call("GET", "/api/v1/realm-logins/pending")).body).toEqual({ logins: [] });

    const node = nodeById(db, desk.nodeId)!;
    const t0 = Date.now();
    const r = startRealmLogin(db, { userId: null }, t0);
    expect(r.ok).toBe(true);
    expect(takePendingLogins(db, node, t0 + REALM_LOGIN_TTL_MS + 1)).toEqual([]);
    expect((db.prepare("SELECT state FROM realm_logins WHERE id = ?").get((r as { id: number }).id) as { state: string }).state).toBe("expired");
  });

  it("without a login node, or with it offline, there is no Realm sign-in", async () => {
    expect(await (await app.request("/auth/realm")).text()).toContain("not set up on this site");
    const { desk } = await loginSetup();
    db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(Date.now() - 60 * 60_000, desk.nodeId);
    expect(await (await app.request("/auth/realm?new=1")).text()).toContain("offline right now");
    expect(await (await app.request("/")).text()).not.toContain('href="/auth/realm"');
  });
});
