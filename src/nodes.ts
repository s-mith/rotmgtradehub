// Node registry: linking, the signed-request guard, heartbeats, unlinking.
import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { verifyRequest, type HeartbeatRequest, type LinkRequest } from "rotmgtrade/shared/hubWire";
import { authenticate } from "./auth";
import type { Db } from "./db";

export interface NodeRow {
  id: string;
  user_id: number;
  name: string;
  public_key: string;
  version: string;
  build: string | null;
  linked_at: number;
  last_seen_at: number | null;
  /** Phase 3: swaps that reached `done`; drives the offer limits. */
  completed_swaps: number;
  /** 1 while a disputed rendezvous is unresolved: no new offers or accepts. */
  frozen: number;
  frozen_reason: string | null;
}

export function linkNode(db: Db, req: LinkRequest): { ok: true; nodeId: string; userId: number; displayName: string } | { ok: false; status: number; error: string } {
  const user = authenticate(db, String(req.email ?? ""), String(req.password ?? ""));
  if (!user) return { ok: false, status: 401, error: "wrong email or password" };
  const publicKey = String(req.publicKey ?? "");
  if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(publicKey) || publicKey.length > 400) return { ok: false, status: 400, error: "publicKey must be a PEM SPKI key" };
  const name = String(req.name ?? "").trim().slice(0, 40) || "node";
  const version = String(req.version ?? "").slice(0, 32);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").get(user.id) as { n: number }).n;
  if (count >= 5) return { ok: false, status: 409, error: "that account already has 5 nodes; unlink one on the website" };
  const id = `n_${randomBytes(12).toString("base64url")}`;
  db.prepare("INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, user.id, name, publicKey, version, Date.now());
  return { ok: true, nodeId: id, userId: user.id, displayName: user.displayName };
}

export function nodeById(db: Db, id: string): NodeRow | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}

export function nodesOf(db: Db, userId: number): (NodeRow & { bots: number; online: number })[] {
  return db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM node_bots b WHERE b.node_id = n.id) AS bots, (SELECT COUNT(*) FROM node_bots b WHERE b.node_id = n.id AND b.online = 1) AS online
    FROM nodes n WHERE n.user_id = ? ORDER BY n.linked_at`).all(userId) as (NodeRow & { bots: number; online: number })[];
}

export function unlinkNode(db: Db, id: string, userId?: number): boolean {
  const r = userId === undefined ? db.prepare("DELETE FROM nodes WHERE id = ?").run(id) : db.prepare("DELETE FROM nodes WHERE id = ? AND user_id = ?").run(id, userId);
  return r.changes > 0;
}

export function recordHeartbeat(db: Db, node: NodeRow, hb: HeartbeatRequest, now = Date.now()): void {
  const bots = Array.isArray(hb.bots) ? hb.bots.slice(0, 64) : [];
  db.transaction(() => {
    db.prepare("UPDATE nodes SET version = ?, build = ?, last_seen_at = ? WHERE id = ?").run(String(hb.version ?? "").slice(0, 32), String(hb.build ?? "").slice(0, 32), now, node.id);
    db.prepare("DELETE FROM node_bots WHERE node_id = ?").run(node.id);
    const ins = db.prepare("INSERT OR REPLACE INTO node_bots (node_id, ign, seasonal, online, seen_at) VALUES (?, ?, ?, ?, ?)");
    for (const b of bots) {
      const ign = String(b.ign ?? "").slice(0, 32);
      if (!/^[A-Za-z]{1,32}$/.test(ign)) continue;
      ins.run(node.id, ign, b.seasonal ? 1 : 0, b.online ? 1 : 0, now);
    }
  })();
}

type SignedEnv = { Variables: { node: NodeRow; body: string } };

/** Verifies X-Node-* against the node's stored key and hands the handler the node row and the raw body. */
export function signedByNode(db: Db): MiddlewareHandler<SignedEnv> {
  return async (c, next) => {
    const id = c.req.header("x-node-id") ?? "";
    const node = id ? nodeById(db, id) : undefined;
    if (!node) return c.json({ error: "unknown node" }, 401);
    const body = await c.req.text();
    const url = new URL(c.req.url);
    const v = verifyRequest(node.public_key, { get: (k) => c.req.header(k) ?? null }, c.req.method, url.pathname + url.search, body);
    if (!v.ok) return c.json({ error: `signature refused: ${v.reason}` }, 401);
    c.set("node", node);
    c.set("body", body);
    await next();
  };
}

export function parseJson<T>(c: Context<SignedEnv>): T | null {
  try {
    return JSON.parse(c.get("body") || "{}") as T;
  } catch {
    return null;
  }
}
