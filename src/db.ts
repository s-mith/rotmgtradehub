// The hub's database. Nothing in here is a game credential or an item: hub
// user accounts, the nodes linked to them (public keys), what nodes report
// about themselves, ban telemetry, the operator's knobs, and (phase 3) the
// offer board: offers, rendezvous, receipts and attestations, all by
// catalog id and node-local ref, never an item instance. Phase 4b adds
// grants (who may use whose vault), what nodes publish about guest vaults,
// and the queue of guest requests nodes execute. Phase 4 adds the commons:
// what each node lists as free to take (no points, no ledger, no price) and
// a rendezvous kind for the one-way hand-over.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** rendezvous as phase 3 made it, except offer_id is nullable since phase 4 (a commons hand-over has no offer). Shared by CREATE TABLE and the rebuild below. */
const RENDEZVOUS_COLUMNS = `
      id INTEGER PRIMARY KEY,
      offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE,
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
      reason TEXT`;

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
    CREATE TABLE IF NOT EXISTS rendezvous (${RENDEZVOUS_COLUMNS}
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
    -- Phase 4 (docs/hub-protocol.md): the commons. What each node lists as free to take; the items stay on its bots.
    CREATE TABLE IF NOT EXISTS commons_items (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enchants_json TEXT NOT NULL,
      count INTEGER NOT NULL,
      seasonal INTEGER NOT NULL,
      bot_ign TEXT NOT NULL,
      listed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, ref)
    );
    CREATE INDEX IF NOT EXISTS commons_items_listed ON commons_items (listed_at);
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
  // Phase 4: a commons hand-over has no offer, so rendezvous.offer_id became nullable. SQLite cannot drop NOT NULL in
  // place; a database from phase 3 gets the table rebuilt (the documented copy, drop, rename dance, with foreign keys off
  // for the duration and ids kept so receipts still point at their rows).
  const rvCols = db.pragma("table_info(rendezvous)") as { name: string; notnull: number }[];
  if (rvCols.some((c) => c.name === "offer_id" && c.notnull)) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE rendezvous_new (${RENDEZVOUS_COLUMNS})`);
        const fresh = new Set((db.pragma("table_info(rendezvous_new)") as { name: string }[]).map((c) => c.name));
        const cols = rvCols.map((c) => c.name).filter((n) => fresh.has(n)).join(", ");
        db.exec(`INSERT INTO rendezvous_new (${cols}) SELECT ${cols} FROM rendezvous;
          DROP TABLE rendezvous;
          ALTER TABLE rendezvous_new RENAME TO rendezvous;
          CREATE INDEX IF NOT EXISTS rendezvous_state ON rendezvous (state, deadline_at);`);
        for (const t of ["rendezvous", "receipts"]) if ((db.pragma(`foreign_key_check(${t})`) as unknown[]).length) throw new Error(`rendezvous rebuild broke a foreign key in ${t}`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  // Phase 4: what a rendezvous is for, and for a commons hand-over, which listed item (guarded like the columns above).
  const rvNow = new Set((db.pragma("table_info(rendezvous)") as { name: string }[]).map((c) => c.name));
  if (!rvNow.has("kind")) db.exec("ALTER TABLE rendezvous ADD COLUMN kind TEXT NOT NULL DEFAULT 'swap'");
  if (!rvNow.has("commons_node_id")) db.exec("ALTER TABLE rendezvous ADD COLUMN commons_node_id TEXT");
  if (!rvNow.has("commons_ref")) db.exec("ALTER TABLE rendezvous ADD COLUMN commons_ref TEXT");
  // Offers whose meeting completed before "done" existed as a status stayed "accepted"; close them.
  db.prepare("UPDATE offers SET status = 'done', closed_at = COALESCE(closed_at, updated_at) WHERE status = 'accepted' AND id IN (SELECT offer_id FROM rendezvous WHERE state = 'done' AND offer_id IS NOT NULL)").run();
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
  /** Phase 4: commons hand-overs one node may take per rolling 24 h. */
  commonsDailyCap: number;
}

const DEFAULTS: HubSettings = { minNodeVersion: "0.1.0", latestNodeVersion: "0.1.0", downloadUrl: "", knownBuilds: [], gameVersion: "", buildUpdatedAt: 0, commonsDailyCap: 8 };

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
