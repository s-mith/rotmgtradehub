// The hub's database. Nothing in here is a game credential or an item: hub
// user accounts, the nodes linked to them (public keys), what nodes report
// about themselves, ban telemetry, the operator's knobs, and (phase 3) the
// offer board: offers, rendezvous, receipts and attestations, all by
// catalog id and node-local ref, never an item instance. Phase 4b adds
// grants (who may use whose vault), what nodes publish about guest vaults,
// and the queue of guest requests nodes execute.
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
    -- Phase 3 (docs/hub-protocol.md): offers, rendezvous, receipts, attestations.
    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      bot_ign TEXT NOT NULL,
      seasonal INTEGER NOT NULL,
      server TEXT NOT NULL,
      give_json TEXT NOT NULL,
      want_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      closed_at INTEGER,
      taker_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS offers_status ON offers (status, created_at);
    CREATE TABLE IF NOT EXISTS rendezvous (
      id INTEGER PRIMARY KEY,
      offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      server TEXT NOT NULL,
      seasonal INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      giver_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      giver_bot_ign TEXT NOT NULL,
      giver_gives_json TEXT NOT NULL,
      taker_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      taker_bot_ign TEXT NOT NULL,
      taker_gives_json TEXT NOT NULL,
      closed_at INTEGER,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS rendezvous_state ON rendezvous (state, deadline_at);
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY,
      rendezvous_id INTEGER NOT NULL REFERENCES rendezvous(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      window INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      gave_json TEXT NOT NULL,
      gave_refs_json TEXT NOT NULL,
      got_json TEXT NOT NULL,
      partner_ign TEXT NOT NULL,
      error TEXT,
      at INTEGER NOT NULL,
      UNIQUE (rendezvous_id, node_id, window)
    );
    CREATE TABLE IF NOT EXISTS attestations (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      bot_ign TEXT NOT NULL,
      by_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      UNIQUE (node_id, bot_ign, by_node_id)
    );
    -- Phase 4b (docs/hub-protocol.md): shared vaults. Grants are keyed by node; the node does every physical thing.
    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      slots_seasonal INTEGER NOT NULL,
      slots_nonseasonal INTEGER NOT NULL,
      role TEXT NOT NULL,
      trade INTEGER NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (node_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS guest_vaults (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seasonal INTEGER NOT NULL,
      slots INTEGER NOT NULL,
      used INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, user_id, seasonal)
    );
    CREATE TABLE IF NOT EXISTS guest_requests (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      kind TEXT NOT NULL,
      seasonal INTEGER NOT NULL,
      server TEXT,
      count INTEGER,
      refs_json TEXT,
      want_json TEXT,
      offer_id INTEGER,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      taken_at INTEGER,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS guest_requests_state ON guest_requests (node_id, state, created_at);
    CREATE INDEX IF NOT EXISTS guest_requests_user ON guest_requests (user_id, node_id, created_at);
  `);
  // Columns added after v0: guard with table_info so an existing database upgrades in place.
  const nodeCols = new Set((db.pragma("table_info(nodes)") as { name: string }[]).map((c) => c.name));
  if (!nodeCols.has("completed_swaps")) db.exec("ALTER TABLE nodes ADD COLUMN completed_swaps INTEGER NOT NULL DEFAULT 0");
  if (!nodeCols.has("frozen")) db.exec("ALTER TABLE nodes ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0");
  if (!nodeCols.has("frozen_reason")) db.exec("ALTER TABLE nodes ADD COLUMN frozen_reason TEXT");
  const offerCols = new Set((db.pragma("table_info(offers)") as { name: string }[]).map((c) => c.name));
  // Phase 4b: the guest an offer was posted for, and the guest a taker accepted for (null: the node's owner).
  if (!offerCols.has("for_user_id")) db.exec("ALTER TABLE offers ADD COLUMN for_user_id INTEGER");
  if (!offerCols.has("taker_for_user_id")) db.exec("ALTER TABLE offers ADD COLUMN taker_for_user_id INTEGER");
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
