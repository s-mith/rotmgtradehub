// Signing in with Google (Discord lives in discordAuth.tsx). Signing out.
import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { signInWithGoogle } from "../auth";
import { googleAuthUrl, googleExchange, newStateAndNonce } from "../google";
import { isHttps, publicOrigin, type Site } from "./context";
import { decodeNext, encodeNext, safeNext } from "./next";

/** state.nonce.next for the Google round trip; lives ten minutes. `next` is where to land afterwards (a page on this site), else /me. */
const OAUTH_COOKIE = "hub_oauth";

export function registerAuth(app: Hono, site: Site): void {
  const { google } = site;
  // Sign in with Google: accounts are made here. The round trip is pinned by a state in a short cookie and a nonce in
  // the id_token; the redirect URI must be the one registered with Google (BASE_URL + /auth/google/callback).
  app.get("/auth/google", (c) => {
    if (!google) return site.fail(c, "Google sign-in is not configured on this site");
    const { state, nonce } = newStateAndNonce();
    setCookie(c, OAUTH_COOKIE, `${state}.${nonce}.${encodeNext(safeNext(c.req.query("next")))}`, { httpOnly: true, sameSite: "Lax", path: "/auth/google", maxAge: 600, secure: isHttps(c) });
    return c.redirect(googleAuthUrl(google, { redirectUri: `${publicOrigin(c)}/auth/google/callback`, state, nonce }));
  });
  app.get("/auth/google/callback", async (c) => {
    if (!google) return site.fail(c, "Google sign-in is not configured on this site");
    const [state, nonce, nextEncoded] = (getCookie(c, OAUTH_COOKIE) ?? "").split(".");
    deleteCookie(c, OAUTH_COOKIE, { path: "/auth/google" });
    const code = c.req.query("code");
    if (c.req.query("error")) return site.fail(c, `Google sign-in was cancelled (${c.req.query("error")})`);
    if (!state || !nonce || c.req.query("state") !== state || !code) return site.fail(c, "that sign-in did not start here; try again");
    const r = await googleExchange(google, { code, redirectUri: `${publicOrigin(c)}/auth/google/callback`, nonce });
    if (!r.ok) return site.fail(c, r.error);
    site.signIn(c, signInWithGoogle(site.db, r.claims));
    return c.redirect(decodeNext(nextEncoded) ?? "/me");
  });
  app.post("/logout", (c) => {
    site.signOut(c);
    return c.redirect("/");
  });
}
