// Communism (docs/hub-protocol.md, design doc §6.3): every node sets
// aside whole accounts for it; their slots are communism's capacity and
// what they hold is free to take. The hub keeps what each node publishes
// (accounts with free slots, items with refs), shows one federated board,
// and arranges the bot-to-bot meetings: a take (the contributor's communism
// bot gives a listed item to the caller's bot) and a give (the caller's bot
// hands items to a communism bot with room). People deposit and withdraw in
// game through requests (requests.ts). No points, no caps, no price.
import type { CommunismAccountWire, CommunismGiveRequest, CommunismItemWire, CommunismListingWire, CommunismNodeWire, CommunismStatusWire, CommunismWithdrawRequest, OfferItemWire, PublishCommunismRequest, RendezvousWire } from "rotmgtradenode/shared/hubWire";
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { emit } from "./events";
import { recordChange, stackKey } from "./communismLive";
import { NODE_ONLINE_MS, parseStatus, takesByCount, type NodeRow } from "./nodes";
import { IGN_RE, MEETING_WITHIN, REF_RE, RENDEZVOUS_MS, describeItems, knownServer, isInt, itemsInMeeting, limitsFor, refuse, rendezvousWire, sweepRendezvous, type Refusal, type RendezvousRow, type Result } from "./offers";
import { EFFECTIVE_FREE, IN_MEETING, MAX_TRADE_ITEMS, PASSING, REQUEST_HOLDS, accountWithRoom } from "./requests";

// No cap on what a node lists or on how many accounts it sets aside: the
// communism is as big as its owner makes it.

// --- rows -------------------------------------------------------------------

interface CommunismItemRow {
  node_id: string;
  ref: string;
  item_id: string;
  name: string;
  enchants_json: string;
  count: number;
  seasonal: number;
  bot_ign: string;
  listed_at: number;
  updated_at: number;
}

interface CommunismAccountRow {
  node_id: string;
  ign: string;
  seasonal: number;
  slots: number;
  free: number;
  online: number;
  updated_at: number;
}

function itemWire(r: CommunismItemRow): CommunismItemWire {
  return { ref: r.ref, itemId: r.item_id, name: r.name, enchants: JSON.parse(r.enchants_json) as number[] | null, count: r.count, seasonal: !!r.seasonal, botIgn: r.bot_ign };
}

function accountWire(r: CommunismAccountRow): CommunismAccountWire {
  return { ign: r.ign, seasonal: !!r.seasonal, slots: r.slots, free: r.free, online: !!r.online };
}

// IN_MEETING (requests.ts): someone is meeting the contributor for an item; it is off the board, and a publish that omits it keeps it.

function listedBy(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM communism_items WHERE node_id = ?").get(nodeId) as { n: number }).n;
}

/**
 * A fingerprint of what the hub holds for a node: its refs, sorted. A node
 * publishing a difference names the fingerprint it built on; when the hub's
 * differs (a restart on either side, a lost publish) it asks for the whole
 * listing instead of applying a change to a listing it does not have.
 */
export function refsHash(db: Db, nodeId: string): string {
  const refs = (db.prepare("SELECT ref FROM communism_items WHERE node_id = ? ORDER BY ref").all(nodeId) as { ref: string }[]).map((r) => r.ref);
  return createHash("sha256").update(refs.join("\n")).digest("hex").slice(0, 32);
}

// --- validation -------------------------------------------------------------

function parseItems(raw: unknown): { items: CommunismItemWire[] } | Refusal {
  if (!Array.isArray(raw)) return refuse(400, "items: must be a list");
  const items: CommunismItemWire[] = [];
  const refs = new Set<string>();
  for (const it of raw as Partial<CommunismItemWire>[]) {
    if (!it || typeof it !== "object") return refuse(400, "items: bad item");
    if (typeof it.ref !== "string" || !REF_RE.test(it.ref)) return refuse(400, "items: bad ref");
    if (refs.has(it.ref)) return refuse(400, `items: duplicate ref ${it.ref}`);
    refs.add(it.ref);
    if (typeof it.itemId !== "string" || it.itemId.length < 1 || it.itemId.length > 64) return refuse(400, "items: bad itemId");
    if (typeof it.name !== "string" || it.name.length > 80) return refuse(400, "items: bad name");
    if (!isInt(it.count, 0, 8)) return refuse(400, "items: count must be 0..8");
    if (it.enchants !== null && (!Array.isArray(it.enchants) || it.enchants.length > 8 || !it.enchants.every((e: unknown) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, "items: enchants must be null or integers");
    if (typeof it.seasonal !== "boolean") return refuse(400, "items: seasonal must be a boolean");
    if (typeof it.botIgn !== "string" || !IGN_RE.test(it.botIgn)) return refuse(400, "items: botIgn: letters only, 1..32");
    items.push({ ref: it.ref, itemId: it.itemId, name: it.name, enchants: it.enchants === null ? null : [...it.enchants], count: it.count, seasonal: it.seasonal, botIgn: it.botIgn });
  }
  return { items };
}

function parseAccounts(raw: unknown): { accounts: CommunismAccountWire[] } | Refusal {
  if (raw === undefined) return { accounts: [] };
  if (!Array.isArray(raw)) return refuse(400, "accounts: must be a list");
  const accounts: CommunismAccountWire[] = [];
  // Each account once per side: one with characters on both sides of the split is room on each.
  const seen = new Set<string>();
  for (const a of raw as Partial<CommunismAccountWire>[]) {
    if (!a || typeof a !== "object") return refuse(400, "accounts: bad account");
    if (typeof a.ign !== "string" || !IGN_RE.test(a.ign)) return refuse(400, "accounts: ign: letters only, 1..32");
    if (typeof a.seasonal !== "boolean") return refuse(400, "accounts: seasonal must be a boolean");
    const key = `${a.ign}|${a.seasonal}`;
    if (seen.has(key)) return refuse(400, `accounts: duplicate ${a.ign} (${a.seasonal ? "seasonal" : "non-seasonal"})`);
    seen.add(key);
    if (!isInt(a.slots, 0, Number.MAX_SAFE_INTEGER)) return refuse(400, "accounts: slots must be a whole number");
    if (!isInt(a.free, 0, a.slots)) return refuse(400, "accounts: free must be 0..slots");
    if (typeof a.online !== "boolean") return refuse(400, "accounts: online must be a boolean");
    accounts.push({ ign: a.ign, seasonal: a.seasonal, slots: a.slots, free: a.free, online: a.online });
  }
  return { accounts };
}

// --- publishing (node-signed) -----------------------------------------------

/**
 * The node's communism: its accounts and its listing. Two shapes:
 *  - `items`: the whole listing, which replaces what the hub holds;
 *  - `base` + `added` + `removed`: a difference against the listing the hub
 *    holds, applied only when `base` matches the hub's fingerprint of it
 *    (409 `base mismatch` otherwise, and the node sends the whole listing).
 * Either way the reply carries the hub's new fingerprint. An item someone is
 * meeting the contributor for right now stays until that meeting closes,
 * even when the publish drops it.
 */
export function publishCommunism(db: Db, node: NodeRow, req: PublishCommunismRequest, now = Date.now()): Result<{ listed: number; accounts: number; hash: string }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const delta = req.items === undefined;
  if (delta && typeof req.base !== "string") return refuse(400, "items: must be a list, or base + added + removed");
  const parsed = parseItems(delta ? (req.added ?? []) : req.items);
  if ("ok" in parsed) return parsed;
  const accts = parseAccounts(req.accounts);
  if ("ok" in accts) return accts;
  const removed = delta ? req.removed ?? [] : [];
  if (!Array.isArray(removed) || removed.length > 100_000 || !removed.every((r) => typeof r === "string" && REF_RE.test(r))) return refuse(400, "removed: bad ref");
  const at = typeof req.at === "number" && Number.isFinite(req.at) && req.at > 0 ? Math.round(req.at) : now;
  const changes: { key: string; seasonal: boolean }[] = [];
  const out = db.transaction((): Result<{ listed: number; accounts: number; hash: string }> => {
    if (delta && refsHash(db, node.id) !== req.base) return refuse(409, "base mismatch: publish the whole listing");
    db.prepare("DELETE FROM communism_accounts WHERE node_id = ?").run(node.id);
    const acc = db.prepare("INSERT INTO communism_accounts (node_id, ign, seasonal, slots, free, online, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const a of accts.accounts) acc.run(node.id, a.ign, a.seasonal ? 1 : 0, a.slots, a.free, a.online ? 1 : 0, at);
    const before = new Map<string, CommunismItemRow>();
    for (const r of db.prepare("SELECT * FROM communism_items WHERE node_id = ?").all(node.id) as CommunismItemRow[]) before.set(r.ref, r);
    const meeting = new Set((db.prepare("SELECT communism_ref AS ref FROM rendezvous WHERE kind = 'communism' AND state = 'meet' AND communism_node_id = ? AND communism_ref IS NOT NULL").all(node.id) as { ref: string }[]).map((r) => r.ref));
    const del = db.prepare("DELETE FROM communism_items WHERE node_id = ? AND ref = ?");
    const dropping = delta ? removed.filter((ref) => before.has(ref)) : (() => { const published = new Set(parsed.items.map((it) => it.ref)); return [...before.keys()].filter((ref) => !published.has(ref)); })();
    for (const ref of dropping) {
      if (meeting.has(ref)) continue;
      del.run(node.id, ref);
      const old = before.get(ref)!;
      changes.push({ key: stackKey(old), seasonal: !!old.seasonal });
    }
    // An item listed before keeps its listed_at: the board is ordered by it, and nodes publish often.
    const up = db.prepare(`INSERT INTO communism_items (node_id, ref, item_id, name, enchants_json, count, seasonal, bot_ign, listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id, ref) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, enchants_json = excluded.enchants_json, count = excluded.count, seasonal = excluded.seasonal, bot_ign = excluded.bot_ign, updated_at = excluded.updated_at`);
    for (const it of parsed.items) {
      up.run(node.id, it.ref, it.itemId, it.name, JSON.stringify(it.enchants), it.count, it.seasonal ? 1 : 0, it.botIgn, now, at);
      const row: CommunismItemRow = { node_id: node.id, ref: it.ref, item_id: it.itemId, name: it.name, enchants_json: JSON.stringify(it.enchants), count: it.count, seasonal: it.seasonal ? 1 : 0, bot_ign: it.botIgn, listed_at: now, updated_at: at };
      const old = before.get(it.ref);
      const key = stackKey(row);
      if (!old) changes.push({ key, seasonal: it.seasonal });
      else if (stackKey(old) !== key || old.count !== it.count || old.name !== it.name) {
        changes.push({ key: stackKey(old), seasonal: !!old.seasonal });
        changes.push({ key, seasonal: it.seasonal });
      }
    }
    return { ok: true, listed: listedBy(db, node.id), accounts: accts.accounts.length, hash: refsHash(db, node.id) };
  })();
  if (out.ok) recordChange(changes);
  return out;
}

// --- the board --------------------------------------------------------------

type BoardRow = CommunismItemRow & { node_name: string; last_seen_at: number };

/**
 * The board's query. What is off the board (items someone is meeting the
 * contributor for, items an open request asked for by ref, items their node
 * is passing on) is worked out once per query, not once per item: a board of
 * many thousands of items costs one pass over the open meetings and requests
 * (docs/relay/ADVANCED.md, "index the hub board"). Exported for the
 * query-plan test.
 */
export const BOARD_SQL = `WITH off(node_id, ref) AS (
    SELECT communism_node_id, communism_ref FROM rendezvous WHERE kind = 'communism' AND state = 'meet' AND communism_ref IS NOT NULL
    UNION SELECT rv.giver_node_id, json_extract(gv.value, '$.ref') FROM rendezvous rv, json_each(rv.giver_gives_json) gv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL
    UNION SELECT g.node_id, j.value FROM guest_requests g, json_each(g.refs_json) j WHERE g.state IN ('pending', 'taken') AND g.kind = 'withdraw'
    UNION SELECT g.communism_node_id, j.value FROM guest_requests g, json_each(g.refs_json) j WHERE g.state IN ('pending', 'taken') AND g.kind = 'communism-take')
  SELECT ci.*, n.name AS node_name, n.last_seen_at FROM communism_items ci JOIN nodes n ON n.id = ci.node_id
  WHERE n.frozen = 0 AND n.last_seen_at IS NOT NULL AND n.last_seen_at >= ? AND (? IS NULL OR ci.seasonal = ?)
    AND (ci.node_id, ci.ref) NOT IN (SELECT node_id, ref FROM off WHERE node_id IS NOT NULL AND ref IS NOT NULL)
  ORDER BY ci.listed_at DESC, ci.rowid DESC`;

/** Items of contributors seen within NODE_ONLINE_MS and not frozen, minus those someone is meeting for, asking for or being handed, newest listed first. Also sweeps. */
function board(db: Db, seasonal: boolean | undefined, now: number): BoardRow[] {
  sweepRendezvous(db, now);
  const half = seasonal === undefined ? null : seasonal ? 1 : 0;
  return db.prepare(BOARD_SQL).all(now - NODE_ONLINE_MS, half, half) as BoardRow[];
}

/**
 * One listed item as another node sees it. Who owns the node is not said, and
 * which bot holds the item only to the node itself: whoever takes it learns the
 * bot from the meeting (2026-09-25). `holder` is for the hub's own page, which
 * groups by bot without ever showing it.
 */
function listingWire(r: BoardRow, forNodeId: string | null, holder = false): CommunismListingWire {
  const mine = r.node_id === forNodeId;
  return { ...itemWire(r), botIgn: mine || holder ? r.bot_ign : "", nodeId: r.node_id, node: r.node_name, contributor: "", mine, listedAt: r.listed_at };
}

/** The node's view of the board; `seasonal` undefined means both halves. */
export function listCommunism(db: Db, forNode: NodeRow, seasonal?: boolean, now = Date.now()): CommunismListingWire[] {
  return board(db, seasonal, now).map((r) => listingWire(r, forNode.id));
}

/** Every node with at least one communism account: its capacity per half, whether it is online, how many items it lists. */
export function communismNodes(db: Db, now = Date.now()): CommunismNodeWire[] {
  const rows = db.prepare(`SELECT n.id, n.name, n.last_seen_at, n.frozen, n.status_json,
      (SELECT COUNT(*) FROM communism_items ci WHERE ci.node_id = n.id AND NOT ${IN_MEETING}) AS items
    FROM nodes n WHERE EXISTS (SELECT 1 FROM communism_accounts a WHERE a.node_id = n.id)
    ORDER BY n.name, n.id`).all() as { id: string; name: string; last_seen_at: number | null; frozen: number; status_json: string | null; items: number }[];
  const sum = db.prepare(`SELECT COUNT(*) AS accounts, COALESCE(SUM(slots), 0) AS slots, COALESCE(SUM(${EFFECTIVE_FREE}), 0) AS free FROM communism_accounts a WHERE node_id = ? AND seasonal = ?`);
  return rows.map((n) => ({
    nodeId: n.id,
    name: n.name,
    // Who runs a node is not said on the board (2026-09-25).
    owner: "",
    online: !n.frozen && n.last_seen_at !== null && n.last_seen_at >= now - NODE_ONLINE_MS,
    server: parseStatus(n.status_json)?.deskServer ?? null,
    seasonal: sum.get(n.id, 1) as CommunismNodeWire["seasonal"],
    nonseasonal: sum.get(n.id, 0) as CommunismNodeWire["nonseasonal"],
    items: n.items,
    // Advanced management on its communism: a person may ask it for "N of this item" and it picks the copies.
    ...(takesByCount(parseStatus(n.status_json)) ? { byCount: true } : {}),
  }));
}

/** The website's view: the same board, plus how fresh each contributor's heartbeat is; `botIgn` is filled in for grouping and never rendered. */
export interface CommunismBoardItem extends CommunismListingWire {
  lastSeenAt: number;
}

export function communismBoard(db: Db, now = Date.now()): CommunismBoardItem[] {
  return board(db, undefined, now).map((r) => ({ ...listingWire(r, null, true), lastSeenAt: r.last_seen_at }));
}

/** Everything the node has listed, as the hub holds it, including items someone is meeting for, and its accounts. */
export function listMine(db: Db, node: NodeRow): { items: CommunismItemWire[]; accounts: CommunismAccountWire[] } {
  const rows = db.prepare("SELECT * FROM communism_items WHERE node_id = ? ORDER BY listed_at DESC, rowid DESC").all(node.id) as CommunismItemRow[];
  const accounts = db.prepare("SELECT * FROM communism_accounts WHERE node_id = ? ORDER BY seasonal DESC, ign").all(node.id) as CommunismAccountRow[];
  return { items: rows.map(itemWire), accounts: accounts.map(accountWire) };
}

export function communismStatus(db: Db, node: NodeRow): CommunismStatusWire {
  const a = db.prepare(`SELECT COUNT(DISTINCT ign) AS accounts, COALESCE(SUM(slots), 0) AS slots, COALESCE(SUM(${EFFECTIVE_FREE}), 0) AS free FROM communism_accounts a WHERE node_id = ?`).get(node.id) as { accounts: number; slots: number; free: number };
  return { accounts: a.accounts, slots: a.slots, free: a.free, listed: listedBy(db, node.id) };
}

// --- node-to-node: take and give ----------------------------------------------

const ownerAndName = (db: Db, nodeId: string) => db.prepare("SELECT n.user_id, n.name AS node, u.display_name AS name FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.id = ?").get(nodeId) as { user_id: number; node: string; name: string } | undefined;

/** A take: the contributor's communism bot gives the listed item, the caller's bot receives it and gives nothing. */
export function withdrawCommunism(db: Db, taker: NodeRow, req: CommunismWithdrawRequest, now = Date.now()): Result<{ rendezvous: RendezvousWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  sweepRendezvous(db, now);
  if (limitsFor(db, taker).frozen) return refuse(409, "the hub operator has frozen this node");
  if (typeof req.nodeId !== "string" || req.nodeId.length < 1 || req.nodeId.length > 64) return refuse(400, "nodeId must be a node id");
  if (typeof req.ref !== "string" || !REF_RE.test(req.ref)) return refuse(400, "ref: letters, digits, _ or -, 1..64");
  if (!knownServer(req.server)) return refuse(400, "server: one of the game's servers");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  // A person's withdraw or another node's take queued for the item has it first; the caller's own take (it is carrying one out) does not count.
  const item = db.prepare(`SELECT ci.*, n.last_seen_at, n.frozen, (${IN_MEETING} OR ${PASSING}) AS meeting, ${REQUEST_HOLDS("?")} AS held FROM communism_items ci JOIN nodes n ON n.id = ci.node_id WHERE ci.node_id = ? AND ci.ref = ?`)
    .get(taker.id, req.nodeId, req.ref) as (CommunismItemRow & { last_seen_at: number | null; frozen: number; meeting: number; held: number }) | undefined;
  if (!item || item.meeting) return refuse(404, "that item is not listed");
  if (item.held) return refuse(409, "someone asked for that item first");
  if (item.node_id === taker.id) return refuse(409, "that is your own item");
  if (item.frozen || item.last_seen_at === null || item.last_seen_at < now - NODE_ONLINE_MS) return refuse(409, "contributor offline");
  const gives: OfferItemWire[] = [{ ref: item.ref, itemId: item.item_id, enchants: JSON.parse(item.enchants_json) as number[] | null, count: item.count }];
  const r = db.prepare(`INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json, communism_node_id, communism_ref)
    VALUES (NULL, 'communism', ?, ?, 'meet', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`).run(req.server, item.seasonal, now, now + RENDEZVOUS_MS, item.node_id, item.bot_ign, JSON.stringify(gives), taker.id, req.botIgn, item.node_id, item.ref);
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(r.lastInsertRowid) as RendezvousRow;
  recordChange([{ key: stackKey(item), seasonal: !!item.seasonal }]);
  const giver = ownerAndName(db, item.node_id), receiver = ownerAndName(db, taker.id);
  emit(db, { users: [giver?.user_id], kind: "handover", tone: "accent", notify: true, href: "/communism", text: `${receiver?.name ?? "Someone"} is taking ${item.name} from your communism. Meeting on ${req.server} now: your bot ${item.bot_ign} hands it to ${req.botIgn} ${MEETING_WITHIN}.` }, now);
  emit(db, { users: [receiver?.user_id], kind: "handover", tone: "accent", href: "/communism", text: `Taking ${item.name} from ${giver?.name ?? "communism"}. Meeting on ${req.server} now: your bot ${req.botIgn} receives it from ${item.bot_ign} ${MEETING_WITHIN}.` }, now);
  return { ok: true, rendezvous: rendezvousWire(db, rv, taker.id) };
}

function parseGiveItems(raw: unknown): { items: OfferItemWire[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TRADE_ITEMS) return refuse(400, `items: 1..${MAX_TRADE_ITEMS} items`);
  const items: OfferItemWire[] = [];
  const refs = new Set<string>();
  for (const r of raw as Partial<OfferItemWire>[]) {
    if (!r || typeof r !== "object") return refuse(400, "items: bad item");
    if (typeof r.ref !== "string" || !REF_RE.test(r.ref)) return refuse(400, "items: bad ref");
    if (refs.has(r.ref)) return refuse(400, `items: duplicate ref ${r.ref}`);
    refs.add(r.ref);
    if (typeof r.itemId !== "string" || r.itemId.length < 1 || r.itemId.length > 64) return refuse(400, "items: bad itemId");
    if (!isInt(r.count, 0, 8)) return refuse(400, "items: count must be 0..8");
    if (r.enchants !== null && (!Array.isArray(r.enchants) || r.enchants.length > 8 || !r.enchants.every((e: unknown) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, "items: enchants must be null or integers");
    items.push({ ref: r.ref, itemId: r.itemId, enchants: r.enchants === null ? null : [...r.enchants], count: r.count });
  }
  return { items };
}

/**
 * Where a full communism passes its surplus on to (docs/relay/ADVANCED.md):
 * the communism account of that half with the most room on any node but
 * `except` that is online and not frozen. A node running advanced management
 * for communism takes passes only into its spare room (what it can hold
 * without then having to pass surplus on itself; one passing its own has
 * none), less what passes already under way bring it, so a pass never comes
 * back; any other node never passes, and takes them on its free slots. Null
 * when no account has room for one item.
 */
function roomiestElsewhere(db: Db, except: string, seasonal: boolean, now: number): { nodeId: string; ign: string; free: number } | null {
  const rows = db.prepare(`SELECT a.node_id AS nodeId, a.ign, ${EFFECTIVE_FREE} AS free, n.status_json AS status,
      (SELECT COALESCE(SUM(json_array_length(rv.giver_gives_json)), 0) FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL AND rv.taker_node_id = a.node_id AND rv.seasonal = a.seasonal) AS coming
    FROM communism_accounts a JOIN nodes n ON n.id = a.node_id
    WHERE a.seasonal = ? AND a.node_id != ? AND n.unlinked_at IS NULL AND n.frozen = 0 AND n.last_seen_at IS NOT NULL AND n.last_seen_at >= ?
    ORDER BY a.node_id, a.ign`).all(seasonal ? 1 : 0, except, now - NODE_ONLINE_MS) as { nodeId: string; ign: string; free: number; status: string | null; coming: number }[];
  let best: { nodeId: string; ign: string; free: number } | null = null;
  for (const r of rows) {
    const adv = parseStatus(r.status)?.advanced;
    const room = adv?.communism ? Math.min(r.free, Math.max(0, (adv.spare?.[seasonal ? "seasonal" : "nonseasonal"] ?? 0) - r.coming)) : r.free;
    if (room >= 1 && (!best || room > best.free)) best = { nodeId: r.nodeId, ign: r.ign, free: room };
  }
  return best;
}

/**
 * A give: the caller's bot hands `items` to a communism account of `nodeId`
 * with room for them (the one with the most free slots in that half). The
 * receiving side gives nothing; the receipts of a swap close it. Until it
 * closes its items count against the account's published room (INCOMING).
 *
 * `pass` (docs/relay/ADVANCED.md): the caller's communism is full and passes
 * its surplus on. The items must be its own listed communism copies of that
 * half that nobody is meeting for, asking for or being handed; the hub picks
 * the account with the most room on any other online node and hands it as
 * many of them, from the first, as it has room for. `nodeId` in the reply
 * names that node.
 */
export function giveCommunism(db: Db, giver: NodeRow, req: CommunismGiveRequest, now = Date.now()): Result<{ rendezvous: RendezvousWire; nodeId: string }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  sweepRendezvous(db, now);
  if (limitsFor(db, giver).frozen) return refuse(409, "the hub operator has frozen this node");
  const pass = req.pass === true;
  if (!pass && (typeof req.nodeId !== "string" || req.nodeId.length < 1 || req.nodeId.length > 64)) return refuse(400, "nodeId must be a node id");
  if (typeof req.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
  if (!knownServer(req.server)) return refuse(400, "server: one of the game's servers");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  const items = parseGiveItems(req.items);
  if ("ok" in items) return items;
  if (!pass && req.nodeId === giver.id) return refuse(409, "that is your own communism");
  if (itemsInMeeting(db, giver.id, items.items) !== null) return refuse(409, "one of those items is in another trade right now");
  const half = req.seasonal ? "seasonal" : "non-seasonal";
  let nodeId: string;
  let acct: { ign: string; free: number };
  let gives = items.items;
  if (pass) {
    // Only what is still listed and free goes: an item someone has asked for (or that left the listing) stays behind.
    const refs = gives.map((g) => g.ref);
    const free = new Set((db.prepare(`SELECT ref FROM communism_items ci WHERE ci.node_id = ? AND ci.seasonal = ? AND ci.ref IN (${refs.map(() => "?").join(", ")})
      AND NOT ${IN_MEETING} AND NOT ${REQUEST_HOLDS("NULL")} AND NOT ${PASSING}`).all(giver.id, req.seasonal ? 1 : 0, ...refs) as { ref: string }[]).map((r) => r.ref));
    gives = gives.filter((g) => free.has(g.ref));
    if (!gives.length) return refuse(409, `none of those items is listed and free in your ${half} communism any more`);
    const target = roomiestElsewhere(db, giver.id, req.seasonal, now);
    if (!target) return refuse(409, `no other node's ${half} communism has room right now`);
    nodeId = target.nodeId;
    acct = target;
    gives = gives.slice(0, target.free);
  } else {
    const target = db.prepare("SELECT last_seen_at, frozen FROM nodes WHERE id = ? AND unlinked_at IS NULL").get(req.nodeId) as { last_seen_at: number | null; frozen: number } | undefined;
    if (!target) return refuse(404, "no such node");
    if (target.frozen || target.last_seen_at === null || target.last_seen_at < now - NODE_ONLINE_MS) return refuse(409, "that node is offline");
    const room = accountWithRoom(db, req.nodeId, req.seasonal, gives.length);
    if (!room) return refuse(409, `no ${half} communism account there has room for ${gives.length} item${gives.length === 1 ? "" : "s"}`);
    nodeId = req.nodeId;
    acct = room;
  }
  const r = db.prepare(`INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json, communism_node_id, communism_ref)
    VALUES (NULL, 'communism', ?, ?, 'meet', ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL)`).run(req.server, req.seasonal ? 1 : 0, now, now + RENDEZVOUS_MS, giver.id, req.botIgn, JSON.stringify(gives), nodeId, acct.ign, nodeId);
  // The account's room is spoken for while the meeting is under way: accountWithRoom counts gives in flight against what the node published.
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(r.lastInsertRowid) as RendezvousRow;
  const from = ownerAndName(db, giver.id), to = ownerAndName(db, nodeId);
  const what = describeItems(gives);
  if (pass) {
    emit(db, { users: [to?.user_id], kind: "handover", tone: "accent", notify: true, href: "/communism", text: `${from?.name ?? "Another node"}'s ${half} communism is full and passes ${what} on to yours. Meeting on ${req.server} now: your bot ${acct.ign} receives it from ${req.botIgn} ${MEETING_WITHIN}.` }, now);
    emit(db, { users: [from?.user_id], kind: "handover", tone: "muted", href: "/communism", text: `Your ${half} communism is full: passing ${what} on to ${to?.name ?? "another node"}'s communism. Meeting on ${req.server} now: your bot ${req.botIgn} hands it to ${acct.ign} ${MEETING_WITHIN}.` }, now);
  } else {
    emit(db, { users: [to?.user_id], kind: "handover", tone: "accent", notify: true, href: "/communism", text: `${from?.name ?? "Someone"} is giving ${what} to your communism. Meeting on ${req.server} now: your bot ${acct.ign} receives it from ${req.botIgn} ${MEETING_WITHIN}.` }, now);
    emit(db, { users: [from?.user_id], kind: "handover", tone: "accent", href: "/communism", text: `Giving ${what} to ${to?.name ?? "communism"}'s communism. Meeting on ${req.server} now: your bot ${req.botIgn} hands it to ${acct.ign} ${MEETING_WITHIN}.` }, now);
  }
  return { ok: true, rendezvous: rendezvousWire(db, rv, giver.id), nodeId };
}

// --- operator view ----------------------------------------------------------

export interface CommunismTotals {
  listed: number;
  contributors: number;
  handovers: number;
  accounts: number;
  slots: number;
  free: number;
}

export function communismOperatorView(db: Db): CommunismTotals {
  const listed = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT node_id) AS c FROM communism_items").get() as { n: number; c: number };
  // An account on both sides of the split is one account, its room on each side counted.
  const a = db.prepare("SELECT COUNT(DISTINCT node_id || '|' || ign) AS accounts, COALESCE(SUM(slots), 0) AS slots, COALESCE(SUM(free), 0) AS free FROM communism_accounts").get() as { accounts: number; slots: number; free: number };
  return { listed: listed.n, contributors: listed.c, handovers: (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'communism' AND state = 'done' AND counted = 1").get() as { n: number }).n, ...a };
}
