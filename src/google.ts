// Sign in with Google (OpenID Connect, authorization-code flow). The hub
// needs an email address it can trust and nothing more: Google says who the
// person is, the hub keeps `sub` and the email. No Google API is called
// beyond the token endpoint, and the id_token is taken straight from that
// endpoint over TLS, so it is checked for issuer, audience, expiry and nonce
// rather than re-verified against Google's signing keys (Google's own
// guidance for the server-side flow).
import { randomBytes } from "node:crypto";

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests. */
  authUrl?: string;
  tokenUrl?: string;
  issuers?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface GoogleClaims {
  sub: string;
  email: string;
  name?: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from the environment, or null when the hub offers no Google sign-in. */
export function googleFromEnv(): GoogleOptions | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function newStateAndNonce(): { state: string; nonce: string } {
  return { state: randomBytes(16).toString("base64url"), nonce: randomBytes(16).toString("base64url") };
}

export function googleAuthUrl(o: GoogleOptions, p: { redirectUri: string; state: string; nonce: string }): string {
  const u = new URL(o.authUrl ?? AUTH_URL);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Trade the callback's code for an id_token and check it belongs to this sign-in. */
export async function googleExchange(o: GoogleOptions, p: { code: string; redirectUri: string; nonce: string }): Promise<{ ok: true; claims: GoogleClaims } | { ok: false; error: string }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(o.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: p.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: p.redirectUri, grant_type: "authorization_code" }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, error: `Google did not answer: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => null)) as { id_token?: unknown; error?: unknown; error_description?: unknown } | null;
  if (!res.ok || !body || typeof body.id_token !== "string") {
    const why = body && (typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : null);
    return { ok: false, error: `Google refused the sign-in${why ? `: ${why}` : ""}` };
  }
  const c = decodeJwtPayload(body.id_token);
  if (!c) return { ok: false, error: "Google sent an id_token the hub could not read" };
  const now = (o.now ?? Date.now)();
  if (!(o.issuers ?? ISSUERS).includes(String(c.iss))) return { ok: false, error: "id_token is not from Google" };
  if (c.aud !== o.clientId) return { ok: false, error: "id_token is for another app" };
  if (typeof c.exp !== "number" || c.exp * 1000 < now) return { ok: false, error: "id_token has expired" };
  if (c.nonce !== p.nonce) return { ok: false, error: "id_token does not match this sign-in" };
  if (typeof c.sub !== "string" || !c.sub) return { ok: false, error: "id_token has no subject" };
  if (typeof c.email !== "string" || !c.email || c.email_verified !== true) return { ok: false, error: "Google has not verified that email address" };
  return { ok: true, claims: { sub: c.sub, email: c.email.trim().toLowerCase(), name: typeof c.name === "string" ? c.name : undefined } };
}
