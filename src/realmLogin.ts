// Signing in with a Realm character (docs/hub-protocol.md, "Realm logins").
// The operator names one node the login node (admin page). A person who wants
// in, or who wants to prove the IGN they trade with, gets a code here; the
// login node registers it with its login desk and says which bot to whisper;
// the person types "/tell <bot> <code>" in game; the node reports the
// character the whisper came from. Only a character's own session can /tell
// as it, so that proves it. No game password ever reaches the hub or the node.
//
// A sign-in lands on the account that has that character proven, or a new
// account (no email) for it. Proving a character while signed in makes it the
// account's IGN; a character is proven on one account at a time.
import { createHash, randomBytes } from "node:crypto";
import type { RealmLoginReady, RealmLoginVerified, RealmLoginWire } from "rotmgtradenode/shared/hubWire";
import { realmSignInRefusal, setVerifiedIgn, signInWithRealm, USER_IGN_RE, type User } from "./auth";
import { getSettings, type Db } from "./db";
import { emit } from "./events";
import { NODE_ONLINE_MS, nodeById, nodeStatus, type NodeRow } from "./nodes";
import { refuse, SERVER_RE, type Result } from "./offers";

/** A code works this long after it was handed out. */
export const REALM_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Codes: eight characters from the link-code alphabet (no 0/O, 1/I), easy to type into the game's chat. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;
/** The login node waits on the queue this long at most per call (like the request queue). */
export const MAX_LOGIN_WAIT_S = 25;
/**
 * A code handed to the login node is its once it says which bot to whisper (or that none can take it). One it never
 * answered within this long goes out again: the reply carrying it may have gone to a connection that was gone. The node
 * waits up to two and a half minutes for a desk bot before it answers, so the lease is longer than that.
 */
export const LOGIN_LEASE_MS = 4 * 60 * 1000;

export type RealmLoginState = "pending" | "taken" | "ready" | "verified" | "used" | "failed" | "expired";

export interface RealmLoginRow {
  id: number;
  code: string;
  token_hash: string;
  user_id: number | null;
  node_id: string | null;
  state: RealmLoginState;
  bot_ign: string | null;
  server: string | null;
  ign: string | null;
  error: string | null;
  next: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  taken_at: number | null;
}

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

// --- the login node's long poll ------------------------------------------------

const waiters = new Map<string, Set<() => void>>();
export function waitForLogin(nodeId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(nodeId);
    if (!set) waiters.set(nodeId, (set = new Set()));
    const done = () => {
      clearTimeout(t);
      set!.delete(done);
      if (!set!.size) waiters.delete(nodeId);
      resolve();
    };
    const t = setTimeout(done, ms);
    set.add(done);
  });
}
function wake(nodeId: string): void {
  for (const fn of [...(waiters.get(nodeId) ?? [])]) fn();
}

// --- the login node ----------------------------------------------------------------

/** The node the operator named, with whether it is online and where its login desk is. */
export function loginNodeState(db: Db, now = Date.now()): { node: NodeRow | null; online: boolean; desk: { botIgn: string | null; server: string | null; alwaysOn?: boolean } | null } {
  const id = getSettings(db).loginNodeId;
  const node = id ? nodeById(db, id) ?? null : null;
  if (!node) return { node: null, online: false, desk: null };
  const online = !node.frozen && node.last_seen_at !== null && now - node.last_seen_at <= NODE_ONLINE_MS;
  return { node, online, desk: nodeStatus(db, node.id)?.login ?? null };
}

export function isLoginNode(db: Db, nodeId: string): boolean {
  return getSettings(db).loginNodeId === nodeId;
}

/** Expired codes are marked so; day-old rows go. */
export function sweepRealmLogins(db: Db, now = Date.now()): void {
  db.prepare("UPDATE realm_logins SET state = 'expired' WHERE state IN ('pending', 'taken', 'ready') AND expires_at <= ?").run(now);
  db.prepare("DELETE FROM realm_logins WHERE created_at < ?").run(now - 24 * 3600 * 1000);
}

// --- a person asks for a code ------------------------------------------------------

/**
 * A fresh code for a person: `userId` set proves a character for that account;
 * null is a sign-in. The browser keeps `token` (a cookie) to follow and finish it.
 */
export function startRealmLogin(db: Db, opts: { userId: number | null; next?: string | null }, now = Date.now()): Result<{ id: number; code: string; token: string; expiresAt: number }> {
  sweepRealmLogins(db, now);
  const ln = loginNodeState(db, now);
  if (!ln.node) return refuse(409, "signing in with a Realm character is not set up on this site");
  if (!ln.online) return refuse(409, "the login node is offline right now; try again later");
  const token = randomBytes(24).toString("base64url");
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = randomBytes(CODE_LEN);
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    try {
      const r = db.prepare("INSERT INTO realm_logins (code, token_hash, user_id, state, next, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)").run(code, hashToken(token), opts.userId, opts.next ?? null, now, now + REALM_LOGIN_TTL_MS);
      wake(ln.node.id);
      return { ok: true, id: Number(r.lastInsertRowid), code, token, expiresAt: now + REALM_LOGIN_TTL_MS };
    } catch {
      // a code collision: draw again
    }
  }
  return refuse(409, "could not make a code; try again");
}

/** The login a browser holds, by its token. */
export function realmLoginByToken(db: Db, token: string | undefined, now = Date.now()): RealmLoginRow | null {
  if (!token) return null;
  sweepRealmLogins(db, now);
  return (db.prepare("SELECT * FROM realm_logins WHERE token_hash = ?").get(hashToken(token)) as RealmLoginRow | undefined) ?? null;
}

// --- the login node's side -----------------------------------------------------------

/** The login node's poll: codes waiting for its desk, each then `taken`, and any it took and never answered within LOGIN_LEASE_MS. Any other node gets none. */
export function takePendingLogins(db: Db, node: NodeRow, now = Date.now()): RealmLoginWire[] {
  if (!isLoginNode(db, node.id)) return [];
  sweepRealmLogins(db, now);
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, code, expires_at FROM realm_logins WHERE expires_at > ? AND (state = 'pending' OR (state = 'taken' AND COALESCE(taken_at, 0) <= ?)) ORDER BY id").all(now, now - LOGIN_LEASE_MS) as { id: number; code: string; expires_at: number }[];
    const take = db.prepare("UPDATE realm_logins SET state = 'taken', node_id = ?, taken_at = ? WHERE id = ? AND state IN ('pending', 'taken')");
    for (const r of rows) take.run(node.id, now, r.id);
    return rows.map((r) => ({ id: r.id, code: r.code, expiresAt: r.expires_at }));
  })();
}

function nodeLogin(db: Db, node: NodeRow, id: number): RealmLoginRow | ReturnType<typeof refuse> {
  const row = db.prepare("SELECT * FROM realm_logins WHERE id = ?").get(id) as RealmLoginRow | undefined;
  if (!row || row.node_id !== node.id || !isLoginNode(db, node.id)) return refuse(404, "no such login");
  return row;
}

/** The desk has the code: the bot to whisper, or why none can take it (then the code has failed). */
export function markLoginReady(db: Db, node: NodeRow, id: number, raw: unknown, now = Date.now()): Result<{ state: RealmLoginState }> {
  const row = nodeLogin(db, node, id);
  if ("ok" in row) return row;
  if (row.state !== "taken" && row.state !== "ready") return refuse(409, `login is ${row.state}`);
  const body = (raw ?? {}) as Partial<RealmLoginReady>;
  if (typeof body.error === "string" && body.error.trim()) {
    db.prepare("UPDATE realm_logins SET state = 'failed', error = ? WHERE id = ?").run(body.error.trim().slice(0, 200), id);
    return { ok: true, state: "failed" };
  }
  if (typeof body.botIgn !== "string" || !USER_IGN_RE.test(body.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  const server = typeof body.server === "string" && SERVER_RE.test(body.server) ? body.server : null;
  db.prepare("UPDATE realm_logins SET state = 'ready', bot_ign = ?, server = ? WHERE id = ?").run(body.botIgn, server, id);
  return { ok: true, state: "ready" };
}

/** The whisper arrived: the character that sent the code. */
export function markLoginVerified(db: Db, node: NodeRow, id: number, raw: unknown, now = Date.now()): Result<{ state: RealmLoginState }> {
  const row = nodeLogin(db, node, id);
  if ("ok" in row) return row;
  if (row.state === "verified" || row.state === "used") return { ok: true, state: row.state };
  if (row.state !== "taken" && row.state !== "ready") return refuse(409, `login is ${row.state}`);
  if (row.expires_at <= now) return refuse(409, "that code has expired");
  const body = (raw ?? {}) as Partial<RealmLoginVerified>;
  if (typeof body.ign !== "string" || !USER_IGN_RE.test(body.ign)) return refuse(400, "ign: letters only, 1..32");
  db.prepare("UPDATE realm_logins SET state = 'verified', ign = ? WHERE id = ?").run(body.ign, id);
  return { ok: true, state: "verified" };
}

// --- the browser finishes it -------------------------------------------------------------

/**
 * A verified code, used once: a sign-in lands on the account that has the
 * character proven, or a new one; proving while signed in makes it the
 * account's IGN. `mode` says which happened.
 */
export function finishRealmLogin(db: Db, token: string | undefined, now = Date.now()): Result<{ user: User; mode: "signed-in" | "proven"; ign: string; next: string | null }> {
  const row = realmLoginByToken(db, token, now);
  if (!row) return refuse(404, "that sign-in is not known here; start again");
  if (row.state !== "verified" || !row.ign) return refuse(409, row.state === "used" ? "that code was already used" : "the whisper has not arrived yet");
  if (row.user_id === null) {
    const refusal = realmSignInRefusal(db, row.ign);
    if (refusal) {
      db.prepare("UPDATE realm_logins SET state = 'failed', error = ? WHERE id = ?").run(refusal, row.id);
      return refuse(403, refusal);
    }
  }
  const used = db.prepare("UPDATE realm_logins SET state = 'used', used_at = ? WHERE id = ? AND state = 'verified'").run(now, row.id);
  if (!used.changes) return refuse(409, "that code was already used");
  if (row.user_id !== null) {
    setVerifiedIgn(db, row.user_id, row.ign, now);
    const u = db.prepare("SELECT id, email, display_name FROM users WHERE id = ?").get(row.user_id) as { id: number; email: string | null; display_name: string } | undefined;
    if (!u) return refuse(404, "that account is gone");
    emit(db, { users: [u.id], kind: "ign-proven", tone: "good", href: "/me#settings", text: `You proved ${row.ign} with a whisper: it is one of your characters now.` }, now);
    return { ok: true, user: { id: u.id, email: u.email, displayName: u.display_name }, mode: "proven", ign: row.ign, next: row.next };
  }
  const user = signInWithRealm(db, row.ign, now);
  return { ok: true, user, mode: "signed-in", ign: row.ign, next: row.next };
}
