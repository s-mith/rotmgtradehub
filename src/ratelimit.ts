// Per-address sliding-window limits for the secret-bearing routes (linking a
// node, the sign-in callbacks, new Realm sign-in codes). In memory: the hub
// is one process, and a restart forgiving a burst is fine.
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>();

/**
 * Who a request comes from. With TRUST_PROXY=<n>, the number of proxies in
 * front of the hub that add to X-Forwarded-For (usually 1), the address the
 * nearest of them saw; otherwise the connection's own address, so a visitor
 * cannot pick their own bucket by sending the header themselves.
 */
export function clientIp(c: Context): string {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  if (Number.isInteger(hops) && hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length >= hops) return chain[chain.length - hops];
    const real = c.req.header("x-real-ip")?.trim();
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? "local";
  } catch {
    // No socket behind the request (tests call the app directly).
    return "local";
  }
}

/** One attempt at `name` for `key`: refused, with how long to wait, once `limit` attempts fell within `windowMs`. */
export function hit(name: string, key: string, limit: number, windowMs: number, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
  const id = `${name}:${key}`;
  const b = buckets.get(id) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) return { ok: false, retryAfterS: Math.ceil((b.hits[0] + windowMs - now) / 1000) };
  b.hits.push(now);
  buckets.set(id, b);
  if (buckets.size > 50_000) for (const [k, v] of buckets) if (!v.hits.some((t) => now - t < windowMs)) buckets.delete(k);
  return { ok: true };
}

/** Allow `limit` requests per `windowMs` per address; the reply is 429 past that. */
export function rateLimit(name: string, limit: number, windowMs: number, keyOf: (c: Context) => string = clientIp): MiddlewareHandler {
  return async (c, next) => {
    const r = hit(name, keyOf(c), limit, windowMs);
    if (!r.ok) {
      c.header("retry-after", String(r.retryAfterS));
      return c.json({ error: "too many attempts; try again later" }, 429);
    }
    await next();
  };
}

/** Tests: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}
