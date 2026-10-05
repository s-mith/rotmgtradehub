// The hub's database. Nothing in here is a game credential or an item: hub
// user accounts, the nodes linked to them (public keys), what nodes report
// about themselves, ban telemetry, the operator's knobs, and (phase 3) the
// offer board: offers, rendezvous, receipts and attestations, all by
// catalog id and node-local ref, never an item instance. Then communism:
// the accounts each node sets aside for it (capacity), what they hold (free
// to take, no points, no ledger, no price), a rendezvous kind for the
// one-way hand-over, and the queue of requests hub users leave for a node
// to carry out (a deposit or withdraw met in game, an owner's offer).
// Shared vaults (grants, guest vaults, invites) existed once and are dropped
// on open.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * rendezvous as it stands: offer_id nullable since phase 4 (a communism
 * hand-over has no offer), taker_node_id nullable since player meetings (the
 * taker is a person's own character: taker_user_id, their IGN in
 * taker_bot_ign). Since meetings settle per side (2026-09-28, src/offers.ts):
 * when each side gave up, if it did, and whether both receipts agreed and the
 * meeting was counted. Every column is listed, so the rebuild below keeps them
 * all. Shared by CREATE TABLE and that rebuild.
 */
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
      taker_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      taker_bot_ign TEXT NOT NULL,
      taker_gives_json TEXT NOT NULL,
      closed_at INTEGER,
      reason TEXT,
      kind TEXT NOT NULL DEFAULT 'swap',
      communism_node_id TEXT,
      communism_ref TEXT,
      taker_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      progress_json TEXT,
      no_show INTEGER NOT NULL DEFAULT 0,
      player_confirmed_at INTEGER,
      player_report TEXT,
      player_report_at INTEGER,
      giver_gave_up_at INTEGER,
      taker_gave_up_at INTEGER,
      counted INTEGER NOT NULL DEFAULT 0`;

/**
 * users as they stand: password_hash nullable and google_sub for Google
 * sign-in; email nullable since Realm sign-in (an account made by
 * whispering a code to the login node has an IGN and no email). ign and
 * ign_verified_at are listed so the rebuild below keeps them. Shared by
 * CREATE TABLE and that rebuild.
 */
const USERS_COLUMNS = `
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      discord_webhook TEXT,
      discord_id TEXT,
      ign TEXT,
      ign_verified_at INTEGER`;

/**
 * A node's communism accounts, one row per account and side of the seasonal
 * split: an account with characters on both sides (advanced management) is
 * room on each (2026-10-05). Shared by CREATE TABLE and the rebuild that
 * moved the key from (node_id, ign).
 */
const COMMUNISM_ACCOUNTS_COLUMNS = `
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      seasonal INTEGER NOT NULL,
      slots INTEGER NOT NULL,
      free INTEGER NOT NULL,
      online INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, ign, seasonal)`;

export function openDb(file = process.env.HUB_DB || path.join(process.env.DATA_DIR || "./data", "hub.db")): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  renameFromBefore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (${USERS_COLUMNS}
    );
    -- One-shot codes from the website that let a node link to an account without a password (src/auth.ts).
    CREATE TABLE IF NOT EXISTS link_codes (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
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
      taker_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      closed_reason TEXT
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
    -- Requests hub users queue for a node (docs/hub-protocol.md, "Requests"): the node polls, executes, reports.
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
    -- Communism (docs/hub-protocol.md): the accounts each node set aside for it, and what they hold. Items stay on those bots.
    CREATE TABLE IF NOT EXISTS communism_accounts (${COMMUNISM_ACCOUNTS_COLUMNS}
    );
    CREATE TABLE IF NOT EXISTS communism_items (
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
    CREATE INDEX IF NOT EXISTS communism_items_listed ON communism_items (listed_at);
    -- What happened, for people (src/events.ts): one row per hub user it concerns.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL,
      text TEXT NOT NULL,
      href TEXT,
      notify INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_user ON events (user_id, at);
    -- Player meetings (src/players.ts): the characters a node's receipt saw trading, per hub user.
    CREATE TABLE IF NOT EXISTS ign_sightings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      UNIQUE (user_id, ign, node_id)
    );
    -- Realm logins (src/realmLogin.ts): sign-in codes a person whispers to the login node's desk bot.
    CREATE TABLE IF NOT EXISTS realm_logins (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      node_id TEXT,
      state TEXT NOT NULL,
      bot_ign TEXT,
      server TEXT,
      ign TEXT,
      error TEXT,
      next TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS realm_logins_state ON realm_logins (state, created_at);
  `);
  // Watches (src/watch.ts): tell me when someone gives or wants this item.
  db.exec(`CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      side TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, item_id, side)
    );
    CREATE INDEX IF NOT EXISTS watches_item ON watches (item_id, side);`);
  // Shared vaults are gone: a database from that time drops their tables (nothing else pointed at them).
  db.exec("DROP TABLE IF EXISTS invites; DROP TABLE IF EXISTS guest_vaults; DROP TABLE IF EXISTS grants;");
  // Google sign-in: accounts without a password. A v0 database has password_hash NOT NULL and no google_sub; SQLite cannot
  // drop NOT NULL in place, so the table is rebuilt the way rendezvous is below (foreign keys off, ids kept so sessions,
  // nodes and requests still point at their users).
  // Realm sign-in: an account may have no email, so email lost NOT NULL the same way (2026-09-23).
  const userCols = db.pragma("table_info(users)") as { name: string; notnull: number }[];
  if (userCols.some((c) => (c.name === "password_hash" || c.name === "email") && c.notnull) || !userCols.some((c) => c.name === "google_sub")) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE users_new (${USERS_COLUMNS})`);
        const fresh = new Set((db.pragma("table_info(users_new)") as { name: string }[]).map((c) => c.name));
        const cols = userCols.map((c) => c.name).filter((n) => fresh.has(n)).join(", ");
        db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;`);
        const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
        for (const t of ["sessions", "nodes", "guest_requests", "link_codes", "events", "watches", "rendezvous", "ign_sightings", "realm_logins"]) if (have.has(t) && (db.pragma(`foreign_key_check(${t})`) as unknown[]).length) throw new Error(`users rebuild broke a foreign key in ${t}`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  // Columns added after v0: guard with table_info so an existing database upgrades in place.
  const userNow = new Set((db.pragma("table_info(users)") as { name: string }[]).map((c) => c.name));
  if (!userNow.has("discord_webhook")) db.exec("ALTER TABLE users ADD COLUMN discord_webhook TEXT");
  // Discord sign-in: the account's Discord id. ALTER cannot add UNIQUE, so a partial unique index does it for every database.
  if (!userNow.has("discord_id")) db.exec("ALTER TABLE users ADD COLUMN discord_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id ON users (discord_id) WHERE discord_id IS NOT NULL");
  // The person's main character: the one forms use unless they pick another (the characters table holds them all).
  if (!userNow.has("ign")) db.exec("ALTER TABLE users ADD COLUMN ign TEXT");
  // Until 2026-09-29 an account had one character, proven here; the proof lives with each character now (below).
  if (!userNow.has("ign_verified_at")) db.exec("ALTER TABLE users ADD COLUMN ign_verified_at INTEGER");
  // Limits the operator lifted for one person (src/personLimits.ts): NULL is the default, 0 no limit.
  if (!userNow.has("max_nodes")) db.exec("ALTER TABLE users ADD COLUMN max_nodes INTEGER");
  if (!userNow.has("player_starts_per_hour")) db.exec("ALTER TABLE users ADD COLUMN player_starts_per_hour INTEGER");
  // A person's characters (src/auth.ts): the name as Realm shows it, and when a whisper to the login node proved it (null: typed
  // only). A character is proven on one account at a time. Once, for a database from before: each account's one IGN becomes
  // its first character, proven if it was.
  const hadCharacters = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'characters'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS characters (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ign TEXT NOT NULL,
      proven_at INTEGER,
      added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS characters_user_ign ON characters (user_id, lower(ign));
    CREATE UNIQUE INDEX IF NOT EXISTS characters_proven ON characters (lower(ign)) WHERE proven_at IS NOT NULL;`);
  if (!hadCharacters) {
    db.transaction(() => {
      db.prepare("INSERT INTO characters (user_id, ign, proven_at, added_at) SELECT id, ign, ign_verified_at, created_at FROM users WHERE ign IS NOT NULL").run();
      db.prepare("UPDATE users SET ign_verified_at = NULL WHERE ign_verified_at IS NOT NULL").run();
    })();
  }
  db.exec("DROP INDEX IF EXISTS users_verified_ign");
  const nodeCols = new Set((db.pragma("table_info(nodes)") as { name: string }[]).map((c) => c.name));
  if (!nodeCols.has("completed_swaps")) db.exec("ALTER TABLE nodes ADD COLUMN completed_swaps INTEGER NOT NULL DEFAULT 0");
  if (!nodeCols.has("frozen")) db.exec("ALTER TABLE nodes ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0");
  if (!nodeCols.has("frozen_reason")) db.exec("ALTER TABLE nodes ADD COLUMN frozen_reason TEXT");
  // What the node last reported about itself (gate, proxies, accounts): the website's node cards.
  if (!nodeCols.has("status_json")) db.exec("ALTER TABLE nodes ADD COLUMN status_json TEXT");
  // Player meetings that completed: a node's own counter, apart from completed_swaps (which drive the offer limits).
  if (!nodeCols.has("completed_player_trades")) db.exec("ALTER TABLE nodes ADD COLUMN completed_player_trades INTEGER NOT NULL DEFAULT 0");
  // When the login node took a code (realmLogin.ts): one it never answered goes out again after a lease.
  const loginCols = new Set((db.pragma("table_info(realm_logins)") as { name: string }[]).map((c) => c.name));
  if (!loginCols.has("taken_at")) db.exec("ALTER TABLE realm_logins ADD COLUMN taken_at INTEGER");
  // Unlinking keeps the row (src/nodes.ts unlinkNode): the meetings and receipts it was in keep both parties.
  if (!nodeCols.has("unlinked_at")) db.exec("ALTER TABLE nodes ADD COLUMN unlinked_at INTEGER");
  // Receipts may carry what crossed per physical item, enchantments included (offers.ts receiptsAgree).
  const receiptCols = new Set((db.pragma("table_info(receipts)") as { name: string }[]).map((c) => c.name));
  if (!receiptCols.has("gave_items_json")) db.exec("ALTER TABLE receipts ADD COLUMN gave_items_json TEXT");
  if (!receiptCols.has("got_items_json")) db.exec("ALTER TABLE receipts ADD COLUMN got_items_json TEXT");
  // A communism take names the contributor node (the ref goes in refs_json); a communism give names the receiving node.
  const reqCols = new Set((db.pragma("table_info(guest_requests)") as { name: string }[]).map((c) => c.name));
  if (!reqCols.has("communism_node_id")) db.exec("ALTER TABLE guest_requests ADD COLUMN communism_node_id TEXT");
  // A withdraw from several nodes is one request per node, handed out one after another (a person has one trade window):
  // the request that must close first, and when this one's turn came (its half hour counts from then).
  if (!reqCols.has("after_id")) db.exec("ALTER TABLE guest_requests ADD COLUMN after_id INTEGER");
  if (!reqCols.has("ready_at")) db.exec("ALTER TABLE guest_requests ADD COLUMN ready_at INTEGER");
  // A node's progress note restarts a request's half hour (requests.ts sweepGuestRequests).
  if (!reqCols.has("progress_at")) db.exec("ALTER TABLE guest_requests ADD COLUMN progress_at INTEGER");
  // Offers on behalf of a guest are gone with shared vaults; a database from then loses the two columns.
  const offerCols = new Set((db.pragma("table_info(offers)") as { name: string }[]).map((c) => c.name));
  if (offerCols.has("for_user_id")) db.exec("ALTER TABLE offers DROP COLUMN for_user_id");
  if (offerCols.has("taker_for_user_id")) db.exec("ALTER TABLE offers DROP COLUMN taker_for_user_id");
  // Why the hub closed an offer on its own: one of its items was traded away in another meeting (offers.ts).
  if (!offerCols.has("closed_reason")) db.exec("ALTER TABLE offers ADD COLUMN closed_reason TEXT");
  // A node's own key for an offer it posts (offers.ts createOffer): the same post sent twice (a lost reply) is one offer.
  if (!offerCols.has("client_key")) db.exec("ALTER TABLE offers ADD COLUMN client_key TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS offers_client_key ON offers (node_id, client_key) WHERE client_key IS NOT NULL");
  // Phase 4: a communism hand-over has no offer, so rendezvous.offer_id became nullable. SQLite cannot drop NOT NULL in
  // place; a database from phase 3 gets the table rebuilt (the documented copy, drop, rename dance, with foreign keys off
  // for the duration and ids kept so receipts still point at their rows).
  // Player meetings (2026-09-23): taker_node_id became nullable the same way.
  const rvCols = db.pragma("table_info(rendezvous)") as { name: string; notnull: number }[];
  // A database from before meetings settled per side gets its old meetings settled once (below).
  const settleOnce = !rvCols.some((c) => c.name === "counted");
  if (rvCols.some((c) => (c.name === "offer_id" || c.name === "taker_node_id") && c.notnull)) {
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
  // Communism accounts became one row per side (2026-10-05): a table keyed by (node_id, ign) is rebuilt with the side in its key.
  const caCols = db.pragma("table_info(communism_accounts)") as { name: string; pk: number }[];
  if (caCols.some((c) => c.name === "seasonal" && c.pk === 0)) {
    db.transaction(() => {
      db.exec(`CREATE TABLE communism_accounts_new (${COMMUNISM_ACCOUNTS_COLUMNS});
        INSERT INTO communism_accounts_new (node_id, ign, seasonal, slots, free, online, updated_at) SELECT node_id, ign, seasonal, slots, free, online, updated_at FROM communism_accounts;
        DROP TABLE communism_accounts;
        ALTER TABLE communism_accounts_new RENAME TO communism_accounts;`);
    })();
  }
  // Phase 4: what a rendezvous is for, and for a communism hand-over, which listed item (guarded like the columns above).
  const rvNow = new Set((db.pragma("table_info(rendezvous)") as { name: string }[]).map((c) => c.name));
  if (!rvNow.has("kind")) db.exec("ALTER TABLE rendezvous ADD COLUMN kind TEXT NOT NULL DEFAULT 'swap'");
  if (!rvNow.has("communism_node_id")) db.exec("ALTER TABLE rendezvous ADD COLUMN communism_node_id TEXT");
  if (!rvNow.has("communism_ref")) db.exec("ALTER TABLE rendezvous ADD COLUMN communism_ref TEXT");
  for (const [col, type] of [["taker_user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"], ["progress_json", "TEXT"], ["no_show", "INTEGER NOT NULL DEFAULT 0"], ["player_confirmed_at", "INTEGER"], ["player_report", "TEXT"], ["player_report_at", "INTEGER"], ["giver_gave_up_at", "INTEGER"], ["taker_gave_up_at", "INTEGER"], ["counted", "INTEGER NOT NULL DEFAULT 0"]] as const) {
    if (!rvNow.has(col)) db.exec(`ALTER TABLE rendezvous ADD COLUMN ${col} ${type}`);
  }
  // Meetings settle per side (2026-09-28, src/offers.ts): nothing freezes a node by itself any more, and one side's report
  // of a trade is not undone by the other giving up or saying nothing. Once, for a database from before: a completed
  // meeting counts as agreed; a dispute that was only one side's success the other never matched (it gave up, or the
  // deadline came) is done, the poster's offer closed when the poster was the side that traded; and the freezes those
  // disputes put on nodes lift. Receipts that contradict each other stay disputed.
  if (settleOnce) {
    db.transaction(() => {
      db.prepare("UPDATE rendezvous SET counted = 1 WHERE state = 'done'").run();
      const lone = db.prepare(`SELECT id, offer_id, kind, giver_node_id, reason FROM rendezvous WHERE state = 'disputed'
        AND (reason LIKE 'aborted after the partner reported success%' OR reason = 'deadline passed with an unconfirmed success report')`).all() as { id: number; offer_id: number | null; kind: string; giver_node_id: string; reason: string }[];
      for (const rv of lone) {
        const traded = db.prepare("SELECT DISTINCT node_id FROM receipts WHERE rendezvous_id = ? AND ok = 1").all(rv.id) as { node_id: string }[];
        if (traded.length !== 1) continue;
        const gaveUp = rv.reason.startsWith("aborted");
        const other = traded[0].node_id === rv.giver_node_id ? "taker" : "giver";
        db.prepare(`UPDATE rendezvous SET state = 'done', reason = ?${gaveUp ? `, ${other}_gave_up_at = COALESCE(closed_at, created_at)` : ""} WHERE id = ?`)
          .run(`one side reported the trade; the other ${gaveUp ? "gave up" : "sent nothing"} (was disputed: ${rv.reason})`, rv.id);
        if (rv.kind === "swap" && rv.offer_id !== null && other === "taker") db.prepare("UPDATE offers SET status = 'done' WHERE id = ? AND status = 'void'").run(rv.offer_id);
      }
      db.prepare("UPDATE nodes SET frozen = 0, frozen_reason = NULL WHERE frozen = 1 AND frozen_reason LIKE 'disputed rendezvous #%'").run();
    })();
  }
  db.exec("CREATE INDEX IF NOT EXISTS rendezvous_player ON rendezvous (taker_user_id, state)");
  // The communism board and its requests at scale (docs/relay/ADVANCED.md): an item someone is meeting the contributor
  // for, gives landing on an account (its room), a node's own gives under way (a surplus pass), open requests by kind,
  // and a node's copies of one item (a withdraw by count).
  db.exec(`CREATE INDEX IF NOT EXISTS rendezvous_communism_ref ON rendezvous (communism_node_id, communism_ref) WHERE kind = 'communism' AND state = 'meet';
    CREATE INDEX IF NOT EXISTS rendezvous_communism_in ON rendezvous (taker_node_id, taker_bot_ign) WHERE kind = 'communism' AND state = 'meet' AND communism_ref IS NULL;
    CREATE INDEX IF NOT EXISTS rendezvous_communism_out ON rendezvous (giver_node_id) WHERE kind = 'communism' AND state = 'meet' AND communism_ref IS NULL;
    CREATE INDEX IF NOT EXISTS guest_requests_open ON guest_requests (kind, node_id) WHERE state IN ('pending', 'taken');
    CREATE INDEX IF NOT EXISTS communism_items_item ON communism_items (node_id, item_id, seasonal);
    CREATE INDEX IF NOT EXISTS communism_items_half ON communism_items (seasonal, listed_at);`);
  // Until 2026-10-01 unlinking a node deleted its meetings with it, which left the partner's offer "accepted" with no
  // meeting behind it, for good. Such an offer is open again (sweepRendezvous expires it if its time is up).
  db.prepare("UPDATE offers SET status = 'open', taker_node_id = NULL WHERE status = 'accepted' AND NOT EXISTS (SELECT 1 FROM rendezvous r WHERE r.offer_id = offers.id)").run();
  // Ban telemetry from before the rename filed communism accounts under the old lane name.
  db.prepare("UPDATE ban_reports SET last_lane = 'communism' WHERE last_lane = ?").run("com" + "mons");
  // Offers whose meeting completed before "done" existed as a status stayed "accepted"; close them.
  db.prepare("UPDATE offers SET status = 'done', closed_at = COALESCE(closed_at, updated_at) WHERE status = 'accepted' AND id IN (SELECT offer_id FROM rendezvous WHERE state = 'done' AND offer_id IS NOT NULL)").run();
  return db;
}

/** The newest published node release on GitHub (src/releases.ts). */
export interface NodeRelease {
  /** The tag without its v: "0.1.0". */
  version: string;
  /** The release's page on GitHub. */
  page: string;
  /** The Windows installer and the Linux AppImage, when the release has them. */
  windows: string | null;
  linux: string | null;
  publishedAt: number;
}

export interface HubSettings {
  minNodeVersion: string;
  latestNodeVersion: string;
  downloadUrl: string;
  /** Realm builds the operator confirmed against the latest node's codecs. */
  knownBuilds: string[];
  gameVersion: string;
  buildUpdatedAt: number;
  /** The node that signs people in with a Realm character (src/realmLogin.ts): its login desk takes the whispered codes. "" = none. */
  loginNodeId: string;
  /** The newest node release found on GitHub, when its last check met one, and when and how that check went. */
  nodeRelease: NodeRelease | null;
  releaseCheckedAt: number;
  releaseNote: string;
}

/** A settings row from before (communism daily cap) is simply ignored. */
const DEFAULTS: HubSettings = { minNodeVersion: "0.1.0", latestNodeVersion: "0.1.0", downloadUrl: "", knownBuilds: [], gameVersion: "", buildUpdatedAt: 0, loginNodeId: "", nodeRelease: null, releaseCheckedAt: 0, releaseNote: "" };

/**
 * The settings the hub goes by: the stored ones, except that a release found on
 * GitHub is the latest node version, and that whenever there is anything to
 * download the link is /download, which hands out the newest installer
 * (src/releases.ts) or else the stored download URL.
 */
export function getSettings(db: Db): HubSettings {
  const s = storedSettings(db);
  const release = s.nodeRelease;
  return { ...s, latestNodeVersion: release?.version ?? s.latestNodeVersion, downloadUrl: release || s.downloadUrl ? "/download" : "" };
}

/** The settings as stored: what the admin page shows and edits. */
export function storedSettings(db: Db): HubSettings {
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
  return storedSettings(db);
}

/**
 * The thing was renamed on 2026-09-22 (communism, formerly com·mons): a database from before carries its
 * tables, columns and kind values under the old name. Renamed in place, before the schema above creates
 * anything, so nothing is created twice. The old names are spelled in pieces so a later rename leaves them be.
 */
function renameFromBefore(db: Database.Database): void {
  const old = "com" + "mons";
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  for (const suffix of ["_accounts", "_items"]) {
    if (!tables.has(`${old}${suffix}`)) continue;
    // A hub that started once between the rename and this block created the new table empty beside the old one.
    if (tables.has(`communism${suffix}`)) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM communism${suffix}`).get() as { n: number }).n;
      if (n > 0) continue;
      db.exec(`DROP TABLE communism${suffix}`);
    }
    db.exec(`ALTER TABLE ${old}${suffix} RENAME TO communism${suffix}`);
  }
  db.exec(`DROP INDEX IF EXISTS ${old}_items_listed`);
  const cols = (table: string) => new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name));
  for (const [table, col] of [["guest_requests", "node_id"], ["rendezvous", "node_id"], ["rendezvous", "ref"]] as const) {
    if (!tables.has(table)) continue;
    const c = cols(table);
    if (!c.has(`${old}_${col}`)) continue;
    if (c.has(`communism_${col}`)) {
      // Both columns (same story as the tables): the old value wins where the new one is empty, then the old column goes.
      db.exec(`UPDATE ${table} SET communism_${col} = ${old}_${col} WHERE communism_${col} IS NULL AND ${old}_${col} IS NOT NULL`);
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${old}_${col}`);
    } else db.exec(`ALTER TABLE ${table} RENAME COLUMN ${old}_${col} TO communism_${col}`);
  }
  for (const table of tables) {
    if (!cols(table).has("kind")) continue;
    db.prepare(`UPDATE ${table} SET kind = CASE kind WHEN ? THEN 'communism' WHEN ? THEN 'communism-take' WHEN ? THEN 'communism-give' ELSE kind END WHERE kind IN (?, ?, ?)`).run(old, `${old}-take`, `${old}-give`, old, `${old}-take`, `${old}-give`);
  }
}
