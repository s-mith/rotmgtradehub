// Ban telemetry intake and the aggregate the operator reads (design doc §8).
// Reports are already anonymous (salted per node); the hub adds the node id
// so a wave can be split by node, lane, cohort and build.
import type { BanReportWire } from "rotmgtradenode/shared/hubWire";
import type { Db } from "./db";

const LANES = new Set(["idle", "owner-trade", "swap", "commons", "tutorial-walk", "unknown"]);

export function acceptReports(db: Db, nodeId: string, reports: unknown, now = Date.now()): number {
  if (!Array.isArray(reports)) return 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO ban_reports (node_id, account_hash, suspended_at, last_seen_at, last_lane, held_items, seasonal, node_version, build, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.transaction(() => {
    for (const raw of reports.slice(0, 500) as Partial<BanReportWire>[]) {
      const hash = String(raw.account ?? "");
      const at = Number(raw.suspendedAt);
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(hash) || !Number.isFinite(at)) continue;
      const lane = LANES.has(String(raw.lastLane)) ? String(raw.lastLane) : "unknown";
      const r = ins.run(nodeId, hash, Math.round(at), raw.lastSeenAt == null ? null : Math.round(Number(raw.lastSeenAt)), lane, Math.max(0, Math.round(Number(raw.heldItems) || 0)),
        raw.seasonal == null ? null : raw.seasonal ? 1 : 0, String(raw.nodeVersion ?? "").slice(0, 32), String(raw.build ?? "").slice(0, 32), now);
      if (r.changes) n++;
    }
  })();
  return n;
}

export interface BanSummary {
  total: number;
  last24h: number;
  last7d: number;
  byLane: { lane: string; n: number }[];
  byBuild: { build: string; n: number }[];
  byDay: { day: string; n: number }[];
  nodesReporting: number;
}

export function summarize(db: Db, now = Date.now()): BanSummary {
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    total: one("SELECT COUNT(*) AS n FROM ban_reports"),
    last24h: one("SELECT COUNT(*) AS n FROM ban_reports WHERE suspended_at > ?", now - 86_400_000),
    last7d: one("SELECT COUNT(*) AS n FROM ban_reports WHERE suspended_at > ?", now - 7 * 86_400_000),
    byLane: db.prepare("SELECT last_lane AS lane, COUNT(*) AS n FROM ban_reports GROUP BY last_lane ORDER BY n DESC").all() as { lane: string; n: number }[],
    byBuild: db.prepare("SELECT build, COUNT(*) AS n FROM ban_reports GROUP BY build ORDER BY n DESC").all() as { build: string; n: number }[],
    byDay: db.prepare("SELECT date(suspended_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM ban_reports WHERE suspended_at > ? GROUP BY day ORDER BY day").all(now - 30 * 86_400_000) as { day: string; n: number }[],
    nodesReporting: one("SELECT COUNT(DISTINCT node_id) AS n FROM ban_reports"),
  };
}
