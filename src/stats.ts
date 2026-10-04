// The numbers the front page and the admin page show. Nothing personal.
import type { Db } from "./db";
import { NODE_ONLINE_MS } from "./nodes";
import { communismBoard } from "./communism";

export interface HubStats {
  nodes: number;
  nodesOnline: number;
  users: number;
  communismItems: number;
  /** Free communism slots on online nodes. */
  communismFree: number;
  swapsDone: number;
  handoversDone: number;
  openOffers: number;
}

export function hubStats(db: Db, now = Date.now()): HubStats {
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    nodes: one("SELECT COUNT(*) AS n FROM nodes WHERE unlinked_at IS NULL"),
    nodesOnline: one("SELECT COUNT(*) AS n FROM nodes WHERE last_seen_at IS NOT NULL AND last_seen_at >= ?", now - NODE_ONLINE_MS),
    users: one("SELECT COUNT(*) AS n FROM users"),
    communismItems: communismBoard(db, now).length,
    communismFree: one("SELECT COALESCE(SUM(a.free), 0) AS n FROM communism_accounts a JOIN nodes n ON n.id = a.node_id WHERE n.frozen = 0 AND n.last_seen_at IS NOT NULL AND n.last_seen_at >= ?", now - NODE_ONLINE_MS),
    swapsDone: one("SELECT COUNT(*) AS n FROM rendezvous WHERE state = 'done' AND counted = 1 AND kind IN ('swap', 'player')"),
    handoversDone: one("SELECT COUNT(*) AS n FROM rendezvous WHERE state = 'done' AND counted = 1 AND kind = 'communism'"),
    openOffers: one("SELECT COUNT(*) AS n FROM offers o JOIN nodes n ON n.id = o.node_id WHERE o.status = 'open' AND n.frozen = 0"),
  };
}
