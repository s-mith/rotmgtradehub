// Per-IP sliding-window limits for the password-bearing routes (register,
// login, link). In memory: the hub is one process, and a restart forgiving
// a burst is fine.
import type { MiddlewareHandler } from "hono";

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>();

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

/** Allow `limit` hits per `windowMs` per key; the reply is 429 past that. */
export function rateLimit(name: string, limit: number, windowMs: number, keyOf: (req: Request) => string = clientIp): MiddlewareHandler {
  return async (c, next) => {
    const key = `${name}:${keyOf(c.req.raw)}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { hits: [] };
    b.hits = b.hits.filter((t) => now - t < windowMs);
    if (b.hits.length >= limit) {
      c.header("retry-after", String(Math.ceil((b.hits[0] + windowMs - now) / 1000)));
      return c.json({ error: "too many attempts; try again later" }, 429);
    }
    b.hits.push(now);
    buckets.set(key, b);
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (!v.hits.some((t) => now - t < windowMs)) buckets.delete(k);
    await next();
  };
}

/** Tests: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}
