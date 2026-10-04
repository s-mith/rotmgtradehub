// Node registry: linking, the signed-request guard, heartbeats, unlinking.
import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { MAX_NODE_BOTS, NonceCache, verifyRequest, type HeartbeatRequest, type LinkRequest, type NodeStatusWire } from "rotmgtradenode/shared/hubWire";
import { lookupLinkCode, spendLinkCode } from "./auth";
import type { Db } from "./db";
import { emit } from "./events";
import { limitsOf } from "./personLimits";
import { windDown } from "./unlink";

/** A node whose last heartbeat is older than this shows as offline (heartbeats are a minute apart). */
export const NODE_ONLINE_MS = 3 * 60 * 1000;

export const isOnline = (lastSeenAt: number | null, now = Date.now()): boolean => lastSeenAt !== null && now - lastSeenAt <= NODE_ONLINE_MS;


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
  /** 1 while the hub operator has frozen the node: no new offers or accepts, and its offers hidden. */
  frozen: number;
  frozen_reason: string | null;
  /** The node's last self-report (NodeStatusWire), or null from an older node. */
  status_json: string | null;
  /** Player meetings that completed (src/players.ts); apart from completed_swaps, which drive the offer limits. */
  completed_player_trades: number;
  /** When it was unlinked (by its owner, the operator or itself). The row stays so its meetings and receipts keep their parties; it signs nothing any more. */
  unlinked_at: number | null;
}

/** A node as the website shows it: the row, bot counts, and the parsed self-report. */
export interface NodeView extends NodeRow {
  bots: number;
  online: number;
  status: NodeStatusWire | null;
}

export function parseStatus(json: string | null): NodeStatusWire | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as NodeStatusWire;
    return s && typeof s === "object" && s.gate && typeof s.gate === "object" ? s : null;
  } catch {
    return null;
  }
}

export function nodeStatus(db: Db, nodeId: string): NodeStatusWire | null {
  const r = db.prepare("SELECT status_json FROM nodes WHERE id = ?").get(nodeId) as { status_json: string | null } | undefined;
  return r ? parseStatus(r.status_json) : null;
}

export function linkNode(db: Db, req: LinkRequest): { ok: true; nodeId: string; userId: number; displayName: string; email: string } | { ok: false; status: number; error: string } {
  const publicKey = String(req.publicKey ?? "");
  if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(publicKey) || publicKey.length > 400) return { ok: false, status: 400, error: "publicKey must be a PEM SPKI key" };
  // A link code from the website. It is only spent once the node row exists, so a refused link leaves it usable.
  const code = typeof req.code === "string" ? req.code : "";
  const user = lookupLinkCode(db, code);
  if (!user) return { ok: false, status: 401, error: "that link code is not valid: codes last 15 minutes and work once; get a new one on the rotmg trade website" };
  const name = String(req.name ?? "").trim().slice(0, 40) || "node";
  const version = String(req.version ?? "").slice(0, 32);
  // As many nodes as the account may have: twenty, unless the hub operator set this person's own number (or no limit) on the admin page.
  const count = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND unlinked_at IS NULL").get(user.id) as { n: number }).n;
  const max = limitsOf(db, user.id).maxNodes;
  if (max !== null && count >= max) return { ok: false, status: 409, error: `that account already has ${count} nodes, its limit; unlink one on the website, or ask the hub operator for more` };
  const id = `n_${randomBytes(12).toString("base64url")}`;
  db.transaction(() => {
    db.prepare("INSERT INTO nodes (id, user_id, name, public_key, version, linked_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, user.id, name, publicKey, version, Date.now());
    spendLinkCode(db, code);
  })();
  emit(db, { users: [user.id], kind: "node-linked", tone: "good", text: `Node "${name}" linked to your account.`, href: "/me" });
  return { ok: true, nodeId: id, userId: user.id, displayName: user.displayName, email: user.email ?? "" };
}

/** A node by id, linked or not (an unlinked node's name still labels its old meetings). */
export function nodeById(db: Db, id: string): NodeRow | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}

/** A node that is still linked. */
export function linkedNodeById(db: Db, id: string): NodeRow | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ? AND unlinked_at IS NULL").get(id) as NodeRow | undefined;
}

const NODE_VIEW = "SELECT n.*, (SELECT COUNT(*) FROM node_bots b WHERE b.node_id = n.id) AS bots, (SELECT COUNT(*) FROM node_bots b WHERE b.node_id = n.id AND b.online = 1) AS online FROM nodes n WHERE n.unlinked_at IS NULL";

export function nodesOf(db: Db, userId: number): NodeView[] {
  const rows = db.prepare(`SELECT * FROM (${NODE_VIEW}) WHERE user_id = ? ORDER BY linked_at`).all(userId) as (NodeRow & { bots: number; online: number })[];
  return rows.map((r) => ({ ...r, status: parseStatus(r.status_json) }));
}

/** Every linked node with its owner's name, for the operator. */
export function allNodes(db: Db): (NodeView & { owner: string })[] {
  const rows = db.prepare(`SELECT v.*, u.display_name AS owner FROM (${NODE_VIEW}) v JOIN users u ON u.id = v.user_id ORDER BY v.last_seen_at DESC NULLS LAST, v.linked_at`).all() as (NodeRow & { bots: number; online: number; owner: string })[];
  return rows.map((r) => ({ ...r, status: parseStatus(r.status_json) }));
}

/**
 * Unlink a node. Its row stays (unlinked, keyless, offline) so the meetings it
 * was in, their receipts and any dispute keep both parties for the owners and
 * the operator; everything it had going is wound down the way its own word
 * would have: its open offers are cancelled, each meeting under way that it
 * had said nothing on is given up on its side (a partner's offer it had taken
 * opens again, a partner that reported the trade keeps it), the requests
 * queued for it fail, its communism leaves the board, and it stops being the
 * login node. Null when there is no such linked node (of `userId`'s).
 */
export function unlinkNode(db: Db, id: string, userId?: number, now = Date.now()): boolean {
  const node = linkedNodeById(db, id);
  if (!node || (userId !== undefined && node.user_id !== userId)) return false;
  db.transaction(() => {
    db.prepare("UPDATE nodes SET unlinked_at = ?, last_seen_at = NULL, public_key = '' WHERE id = ?").run(now, id);
    db.prepare("DELETE FROM node_bots WHERE node_id = ?").run(id);
    windDown(db, node, now);
  })();
  emit(db, { users: [node.user_id], kind: "node-unlinked", tone: "muted", text: `Node "${node.name}" was unlinked; its open offers and requests are closed.`, href: "/me" }, now);
  return true;
}

/** The self-report, checked field by field; anything odd drops the whole thing rather than half of it. */
function parseHeartbeatStatus(raw: unknown): NodeStatusWire | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<NodeStatusWire>;
  const g = s.gate as Partial<NodeStatusWire["gate"]> | undefined;
  if (!g || typeof g !== "object" || typeof g.held !== "boolean" || typeof g.known !== "boolean" || (g.reason !== null && typeof g.reason !== "string")) return null;
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null);
  const proxies = count(s.proxies), accounts = count(s.accounts), suspended = count(s.suspended);
  if (proxies === null || accounts === null || suspended === null) return null;
  const deskServer = s.deskServer === null || s.deskServer === undefined ? null : typeof s.deskServer === "string" && /^[A-Za-z0-9]{1,24}$/.test(s.deskServer) ? s.deskServer : null;
  const out: NodeStatusWire = { gate: { held: g.held, reason: g.reason === null ? null : g.reason.slice(0, 200), known: g.known }, proxies, accounts, suspended, deskServer };
  // What bounds its trades: how many bots it can have online at once, and its biggest trade inventory (offers.ts limitsFor).
  const onlineCap = count(s.onlineCap);
  if (onlineCap !== null) out.onlineCap = onlineCap;
  const slots = count(s.maxTradeSlots);
  if (slots !== null && slots >= 1) out.maxTradeSlots = Math.min(slots, 64);
  // Trades with players: whether the node takes them, how many at once, and the servers it meets on. Anything odd reads as "no";
  // a missing or odd count is one meeting per bot it can have online.
  const p = s.players as Partial<NonNullable<NodeStatusWire["players"]>> | undefined;
  if (p && typeof p === "object" && typeof p.enabled === "boolean") {
    const max = typeof p.maxMeetings === "number" && Number.isInteger(p.maxMeetings) && p.maxMeetings >= 1 && p.maxMeetings <= 10_000 ? p.maxMeetings : Math.max(1, onlineCap ?? proxies);
    const servers = Array.isArray(p.servers) ? p.servers.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9]{1,24}$/.test(x)).slice(0, 64) : [];
    out.players = { enabled: p.enabled, maxMeetings: max, servers };
    const ns = p.noShow as { limit?: unknown; pauseHours?: unknown } | undefined;
    if (ns && typeof ns === "object" && Number.isInteger(ns.limit) && (ns.limit as number) >= 0 && (ns.limit as number) <= 100 && Number.isInteger(ns.pauseHours) && (ns.pauseHours as number) >= 0 && (ns.pauseHours as number) <= 24 * 30) {
      out.players.noShow = { limit: ns.limit as number, pauseHours: ns.pauseHours as number };
    }
  }
  // The login desk, from the hub's login node.
  const l = s.login as Partial<NonNullable<NodeStatusWire["login"]>> | undefined;
  if (l && typeof l === "object") {
    const botIgn = typeof l.botIgn === "string" && /^[A-Za-z]{1,32}$/.test(l.botIgn) ? l.botIgn : null;
    const server = typeof l.server === "string" && /^[A-Za-z0-9]{1,24}$/.test(l.server) ? l.server : null;
    out.login = { botIgn, server, ...(typeof l.alwaysOn === "boolean" ? { alwaysOn: l.alwaysOn } : {}) };
  }
  // Advanced management, per pool: with communism on, the node takes "N of this item" withdraws, and says how much of
  // other nodes' surplus each side can take (spare). Anything odd reads as off, and odd spare as none.
  const a = s.advanced as Partial<NonNullable<NodeStatusWire["advanced"]>> | undefined;
  if (a && typeof a === "object") {
    out.advanced = { pool: a.pool === true, communism: a.communism === true };
    const room = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, 1_000_000_000) : 0);
    const sp = a.spare as { seasonal?: unknown; nonseasonal?: unknown } | undefined;
    if (out.advanced.communism) out.advanced.spare = sp && typeof sp === "object" ? { seasonal: room(sp.seasonal), nonseasonal: room(sp.nonseasonal) } : { seasonal: 0, nonseasonal: 0 };
  }
  return out;
}

/** Whether a node takes "N of this item" communism withdraws (its heartbeat says advanced management is on for communism). */
export function takesByCount(status: NodeStatusWire | null): boolean {
  return status?.advanced?.communism === true;
}

export function recordHeartbeat(db: Db, node: NodeRow, hb: HeartbeatRequest, now = Date.now()): void {
  // A node's accounts, up to MAX_NODE_BOTS; the node itself stops at that many (and says why), so none is dropped here in practice.
  const bots = Array.isArray(hb.bots) ? hb.bots.slice(0, MAX_NODE_BOTS) : [];
  const status = parseHeartbeatStatus(hb.status);
  const first = node.last_seen_at === null;
  db.transaction(() => {
    // A self-report that does not read keeps the last one for the card, but never its advanced management: what the node
    // takes (counts, passes) is only what it says now.
    db.prepare("UPDATE nodes SET version = ?, build = ?, last_seen_at = ?, status_json = COALESCE(?, json_remove(status_json, '$.advanced')) WHERE id = ?").run(String(hb.version ?? "").slice(0, 32), String(hb.build ?? "").slice(0, 32), now, status ? JSON.stringify(status) : null, node.id);
    db.prepare("DELETE FROM node_bots WHERE node_id = ?").run(node.id);
    const ins = db.prepare("INSERT OR REPLACE INTO node_bots (node_id, ign, seasonal, online, seen_at) VALUES (?, ?, ?, ?, ?)");
    for (const b of bots) {
      const ign = String(b.ign ?? "").slice(0, 32);
      if (!/^[A-Za-z]{1,32}$/.test(ign)) continue;
      ins.run(node.id, ign, b.seasonal ? 1 : 0, b.online ? 1 : 0, now);
    }
  })();
  if (first) emit(db, { users: [node.user_id], kind: "node-online", tone: "good", text: `Node "${node.name}" is connected and reporting.`, href: "/me" }, now);
}

type SignedEnv = { Variables: { node: NodeRow; body: string } };

/** Verifies X-Node-* against the node's stored key and hands the handler the node row and the raw body. */
export function signedByNode(db: Db, nonces = new NonceCache()): MiddlewareHandler<SignedEnv> {
  return async (c, next) => {
    const id = c.req.header("x-node-id") ?? "";
    const node = id ? linkedNodeById(db, id) : undefined;
    if (!node) return c.json({ error: "unknown node" }, 401);
    const body = await c.req.text();
    const url = new URL(c.req.url);
    const v = verifyRequest(node.public_key, { get: (k) => c.req.header(k) ?? null }, c.req.method, url.pathname + url.search, body);
    if (!v.ok) return c.json({ error: `signature refused: ${v.reason}` }, 401);
    // Each signed request is taken once: a copy sent again (captured on the way, or replayed) is refused.
    if (!nonces.take(node.id, v.nonce, v.ts)) return c.json({ error: "signature refused: replayed" }, 401);
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
