// Phase 4 of docs/hub-protocol.md: the commons (design doc §6.3). A node
// lists items that are free to take; they stay on its bots. Taking one is a
// one-way rendezvous (kind "commons"): the contributor's bot gives, the
// withdrawer's bot receives, and the receipts of phase 3 close it. What
// bounds it is the operator's per-node daily cap and that nobody takes their
// own items. No points, no ledger, no price anywhere.
import type { CommonsItemWire, CommonsListingWire, CommonsStatusWire, CommonsWithdrawRequest, OfferItemWire, PublishCommonsRequest, RendezvousWire } from "rotmgtrade/shared/hubWire";
import { getSettings, type Db } from "./db";
import { NODE_ONLINE_MS } from "./grants";
import type { NodeRow } from "./nodes";
import { IGN_RE, REF_RE, RENDEZVOUS_MS, SERVER_RE, isInt, limitsFor, refuse, rendezvousWire, sweepRendezvous, type Refusal, type RendezvousRow, type Result } from "./offers";

/** The rolling window the daily cap counts over. */
export const CAP_WINDOW_MS = 24 * 3600 * 1000;
/** A node may list this many items. */
export const MAX_COMMONS_ITEMS = 500;

// --- rows -------------------------------------------------------------------

interface CommonsItemRow {
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

function itemWire(r: CommonsItemRow): CommonsItemWire {
  return { ref: r.ref, itemId: r.item_id, name: r.name, enchants: JSON.parse(r.enchants_json) as number[] | null, count: r.count, seasonal: !!r.seasonal, botIgn: r.bot_ign };
}

/** True while someone is meeting the contributor for this item (`ci`): it is off the board, and a publish that omits it keeps it. */
const IN_MEETING = "EXISTS (SELECT 1 FROM rendezvous rv WHERE rv.kind = 'commons' AND rv.state = 'meet' AND rv.commons_node_id = ci.node_id AND rv.commons_ref = ci.ref)";

function listedBy(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM commons_items WHERE node_id = ?").get(nodeId) as { n: number }).n;
}

/** Commons hand-overs the node started as taker since `since` that are in one of `states`. */
function takesSince(db: Db, nodeId: string, since: number, states: string[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'commons' AND taker_node_id = ? AND created_at > ? AND state IN (${states.map(() => "?").join(", ")})`).get(nodeId, since, ...states) as { n: number }).n;
}

// --- validation -------------------------------------------------------------

function parseItems(raw: unknown): { items: CommonsItemWire[] } | Refusal {
  if (!Array.isArray(raw) || raw.length > MAX_COMMONS_ITEMS) return refuse(400, `items: up to ${MAX_COMMONS_ITEMS} items`);
  const items: CommonsItemWire[] = [];
  const refs = new Set<string>();
  for (const it of raw as Partial<CommonsItemWire>[]) {
    if (!it || typeof it !== "object") return refuse(400, "items: bad item");
    if (typeof it.ref !== "string" || !REF_RE.test(it.ref)) return refuse(400, "items: bad ref");
    if (refs.has(it.ref)) return refuse(400, `items: duplicate ref ${it.ref}`);
    refs.add(it.ref);
    if (typeof it.itemId !== "string" || it.itemId.length < 1 || it.itemId.length > 64) return refuse(400, "items: bad itemId");
    if (typeof it.name !== "string" || it.name.length > 80) return refuse(400, "items: bad name");
    if (!isInt(it.count, 0, 8)) return refuse(400, "items: count must be 0..8");
    if (it.enchants !== null && (!Array.isArray(it.enchants) || it.enchants.length > 8 || !it.enchants.every((e) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, "items: enchants must be null or integers");
    if (typeof it.seasonal !== "boolean") return refuse(400, "items: seasonal must be a boolean");
    if (typeof it.botIgn !== "string" || !IGN_RE.test(it.botIgn)) return refuse(400, "items: botIgn: letters only, 1..32");
    items.push({ ref: it.ref, itemId: it.itemId, name: it.name, enchants: it.enchants === null ? null : [...it.enchants], count: it.count, seasonal: it.seasonal, botIgn: it.botIgn });
  }
  return { items };
}

// --- publishing (node-signed) -----------------------------------------------

/** Replaces the node's listing. An item someone is meeting the contributor for right now stays until that meeting closes, even when this publish omits it. */
export function publishCommons(db: Db, node: NodeRow, req: PublishCommonsRequest, now = Date.now()): Result<{ listed: number }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const parsed = parseItems(req.items);
  if ("ok" in parsed) return parsed;
  const at = typeof req.at === "number" && Number.isFinite(req.at) && req.at > 0 ? Math.round(req.at) : now;
  const listed = db.transaction(() => {
    const published = new Set(parsed.items.map((it) => it.ref));
    const meeting = new Set((db.prepare("SELECT commons_ref AS ref FROM rendezvous WHERE kind = 'commons' AND state = 'meet' AND commons_node_id = ?").all(node.id) as { ref: string }[]).map((r) => r.ref));
    const del = db.prepare("DELETE FROM commons_items WHERE node_id = ? AND ref = ?");
    for (const { ref } of db.prepare("SELECT ref FROM commons_items WHERE node_id = ?").all(node.id) as { ref: string }[]) {
      if (!published.has(ref) && !meeting.has(ref)) del.run(node.id, ref);
    }
    // An item listed before keeps its listed_at: the board is ordered by it, and nodes publish often.
    const up = db.prepare(`INSERT INTO commons_items (node_id, ref, item_id, name, enchants_json, count, seasonal, bot_ign, listed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id, ref) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, enchants_json = excluded.enchants_json, count = excluded.count, seasonal = excluded.seasonal, bot_ign = excluded.bot_ign, updated_at = excluded.updated_at`);
    for (const it of parsed.items) up.run(node.id, it.ref, it.itemId, it.name, JSON.stringify(it.enchants), it.count, it.seasonal ? 1 : 0, it.botIgn, now, at);
    return listedBy(db, node.id);
  })();
  return { ok: true, listed };
}

// --- the board --------------------------------------------------------------

type BoardRow = CommonsItemRow & { contributor: string; last_seen_at: number };

/** Items of contributors seen within NODE_ONLINE_MS and not frozen, minus those someone is meeting for, newest listed first. Also sweeps. */
function board(db: Db, seasonal: boolean | undefined, now: number): BoardRow[] {
  sweepRendezvous(db, now);
  const half = seasonal === undefined ? null : seasonal ? 1 : 0;
  return db.prepare(`SELECT ci.*, u.display_name AS contributor, n.last_seen_at FROM commons_items ci JOIN nodes n ON n.id = ci.node_id JOIN users u ON u.id = n.user_id
    WHERE n.frozen = 0 AND n.last_seen_at IS NOT NULL AND n.last_seen_at >= ? AND (? IS NULL OR ci.seasonal = ?) AND NOT ${IN_MEETING}
    ORDER BY ci.listed_at DESC, ci.rowid DESC`).all(now - NODE_ONLINE_MS, half, half) as BoardRow[];
}

function listingWire(r: BoardRow, forNodeId: string | null): CommonsListingWire {
  return { ...itemWire(r), nodeId: r.node_id, contributor: r.contributor, mine: r.node_id === forNodeId, listedAt: r.listed_at };
}

/** The node's view of the board; `seasonal` undefined means both halves. */
export function listCommons(db: Db, forNode: NodeRow, seasonal?: boolean, now = Date.now()): CommonsListingWire[] {
  return board(db, seasonal, now).map((r) => listingWire(r, forNode.id));
}

/** The website's read-only view: the same board, plus how fresh each contributor's heartbeat is. */
export interface CommonsBoardItem extends CommonsListingWire {
  lastSeenAt: number;
}

export function commonsBoard(db: Db, now = Date.now()): CommonsBoardItem[] {
  return board(db, undefined, now).map((r) => ({ ...listingWire(r, null), lastSeenAt: r.last_seen_at }));
}

/** Everything the node has listed, as the hub holds it, including items someone is meeting for. */
export function listMine(db: Db, node: NodeRow): CommonsItemWire[] {
  const rows = db.prepare("SELECT * FROM commons_items WHERE node_id = ? ORDER BY listed_at DESC, rowid DESC").all(node.id) as CommonsItemRow[];
  return rows.map(itemWire);
}

export function commonsStatus(db: Db, node: NodeRow, now = Date.now()): CommonsStatusWire {
  return { dailyCap: getSettings(db).commonsDailyCap, usedToday: takesSince(db, node.id, now - CAP_WINDOW_MS, ["done"]), listed: listedBy(db, node.id) };
}

// --- withdrawing ------------------------------------------------------------

/** Starts the one-way meeting: the contributor gives the item, the caller's bot receives it and gives nothing. */
export function withdrawCommons(db: Db, taker: NodeRow, req: CommonsWithdrawRequest, now = Date.now()): Result<{ rendezvous: RendezvousWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  sweepRendezvous(db, now);
  if (limitsFor(db, taker).frozen) return refuse(409, "this node is frozen until the operator clears its dispute");
  if (typeof req.nodeId !== "string" || req.nodeId.length < 1 || req.nodeId.length > 64) return refuse(400, "nodeId must be a node id");
  if (typeof req.ref !== "string" || !REF_RE.test(req.ref)) return refuse(400, "ref: letters, digits, _ or -, 1..64");
  if (typeof req.server !== "string" || !SERVER_RE.test(req.server)) return refuse(400, "server: letters and digits, 1..24");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  const item = db.prepare(`SELECT ci.*, n.last_seen_at, n.frozen, ${IN_MEETING} AS meeting FROM commons_items ci JOIN nodes n ON n.id = ci.node_id WHERE ci.node_id = ? AND ci.ref = ?`)
    .get(req.nodeId, req.ref) as (CommonsItemRow & { last_seen_at: number | null; frozen: number; meeting: number }) | undefined;
  if (!item || item.meeting) return refuse(404, "that item is not listed");
  if (item.node_id === taker.id) return refuse(409, "that is your own item");
  if (item.frozen || item.last_seen_at === null || item.last_seen_at < now - NODE_ONLINE_MS) return refuse(409, "contributor offline");
  const cap = getSettings(db).commonsDailyCap;
  // Meetings under way count too, or one node could start many at once and let the cap sort it out later.
  if (takesSince(db, taker.id, now - CAP_WINDOW_MS, ["done", "meet"]) >= cap) return refuse(409, `daily cap reached: ${cap} hand-over${cap === 1 ? "" : "s"} per 24 h`);
  const gives: OfferItemWire[] = [{ ref: item.ref, itemId: item.item_id, enchants: JSON.parse(item.enchants_json) as number[] | null, count: item.count }];
  const r = db.prepare(`INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json, commons_node_id, commons_ref)
    VALUES (NULL, 'commons', ?, ?, 'meet', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`).run(req.server, item.seasonal, now, now + RENDEZVOUS_MS, item.node_id, item.bot_ign, JSON.stringify(gives), taker.id, req.botIgn, item.node_id, item.ref);
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(r.lastInsertRowid) as RendezvousRow;
  return { ok: true, rendezvous: rendezvousWire(db, rv, taker.id) };
}

// --- operator view ----------------------------------------------------------

export function commonsOperatorView(db: Db): { listed: number; contributors: number; handovers: number } {
  const listed = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT node_id) AS c FROM commons_items").get() as { n: number; c: number };
  return { listed: listed.n, contributors: listed.c, handovers: (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'commons' AND state = 'done'").get() as { n: number }).n };
}
