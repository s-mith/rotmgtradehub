import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { signInWithGoogle } from "../auth";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
});

/** Discord in a closure: the token endpoint takes one good code, /users/@me answers with whoever the test says. */
function fakeDiscord() {
  const who = { id: "123456789012345678", username: "boss_person", global_name: "Boss Person!" as string | null, email: "boss@x.test" as string | null, verified: true as boolean };
  const seen: { url: string; auth: string | null; body: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.authorization ?? null, body: typeof init?.body === "string" ? init.body : null });
    if (url === "https://d.test/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("code") !== "good" || p.get("client_id") !== "dcid" || p.get("client_secret") !== "sec" || p.get("grant_type") !== "authorization_code") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "tok-1", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://d.test/me") {
      if (headers.authorization !== "Bearer tok-1") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(who), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const discord = { clientId: "dcid", clientSecret: "sec", authUrl: "https://d.test/auth", tokenUrl: "https://d.test/token", userUrl: "https://d.test/me", fetchImpl };
  /** The whole round trip as a browser would do it; the session cookie, or the error the hub redirected with. */
  async function signIn(next?: string): Promise<{ cookie: string; to: string } | { error: string }> {
    const start = await app.request(`/auth/discord${next ? `?next=${encodeURIComponent(next)}` : ""}`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://d.test/auth");
    expect(to.searchParams.get("client_id")).toBe("dcid");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost/auth/discord/callback");
    expect(to.searchParams.get("scope")).toBe("identify email");
    expect(to.searchParams.get("response_type")).toBe("code");
    const state = to.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    expect(cookie.startsWith("hub_discord=")).toBe(true);
    const back = await app.request(`/auth/discord/callback?state=${encodeURIComponent(state)}&code=good`, { headers: { cookie }, redirect: "manual" });
    expect(back.status).toBe(302);
    const loc = back.headers.get("location")!;
    if (loc.startsWith("/?error=")) return { error: decodeURIComponent(loc.slice("/?error=".length)) };
    return { cookie: back.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("hub_session="))!, to: loc };
  }
  return { who, discord, signIn, seen };
}
const users = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

describe("Discord sign-in", () => {
  it("signs up with the Discord name, signs the same account in again, and keeps the email", async () => {
    const d = fakeDiscord();
    app = createApp(db, { google: null, discord: d.discord });
    expect(await (await app.request("/")).text()).toContain('href="/auth/discord"');
    const first = await d.signIn();
    expect("cookie" in first).toBe(true);
    const { cookie, to } = first as { cookie: string; to: string };
    expect(to).toBe("/me");
    const me = await (await app.request("/me", { headers: { cookie } })).text();
    // The name Discord has for the person is never used: a neutral one, theirs to change (2026-09-25).
    expect(me).not.toContain("Boss");
    expect(me).toMatch(/Trader\d{4}/);
    expect(me).toContain("boss@x.test");
    expect(db.prepare("SELECT discord_id, google_sub, password_hash FROM users").get()).toEqual({ discord_id: "123456789012345678", google_sub: null, password_hash: null });
    // Same Discord account again, even with a changed email: the same hub account.
    d.who.email = "other@x.test";
    expect("cookie" in (await d.signIn())).toBe(true);
    expect(users()).toBe(1);
    // The token was used once, for /users/@me, and never stored.
    expect(d.seen.filter((s) => s.auth === "Bearer tok-1")).toHaveLength(2);
    // Where the person meant to go survives the round trip.
    expect((await d.signIn("/join/abc") as { to: string }).to).toBe("/join/abc");
    expect((await d.signIn("https://evil.test/") as { to: string }).to).toBe("/me");
  });

  it("refuses an unverified or missing email, a bad code, and a callback that did not start here", async () => {
    const d = fakeDiscord();
    app = createApp(db, { google: null, discord: d.discord });
    d.who.verified = false;
    expect(await d.signIn()).toMatchObject({ error: expect.stringContaining("not verified") });
    d.who.verified = true;
    d.who.email = null;
    expect(await d.signIn()).toMatchObject({ error: expect.stringContaining("email") });
    expect(users()).toBe(0);
    const stray = await app.request("/auth/discord/callback?state=nope&code=good", { redirect: "manual" });
    expect(stray.headers.get("location")).toContain("did%20not%20start%20here");
    const start = await app.request("/auth/discord", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const bad = await app.request(`/auth/discord/callback?state=${encodeURIComponent(state)}&code=wrong`, { headers: { cookie: start.headers.get("set-cookie")!.split(";")[0] }, redirect: "manual" });
    expect(bad.headers.get("location")).toContain("refused");
    expect(users()).toBe(0);
  });

  it("attaches to the Google-made account with the same email, and is off when not configured", async () => {
    const d = fakeDiscord();
    app = createApp(db, { google: null, discord: d.discord });
    const g = signInWithGoogle(db, { sub: "g-1", email: "boss@x.test", name: "Boss" });
    expect(g.displayName).toMatch(/^Trader\d{4}$/);
    const r = await d.signIn();
    expect("cookie" in r).toBe(true);
    expect(users()).toBe(1);
    expect(db.prepare("SELECT id, discord_id, google_sub, display_name FROM users").get()).toEqual({ id: g.id, discord_id: "123456789012345678", google_sub: "g-1", display_name: g.displayName });
    // A second Discord account cannot claim the same id row: the partial unique index holds.
    expect(() => db.prepare("INSERT INTO users (email, display_name, discord_id, created_at) VALUES ('x@x.test', 'X', '123456789012345678', 1)").run()).toThrow(/UNIQUE/);
    // Several accounts without Discord are fine.
    db.prepare("INSERT INTO users (email, display_name, created_at) VALUES ('y@x.test', 'Y', 1), ('z@x.test', 'Z', 1)").run();

    app = createApp(db, { google: null, discord: null });
    expect(await (await app.request("/")).text()).not.toContain('href="/auth/discord"');
    expect((await app.request("/auth/discord", { redirect: "manual" })).headers.get("location")).toContain("not%20configured");
  });
});
