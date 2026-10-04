import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest } from "rotmgtradenode/shared/hubWire";
import { openDb, setSettings, type Db } from "../db";
import { createApp } from "../app";
import { linkCodeFor, person } from "./people";
import { summarize } from "../telemetry";
import { resetRateLimits } from "../ratelimit";
import { DEFAULT_NODES_PER_ACCOUNT, DEFAULT_PLAYER_STARTS_PER_HOUR, limitsOf } from "../personLimits";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db);
  vi.stubEnv("ADMIN_EMAILS", "boss@x.test");
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function linked() {
  const kp = generateNodeKeypair();
  const r = await json(await post("/api/v1/nodes/link", { code: linkCodeFor(db, "me@x.test", "Me"), publicKey: kp.publicKeyPem, name: "desk", version: "0.1.0" }));
  expect(r.status).toBe(200);
  const nodeId = r.body.nodeId as string;
  const signed = (path: string, body: unknown) => post(path, body, { ...signRequest(kp.privateKeyPem, nodeId, "POST", path, JSON.stringify(body)) });
  return { kp, nodeId, signed };
}

describe("hub API", () => {
  it("serves the version feed with the operator's settings", async () => {
    setSettings(db, { minNodeVersion: "0.2.0", knownBuilds: ["7.0.0.2.0"], gameVersion: "7.0.0.2.0" });
    const r = await json(await app.request("/api/v1/version"));
    expect(r.body).toMatchObject({ minNodeVersion: "0.2.0", build: { gameVersion: "7.0.0.2.0", knownBuilds: ["7.0.0.2.0"] } });
  });

  it("links with a code, then only a correctly signed node may heartbeat, report, or unlink", async () => {
    const { nodeId, signed, kp } = await linked();
    expect((await json(await post("/api/v1/nodes/link", { code: "NOPE2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }))).status).toBe(401);
    const hb = await json(await signed("/api/v1/nodes/heartbeat", { version: "0.1.1", build: "7.0.0.2.0", bots: [{ ign: "BotA", seasonal: true, online: true }, { ign: "bad name!", seasonal: false, online: false }] }));
    expect(hb.body).toMatchObject({ ok: true, minNodeVersion: "0.1.0" });
    const row = db.prepare("SELECT version, build, last_seen_at FROM nodes WHERE id = ?").get(nodeId) as { version: string; build: string; last_seen_at: number };
    expect(row).toMatchObject({ version: "0.1.1", build: "7.0.0.2.0" });
    expect(db.prepare("SELECT ign, online FROM node_bots WHERE node_id = ?").all(nodeId)).toEqual([{ ign: "BotA", online: 1 }]);
    // Unsigned, wrong node, and a signature over a different body are all refused.
    expect((await json(await post("/api/v1/nodes/heartbeat", { version: "0" }))).status).toBe(401);
    const other = generateNodeKeypair();
    const forged = signRequest(other.privateKeyPem, nodeId, "POST", "/api/v1/nodes/heartbeat", "{}");
    expect((await json(await post("/api/v1/nodes/heartbeat", {}, { ...forged }))).status).toBe(401);
    const good = signRequest(kp.privateKeyPem, nodeId, "POST", "/api/v1/nodes/heartbeat", JSON.stringify({ version: "1" }));
    expect((await json(await post("/api/v1/nodes/heartbeat", { version: "2" }, { ...good }))).status).toBe(401);
    // Telemetry lands once per (node, account, time) and is summarised. (One clock reading: two could differ by a millisecond.)
    const at = Date.now() - 1000;
    const reports = [
      { account: "abcdefghijklmnopqrstuvwxyz012345", suspendedAt: at, lastSeenAt: null, lastLane: "owner-trade", heldItems: 3, seasonal: true, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
      { account: "abcdefghijklmnopqrstuvwxyz012345", suspendedAt: at, lastSeenAt: null, lastLane: "owner-trade", heldItems: 3, seasonal: true, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
      { account: "short", suspendedAt: Date.now(), lastLane: "idle", heldItems: 0, seasonal: null, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
    ];
    expect((await json(await signed("/api/v1/telemetry/bans", { reports }))).body).toEqual({ ok: true, accepted: 1 });
    expect(summarize(db)).toMatchObject({ total: 1, last24h: 1, nodesReporting: 1, byLane: [{ lane: "owner-trade", n: 1 }] });
    expect((await json(await signed("/api/v1/nodes/unlink", {}))).body).toEqual({ ok: true });
    expect((await json(await signed("/api/v1/nodes/heartbeat", { version: "0" }))).status).toBe(401);
  });

  it("caps nodes per account at twenty, and the operator can lift that for one person", async () => {
    // (The link rate limit, ten an address per fifteen minutes, is not what this is about.)
    const link = (email: string) => (resetRateLimits(), post("/api/v1/nodes/link", { code: linkCodeFor(db, email, "Me"), publicKey: generateNodeKeypair().publicKeyPem, name: "n", version: "0.1.0" }));
    for (let i = 0; i < DEFAULT_NODES_PER_ACCOUNT; i++) expect((await link("me@x.test")).status).toBe(200);
    const refused = await link("me@x.test");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "that account already has 20 nodes, its limit; unlink one on the website, or ask the hub operator for more" });

    // From the admin page: find the person, give them 22; then no limit at all; blank goes back to the default.
    const boss = person(db, "boss@x.test", "Boss");
    const me = person(db, "me@x.test");
    const page = await (await app.request("/admin?person=me%40x", { headers: { cookie: boss.cookie } })).text();
    expect(page).toContain(`/admin/people/${me.id}/limits`);
    const save = (fields: Record<string, string>, cookie = boss.cookie) => app.request(`/admin/people/${me.id}/limits`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    expect((await save({ maxNodes: "22", playerStartsPerHour: "" }, me.cookie)).status).toBe(403);
    expect((await save({ maxNodes: "lots", playerStartsPerHour: "" })).status).toBe(400);
    expect((await save({ maxNodes: "22", playerStartsPerHour: "", q: "me@x" })).headers.get("location")).toBe("/admin?person=me%40x#people");
    expect(limitsOf(db, me.id)).toEqual({ maxNodes: 22, playerStartsPerHour: DEFAULT_PLAYER_STARTS_PER_HOUR });
    expect((await link("me@x.test")).status).toBe(200);
    expect((await link("me@x.test")).status).toBe(200);
    expect((await link("me@x.test")).status).toBe(409);
    await save({ maxNodes: "0", playerStartsPerHour: "0" });
    expect(limitsOf(db, me.id)).toEqual({ maxNodes: null, playerStartsPerHour: null });
    expect((await link("me@x.test")).status).toBe(200);
    await save({ maxNodes: "", playerStartsPerHour: "" });
    expect(limitsOf(db, me.id)).toEqual({ maxNodes: DEFAULT_NODES_PER_ACCOUNT, playerStartsPerHour: DEFAULT_PLAYER_STARTS_PER_HOUR });
  });
});

describe("hub website", () => {
  const form = (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  const sessionOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

  /** Google in a closure: the token endpoint answers with an id_token for whoever the test says is signing in, carrying the nonce the hub asked for. */
  function fakeGoogle() {
    const who = { sub: "g-1", email: "boss@x.test", name: "Boss Person!", verified: true, aud: "cid" };
    let nonce = "";
    const tokenCalls: URLSearchParams[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== "https://g.test/token") return new Response("no", { status: 404 });
      const params = new URLSearchParams(String(init?.body));
      tokenCalls.push(params);
      if (params.get("code") !== "good-code") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      const payload = { iss: "https://accounts.google.com", aud: who.aud, exp: Math.floor(Date.now() / 1000) + 300, nonce, sub: who.sub, email: who.email, email_verified: who.verified, name: who.name };
      const idToken = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const google = { clientId: "cid", clientSecret: "sec", authUrl: "https://g.test/auth", tokenUrl: "https://g.test/token", fetchImpl };
    /** The whole round trip as a browser would do it; returns the session cookie or the error the hub redirected with. */
    async function signIn(): Promise<{ cookie: string } | { error: string }> {
      const start = await app.request("/auth/google", { redirect: "manual" });
      expect(start.status).toBe(302);
      const to = new URL(start.headers.get("location")!);
      expect(to.origin + to.pathname).toBe("https://g.test/auth");
      expect(to.searchParams.get("client_id")).toBe("cid");
      expect(to.searchParams.get("redirect_uri")).toBe("http://localhost/auth/google/callback");
      nonce = to.searchParams.get("nonce")!;
      const oauthCookie = sessionOf(start);
      const back = await app.request(`/auth/google/callback?state=${encodeURIComponent(to.searchParams.get("state")!)}&code=good-code`, { headers: { cookie: oauthCookie }, redirect: "manual" });
      expect(back.status).toBe(302);
      const loc = back.headers.get("location")!;
      if (loc.startsWith("/?error=")) return { error: decodeURIComponent(loc.slice("/?error=".length)) };
      expect(loc).toBe("/me");
      return { cookie: back.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("hub_session="))! };
    }
    return { who, google, signIn, tokenCalls };
  }

  it("signs up and in with Google, gates admin by email, and hands a node a one-time link code", async () => {
    const g = fakeGoogle();
    app = createApp(db, { google: g.google });
    const first = await g.signIn();
    expect("cookie" in first).toBe(true);
    const cookie = (first as { cookie: string }).cookie;
    const me = await app.request("/me", { headers: { cookie } });
    const meText = await me.text();
    // The name Google has for the person is never used: a neutral one, theirs to change (2026-09-25).
    expect(meText).not.toContain("Boss");
    expect(meText).toMatch(/Trader\d{4}/);
    expect(meText).toContain("boss@x.test");
    expect(meText).toContain("No node linked yet");
    expect((await app.request("/admin", { headers: { cookie } })).status).toBe(200);
    // The same Google account again is the same hub account, not a second one.
    const again = await g.signIn();
    expect("cookie" in again).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
    // Someone else, not an admin.
    g.who.sub = "g-2"; g.who.email = "pleb@x.test"; g.who.name = "";
    const other = await g.signIn();
    expect((await app.request("/admin", { headers: { cookie: (other as { cookie: string }).cookie } })).status).toBe(403);
    // Nor is the email's name: a neutral one again.
    const plebMe = await (await app.request("/me", { headers: { cookie: (other as { cookie: string }).cookie } })).text();
    expect(plebMe).not.toContain('value="pleb"');
    expect(plebMe).toMatch(/name="name" value="Trader\d{4}"/);

    // A link code stands in for the password the account does not have.
    const page = await app.request("/me/link-code", { method: "POST", headers: { cookie } });
    const shown = /id="linkcode">([A-Z0-9]{4})-([A-Z0-9]{4})</.exec(await page.text());
    expect(shown).not.toBeNull();
    const code = `${shown![1]}-${shown![2]}`.toLowerCase();
    const kp = generateNodeKeypair();
    const bad = await json(await post("/api/v1/nodes/link", { code, publicKey: "not a key", name: "desk", version: "0.1.0" }));
    expect(bad.status).toBe(400); // a refused link leaves the code usable
    const r = await json(await post("/api/v1/nodes/link", { code, publicKey: kp.publicKeyPem, name: "desk", version: "0.1.0" }));
    expect(r).toMatchObject({ status: 200, body: { email: "boss@x.test", displayName: expect.stringMatching(/^Trader\d{4}$/) } });
    expect((await json(await post("/api/v1/nodes/link", { code, publicKey: generateNodeKeypair().publicKeyPem, name: "twice", version: "0.1.0" }))).status).toBe(401);
    expect((await json(await post("/api/v1/nodes/link", { code: "ZZZZ-ZZZZ", publicKey: generateNodeKeypair().publicKeyPem, name: "x", version: "0.1.0" }))).status).toBe(401);
    expect(await (await app.request("/me", { headers: { cookie } })).text()).toContain("desk");
    // A code past its quarter hour is dead too.
    const page2 = await app.request("/me/link-code", { method: "POST", headers: { cookie } });
    const code2 = /id="linkcode">([A-Z0-9]{4})-([A-Z0-9]{4})</.exec(await page2.text())!;
    db.prepare("UPDATE link_codes SET expires_at = ?").run(Date.now() - 1);
    expect((await json(await post("/api/v1/nodes/link", { code: code2[1] + code2[2], publicKey: generateNodeKeypair().publicKeyPem, name: "late", version: "0.1.0" }))).status).toBe(401);
  });

  it("refuses a Google callback that did not start here, an unverified email, and a token for another app", async () => {
    const g = fakeGoogle();
    app = createApp(db, { google: g.google });
    const stray = await app.request("/auth/google/callback?state=nope&code=good-code", { redirect: "manual" });
    expect(stray.headers.get("location")).toContain("did%20not%20start%20here");
    g.who.verified = false;
    expect(await g.signIn()).toMatchObject({ error: expect.stringContaining("not verified") });
    g.who.verified = true;
    g.who.aud = "someone-else";
    expect(await g.signIn()).toMatchObject({ error: expect.stringContaining("another app") });
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(0);
  });

  it("attaches a Google sign-in to an existing account with the same email, whose nodes stay put", async () => {
    const boss = person(db, "boss@x.test", "Boss");
    const g = fakeGoogle();
    app = createApp(db, { google: g.google });
    expect("cookie" in (await g.signIn())).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT google_sub FROM users").get()).toEqual({ google_sub: "g-1" });
    expect(await (await app.request("/me", { headers: { cookie: boss.cookie } })).text()).toContain('name="name" value="Boss"');
  });

  it("without Google configured the front page says so, and there is no password route of any kind", async () => {
    const home = await (await app.request("/")).text();
    expect(home).toContain("not configured");
    expect(home).not.toContain('type="password"');
    expect((await app.request("/auth/google", { redirect: "manual" })).headers.get("location")).toContain("not%20configured");
    expect((await form("/register", { name: "Boss", email: "boss@x.test", password: "correct horse battery" })).status).toBe(404);
    expect((await form("/login", { email: "boss@x.test", password: "correct horse battery" })).status).toBe(404);
  });

  it("upgrades a v0 users table (password NOT NULL, no google_sub) in place, keeping its rows and their nodes", async () => {
    const old = openDb(":memory:");
    // Pretend this database was made before Google sign-in: rebuild users the old way underneath the app's schema.
    old.pragma("foreign_keys = OFF");
    old.exec(`DROP TABLE link_codes; DROP TABLE users;
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (3, 'old@x.test', 'Old', 'scrypt$x$y', 1);
      INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES ('n_old', 3, 'desk', 'pem', '0.1.0', 1);`);
    old.pragma("foreign_keys = ON");
    // openDb on the same handle is not possible for :memory:, so run the same migration through a file-backed copy.
    const file = `${process.env.TMPDIR ?? "/tmp"}/hub-migrate-${process.pid}-${Date.now()}.db`;
    await old.backup(file);
    old.close();
    const upgraded = openDb(file);
    const cols = upgraded.pragma("table_info(users)") as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === "password_hash")!.notnull).toBe(0);
    expect(cols.some((c) => c.name === "google_sub")).toBe(true);
    expect(upgraded.prepare("SELECT id, email FROM users").all()).toEqual([{ id: 3, email: "old@x.test" }]);
    expect(upgraded.prepare("SELECT user_id FROM nodes WHERE id = 'n_old'").get()).toEqual({ user_id: 3 });
    upgraded.close();
  });
});

describe("rate limits", () => {
  it("stops a code-guessing burst on link, per address as the trusted proxy saw it", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const kp = generateNodeKeypair();
    let last = 0;
    // The client's own claim comes first in the header; the proxy's addition, last, is what counts.
    for (let i = 0; i < 11; i++) last = (await post("/api/v1/nodes/link", { code: "WRNG2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "x-forwarded-for": `1.1.1.${i}, 9.9.9.9` })).status;
    expect(last).toBe(429);
    // Another address is unaffected.
    expect((await post("/api/v1/nodes/link", { code: "WRNG2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "x-forwarded-for": "8.8.8.8" })).status).toBe(401);
    vi.unstubAllEnvs();
  });
  it("counts by the proxy's own client-address header when one is named", async () => {
    vi.stubEnv("CLIENT_IP_HEADER", "cf-connecting-ip");
    const kp = generateNodeKeypair();
    let last = 0;
    // The proxy overwrites its header, so a made-up X-Forwarded-For changes nothing.
    for (let i = 0; i < 11; i++) last = (await post("/api/v1/nodes/link", { code: "WRNG2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "cf-connecting-ip": "5.5.5.5", "x-forwarded-for": `4.4.4.${i}` })).status;
    expect(last).toBe(429);
    expect((await post("/api/v1/nodes/link", { code: "WRNG2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "cf-connecting-ip": "6.6.6.6" })).status).toBe(401);
    vi.unstubAllEnvs();
  });
  it("ignores a forwarded address nobody vouches for", async () => {
    const kp = generateNodeKeypair();
    let last = 0;
    // Without TRUST_PROXY a visitor cannot dodge the limit by making up a new header each time.
    for (let i = 0; i < 11; i++) last = (await post("/api/v1/nodes/link", { code: "WRNG2345", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "x-forwarded-for": `7.7.7.${i}` })).status;
    expect(last).toBe(429);
  });
});
