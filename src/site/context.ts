// What every website module gets: the database, who is signed in, how to
// sign someone in, and the frame the layout draws around a page.
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SESSION_MS, createSession, deleteSession, isAdmin, renewSession, userFromSession, type User } from "../auth";
import type { Db } from "../db";
import type { DiscordOptions } from "../discord";
import type { GoogleOptions } from "../google";
import type { Frame, NavKey } from "./layout";

export const SESSION_COOKIE = "hub_session";

/** Behind Caddy or nginx the request URL says http; the proxy says what the person actually used. */
export function isHttps(c: Context): boolean {
  return c.req.url.startsWith("https") || (c.req.header("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

/** The origin people see: BASE_URL when set (it must match the redirect URI registered with Google), else the request's own. */
export function publicOrigin(c: Context): string {
  const fromEnv = process.env.BASE_URL?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const u = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return `${isHttps(c) ? "https" : "http"}://${host}`;
}

/** The session cookie outlives the browser: it lasts as long as the session does. */
const sessionCookie = (c: Context) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/", secure: isHttps(c), maxAge: Math.floor(SESSION_MS / 1000) });

export class Site {
  constructor(readonly db: Db, readonly google: GoogleOptions | null, readonly discord: DiscordOptions | null = null) {}

  /** The signed-in person. Coming back renews the session, and the cookie with it: signed in until 30 days without a visit. */
  me(c: Context): User | null {
    const token = getCookie(c, SESSION_COOKIE);
    const user = userFromSession(this.db, token);
    if (user && renewSession(this.db, token)) setCookie(c, SESSION_COOKIE, token!, sessionCookie(c));
    return user;
  }
  signIn(c: Context, user: User): void {
    setCookie(c, SESSION_COOKIE, createSession(this.db, user.id), sessionCookie(c));
  }
  signOut(c: Context): void {
    deleteSession(this.db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }
  frame(user: User | null, active?: NavKey): Frame {
    return { user, admin: isAdmin(user), active };
  }
  /** Back to the front page with a message. */
  fail(c: Context, error: string): Response {
    return c.redirect(`/?error=${encodeURIComponent(error)}`);
  }
}

/** Form fields as strings: the last value when a field repeats, every value with `many`. */
export function fields(f: Record<string, string | File | (string | File)[]>) {
  const one = (k: string): string => {
    const v = f[k];
    return typeof v === "string" ? v.trim() : Array.isArray(v) && typeof v[v.length - 1] === "string" ? String(v[v.length - 1]).trim() : "";
  };
  const many = (k: string): string[] => {
    const v = f[k];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  };
  return { one, many };
}
