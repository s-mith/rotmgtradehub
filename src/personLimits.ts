// Limits the operator can lift for one person from the admin page: how many
// nodes they may link, and how many trades in game they may start an hour.
// A column left NULL means the default, 0 means no limit.
import type { Db } from "./db";

export const DEFAULT_NODES_PER_ACCOUNT = 20;
export const DEFAULT_PLAYER_STARTS_PER_HOUR = 6;

/** What one person may do; null is no limit. */
export interface PersonLimits {
  maxNodes: number | null;
  playerStartsPerHour: number | null;
}

const effective = (v: number | null | undefined, dflt: number): number | null => (v === null || v === undefined ? dflt : v === 0 ? null : v);

export function limitsOf(db: Db, userId: number): PersonLimits {
  const r = db.prepare("SELECT max_nodes, player_starts_per_hour FROM users WHERE id = ?").get(userId) as { max_nodes: number | null; player_starts_per_hour: number | null } | undefined;
  return { maxNodes: effective(r?.max_nodes, DEFAULT_NODES_PER_ACCOUNT), playerStartsPerHour: effective(r?.player_starts_per_hour, DEFAULT_PLAYER_STARTS_PER_HOUR) };
}

/** The operator's word for one person: a number, 0 for no limit, or null for the default. False when there is no such person. */
export function setPersonLimits(db: Db, userId: number, l: { maxNodes: number | null; playerStartsPerHour: number | null }): boolean {
  return db.prepare("UPDATE users SET max_nodes = ?, player_starts_per_hour = ? WHERE id = ?").run(l.maxNodes, l.playerStartsPerHour, userId).changes > 0;
}

/** A form field as a limit: blank is the default (null), otherwise a whole number, 0 meaning no limit. Undefined when it is neither. */
export function parseLimitField(raw: unknown): number | null | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : undefined;
}

export interface PersonRow {
  id: number;
  display_name: string;
  email: string | null;
  /** Their characters, comma-separated, or null. */
  igns: string | null;
  nodes: number;
  max_nodes: number | null;
  player_starts_per_hour: number | null;
}

/** People for the admin page, found by display name, email or any of their characters (any case, part of it). */
export function findPeople(db: Db, q: string, limit = 20): PersonRow[] {
  const like = `%${q.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return db.prepare(`SELECT u.id, u.display_name, u.email, u.max_nodes, u.player_starts_per_hour, (SELECT COUNT(*) FROM nodes n WHERE n.user_id = u.id AND n.unlinked_at IS NULL) AS nodes,
      (SELECT group_concat(ign, ', ') FROM characters ch WHERE ch.user_id = u.id) AS igns
    FROM users u WHERE lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(u.email, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM characters ch WHERE ch.user_id = u.id AND lower(ch.ign) LIKE ? ESCAPE '\\')
    ORDER BY u.display_name LIMIT ?`).all(like, like, like, limit) as PersonRow[];
}
