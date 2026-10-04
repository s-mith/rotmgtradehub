// Sign in with Discord (OAuth2 authorization-code flow). Like Google
// (src/google.ts) the hub wants one thing it can trust, a verified email
// address, plus a name to show. Discord's token endpoint hands back an
// access token; one call to /users/@me with it says who the person is, and
// the token is then forgotten. Nothing else of Discord's is read.
import { randomBytes } from "node:crypto";

export interface DiscordOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests. */
  authUrl?: string;
  tokenUrl?: string;
  userUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DiscordClaims {
  /** Discord's snowflake id for the account. */
  id: string;
  email: string;
  name?: string;
}

const AUTH_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const USER_URL = "https://discord.com/api/users/@me";

/** DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET from the environment, or null when the hub offers no Discord sign-in. */
export function discordFromEnv(): DiscordOptions | null {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function newState(): string {
  return randomBytes(16).toString("base64url");
}

export function discordAuthUrl(o: DiscordOptions, p: { redirectUri: string; state: string }): string {
  const u = new URL(o.authUrl ?? AUTH_URL);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "identify email");
  u.searchParams.set("state", p.state);
  // Skip the consent screen for someone who already authorised this app with these scopes.
  u.searchParams.set("prompt", "none");
  return u.toString();
}

/** Trade the callback's code for an access token, then ask Discord who that is. */
export async function discordExchange(o: DiscordOptions, p: { code: string; redirectUri: string }): Promise<{ ok: true; claims: DiscordClaims } | { ok: false; error: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(o.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, error: `Discord did not answer: ${e instanceof Error ? e.message : String(e)}` };
  }
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: unknown; token_type?: unknown; error?: unknown; error_description?: unknown } | null;
  if (!tokenRes.ok || !token || typeof token.access_token !== "string" || !token.access_token) {
    const why = token && (typeof token.error_description === "string" ? token.error_description : typeof token.error === "string" ? token.error : null);
    return { ok: false, error: `Discord refused the sign-in${why ? `: ${why}` : ""}` };
  }
  let meRes: Response;
  try {
    meRes = await fetchImpl(o.userUrl ?? USER_URL, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return { ok: false, error: `Discord did not say who you are: ${e instanceof Error ? e.message : String(e)}` };
  }
  const me = (await meRes.json().catch(() => null)) as { id?: unknown; username?: unknown; global_name?: unknown; email?: unknown; verified?: unknown } | null;
  if (!meRes.ok || !me || typeof me.id !== "string" || !/^\d{5,32}$/.test(me.id)) return { ok: false, error: "Discord sent an account the hub could not read" };
  if (typeof me.email !== "string" || !me.email.trim()) return { ok: false, error: "Discord did not share an email address; the hub needs one to tell accounts apart" };
  if (me.verified !== true) return { ok: false, error: "Discord has not verified that email address" };
  const name = typeof me.global_name === "string" && me.global_name.trim() ? me.global_name : typeof me.username === "string" ? me.username : undefined;
  return { ok: true, claims: { id: me.id, email: me.email.trim().toLowerCase(), name } };
}
