// Signing in with a Realm character, and proving the IGN you trade with
// (src/realmLogin.ts). The page hands out a code and names the login node's
// desk bot once it has the code; the person whispers it in game; hub.js polls
// the state and finishes the sign-in when the whisper has landed. Signed in,
// the same page proves a character for the account instead.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { finishRealmLogin, realmLoginByToken, startRealmLogin, type RealmLoginRow } from "../realmLogin";
import { clientIp, hit } from "../ratelimit";
import { Flash, Layout, When } from "./layout";
import { isHttps, type Site } from "./context";
import { safeNext } from "./next";
import { settingsDone } from "./settings";

const REALM_COOKIE = "hub_realm";

/** What to whisper: a phrase that says what it is for, then the code (the desk picks the code out). */
export const tellLine = (bot: string, code: string): string => `/tell ${bot} logging into rotmg trade ${code}`;

const RealmLogin: FC<{ row: RealmLoginRow | null; proving: boolean; error?: string }> = ({ row, proving, error }) => (
  <>
    <h1>{proving ? "Prove the character you play" : "Sign in with your Realm character"}</h1>
    <p class="muted" style="max-width:640px">
      {proving
        ? "Whisper a code to the login bot from the character you trade with. Only you can /tell as your own character, so that proves it; your Realm password never comes near this site."
        : "No email, no password: whisper a code to the login bot from your character, and you are in as that character. If you already proved it on an account here, that is the account you get."}
    </p>
    <Flash error={error} />
    {row && (row.state === "pending" || row.state === "taken" || row.state === "ready") ? (
      <div class="panel" data-realm-login="/auth/realm/state">
        <ol class="steps">
          <li><b>Log in to your character in the game</b><span class="muted">Any server. The one you want to trade with.</span></li>
          <li>
            <b>Whisper this to the login bot</b>
            {row.state === "ready" && row.bot_ign ? (
              <>
                <span class="row" style="margin:6px 0"><span class="code" style="font-size:18px;letter-spacing:1px">{tellLine(row.bot_ign, row.code)}</span><button type="button" class="quiet small" data-copy={tellLine(row.bot_ign, row.code)}>copy</button></span>
                <span class="muted">Paste it into the game's chat as it is.</span>
              </>
            ) : (
              <span class="muted" data-realm-wait>Getting the login bot into the game to take your code <span class="code" style="font-size:18px">{row.code}</span>… it may have to log in first, which can take a minute. This page fills in the rest.</span>
            )}
          </li>
          <li><b>This page moves on by itself</b><span class="muted">The code works until <When at={row.expires_at} />, once.</span></li>
        </ol>
        <p class="bad small" style="margin-bottom:0">Never whisper a code somebody else gave you: whoever made that code would be signed in as your character.</p>
      </div>
    ) : (
      <div class="panel">
        <p style="margin-top:0">{row?.state === "failed" ? `That code could not be used: ${row.error ?? "the login bot could not take it"}.` : row?.state === "expired" ? "That code ran out before a whisper arrived." : row?.state === "used" ? "That code was used." : "No code yet."}</p>
        <a class="button" href="/auth/realm?new=1">Get a new code</a>
      </div>
    )}
  </>
);

export function registerRealmAuth(app: Hono, site: Site): void {
  const { db } = site;
  app.get("/auth/realm", (c) => {
    const user = site.me(c);
    const next = safeNext(c.req.query("next"));
    // The code this browser already holds, for the same purpose, whatever became of it (a failed one says why and offers a
    // new one; making a new one by itself would loop). A new code only when there is none, or when asked.
    let row = c.req.query("new") === "1" ? null : realmLoginByToken(db, getCookie(c, REALM_COOKIE));
    if (row && (row.user_id ?? null) !== (user?.id ?? null)) row = null;
    let error: string | undefined = c.req.query("error") || undefined;
    if (!row) {
      // A new code costs the login node a little: a handful per address, then wait. Looking at a code you hold costs nothing.
      const allowed = hit("realm", clientIp(c), 20, 15 * 60_000);
      const r = allowed.ok ? startRealmLogin(db, { userId: user?.id ?? null, next }) : { ok: false as const, error: `too many new codes from this address; try again in ${Math.ceil(allowed.retryAfterS / 60)} min` };
      if (!r.ok) error = r.error;
      else {
        // The cookie outlives the code, so a tab left open finds it ran out and offers a new one rather than making one by itself.
        setCookie(c, REALM_COOKIE, r.token, { httpOnly: true, sameSite: "Lax", path: "/auth/realm", maxAge: 24 * 3600, secure: isHttps(c) });
        row = realmLoginByToken(db, r.token);
      }
    }
    return c.html(
      <Layout title={user ? "prove your character" : "sign in with Realm"} frame={site.frame(user, user ? "me" : "home")}>
        <RealmLogin row={row} proving={!!user} error={error} />
      </Layout>,
    );
  });
  // hub.js polls this while the page waits for the bot and for the whisper.
  app.get("/auth/realm/state", (c) => {
    const row = realmLoginByToken(db, getCookie(c, REALM_COOKIE));
    if (!row) return c.json({ state: "none" }, 200, { "cache-control": "no-store" });
    return c.json({ state: row.state, code: row.code, botIgn: row.bot_ign, server: row.server, error: row.error, expiresAt: row.expires_at, tell: row.bot_ign ? tellLine(row.bot_ign, row.code) : null }, 200, { "cache-control": "no-store" });
  });
  app.get("/auth/realm/finish", (c) => {
    const r = finishRealmLogin(db, getCookie(c, REALM_COOKIE));
    if (!r.ok) return c.redirect(`/auth/realm?error=${encodeURIComponent(r.error)}`);
    deleteCookie(c, REALM_COOKIE, { path: "/auth/realm" });
    if (r.mode === "signed-in") {
      site.signIn(c, r.user);
      return c.redirect(r.next ?? "/me");
    }
    return c.redirect(r.next ?? settingsDone({ ok: `Proven: ${r.ign} is one of your characters now.` }));
  });
}
