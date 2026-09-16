// The hub's database. Nothing in here is a game credential or an item: hub
// user accounts, the nodes linked to them (public keys), what nodes report
// about themselves, ban telemetry, and the operator's knobs.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(file = process.env.HUB_DB || path.join(process.env.DATA_DIR || "./data", "hub.db")): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      version TEXT NOT NULL,
      build TEXT,
      linked_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS node_bots (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      seasonal INTEGER NOT NULL,
      online INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, ign)
    );
    CREATE TABLE IF NOT EXISTS ban_reports (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      account_hash TEXT NOT NULL,
      suspended_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_lane TEXT NOT NULL,
      held_items INTEGER NOT NULL,
      seasonal INTEGER,
      node_version TEXT NOT NULL,
      build TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      UNIQUE (node_id, account_hash, suspended_at)
    );
    CREATE INDEX IF NOT EXISTS ban_reports_time ON ban_reports (suspended_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export interface HubSettings {
  minNodeVersion: string;
  latestNodeVersion: string;
  downloadUrl: string;
  /** Realm builds the operator confirmed against the latest node's codecs. */
  knownBuilds: string[];
  gameVersion: string;
  buildUpdatedAt: number;
}

const DEFAULTS: HubSettings = { minNodeVersion: "0.1.0", latestNodeVersion: "0.1.0", downloadUrl: "", knownBuilds: [], gameVersion: "", buildUpdatedAt: 0 };

export function getSettings(db: Db): HubSettings {
  const out = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    if (r.key in out) (out as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
  }
  return out;
}

export function setSettings(db: Db, patch: Partial<HubSettings>): HubSettings {
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && v !== undefined) up.run(k, JSON.stringify(v));
  })();
  return getSettings(db);
}
