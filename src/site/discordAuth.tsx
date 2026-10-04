// Sign in with Discord, beside Google: the same state-cookie round trip,
// one call to Discord for a verified email and a name.
import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { signInWithDiscord } from "../auth";
import { discordAuthUrl, discordExchange, newState } from "../discord";
import { isHttps, publicOrigin, type Site } from "./context";
import { decodeNext, encodeNext, safeNext } from "./next";

/** state.next for the Discord round trip; lives ten minutes. */
const DISCORD_COOKIE = "hub_discord";

export function registerDiscordAuth(app: Hono, site: Site): void {
  const { discord } = site;
  app.get("/auth/discord", (c) => {
    if (!discord) return site.fail(c, "Discord sign-in is not configured on this site");
    const state = newState();
    setCookie(c, DISCORD_COOKIE, `${state}.${encodeNext(safeNext(c.req.query("next")))}`, { httpOnly: true, sameSite: "Lax", path: "/auth/discord", maxAge: 600, secure: isHttps(c) });
    return c.redirect(discordAuthUrl(discord, { redirectUri: `${publicOrigin(c)}/auth/discord/callback`, state }));
  });
  app.get("/auth/discord/callback", async (c) => {
    if (!discord) return site.fail(c, "Discord sign-in is not configured on this site");
    const [state, nextEncoded] = (getCookie(c, DISCORD_COOKIE) ?? "").split(".");
    deleteCookie(c, DISCORD_COOKIE, { path: "/auth/discord" });
    const code = c.req.query("code");
    if (c.req.query("error")) return site.fail(c, `Discord sign-in was cancelled (${c.req.query("error")})`);
    if (!state || c.req.query("state") !== state || !code) return site.fail(c, "that sign-in did not start here; try again");
    const r = await discordExchange(discord, { code, redirectUri: `${publicOrigin(c)}/auth/discord/callback` });
    if (!r.ok) return site.fail(c, r.error);
    site.signIn(c, signInWithDiscord(site.db, r.claims));
    return c.redirect(decodeNext(nextEncoded) ?? "/me");
  });
}
