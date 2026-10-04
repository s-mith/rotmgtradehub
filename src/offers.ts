// Phase 3 of docs/hub-protocol.md: the offer board, rendezvous between two
// nodes' bots, and the receipts that close them. Pure functions over the db;
// the routes in app.tsx only translate results to JSON. The hub never sees
// an item instance: offers carry catalog ids and the poster's own refs.
// A rendezvous also serves communism (kind "communism", communism.ts): no
// offer behind it, one side gives, the other gives nothing back. And player
// meetings (kind "player", players.ts): a person with their own character
// takes a node's offer; there is no second node, so the node's receipt alone
// closes it. One item may sit in several offers of its node at once: while a
// meeting has it the others are held, and once it is traded away there they
// are withdrawn ("one item in several offers" below).
import { CLIENT_KEY_RE, ITEM_REF_RE, type AcceptOfferRequest, type CreateOfferRequest, type MeetingProgressWire, type NodeLimitsWire, type OfferItemWire, type OfferStatusWire, type OfferWire, type ReceiptWire, type RendezvousKind, type RendezvousState, type RendezvousWire, type WantLineWire } from "rotmgtradenode/shared/hubWire";
import type { Db } from "./db";
import { NODE_ONLINE_MS, parseStatus, type NodeRow } from "./nodes";
import { itemName } from "./catalog";
import { emit } from "./events";
import { recordChange, stackKey } from "./communismLive";
import { afterOfferPosted } from "./watch";
import { SERVER_SET } from "rotmgtradenode/servers";

export const OFFER_TTL_MS = 14 * 24 * 3600 * 1000;
/** A trade takes about a minute once both bots are there: a meeting gets six minutes (2026-09-29). */
export const RENDEZVOUS_MS = 6 * 60 * 1000;
/** A node still trying (a bot logging in, a server queue) may ask for this much more, up to RENDEZVOUS_MAX_MS after the meeting was made. */
export const RENDEZVOUS_EXTEND_MS = 10 * 60 * 1000;
export const RENDEZVOUS_MAX_MS = 16 * 60 * 1000;
/** How the notices put the meeting's time: "within 6 minutes". */
export const MEETING_WITHIN = `within ${RENDEZVOUS_MS / 60_000} minutes`;
/** Open offers at once, the same for every node. */
export const MAX_OPEN_OFFERS = 30;
/** One full trade window (a character with a backpack and an extender): the most items either side of a trade can hold. */
export const MAX_TRADE_ITEMS = 24;
/** A node's biggest trade inventory until it reports one: a character's own eight slots. */
const DEFAULT_TRADE_SLOTS = 8;
export const FINISHED_KEEP = 20;

export const IGN_RE = /^[A-Za-z]{1,32}$/;
export const SERVER_RE = /^[A-Za-z0-9]{1,24}$/;
/** A Realm server meetings can be on: one the game has (the shared list nodes trade on), not just a well-formed name. */
export const knownServer = (s: unknown): s is string => typeof s === "string" && SERVER_RE.test(s) && SERVER_SET.has(s);
export const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type Refusal = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type Result<T> = ({ ok: true } & T) | Refusal;
export const refuse = (status: Refusal["status"], error: string): Refusal => ({ ok: false, status, error });

// --- rows -------------------------------------------------------------------

export interface OfferRow {
  id: number;
  node_id: string;
  bot_ign: string;
  seasonal: number;
  server: string;
  give_json: string;
  want_json: string;
  status: OfferStatusWire;
  created_at: number;
  updated_at: number;
  expires_at: number;
  closed_at: number | null;
  taker_node_id: string | null;
  /** Why the hub closed it on its own (an item traded away in another meeting); null otherwise. */
  closed_reason: string | null;
}

export interface RendezvousRow {
  id: number;
  /** The offer behind a swap; null for a communism hand-over. */
  offer_id: number | null;
  kind: RendezvousKind;
  server: string;
  seasonal: number;
  state: RendezvousState;
  created_at: number;
  deadline_at: number;
  giver_node_id: string;
  giver_bot_ign: string;
  giver_gives_json: string;
  /** Null for a player meeting: the taker is a person (taker_user_id), `taker_bot_ign` their IGN. */
  taker_node_id: string | null;
  taker_bot_ign: string;
  taker_gives_json: string;
  closed_at: number | null;
  reason: string | null;
  /** A communism hand-over: communism node (contributor of a take, receiver of a give) and, for a take, the item's ref there. */
  communism_node_id: string | null;
  communism_ref: string | null;
  /** A player meeting: the person, the node's latest word on it, whether they never came, and what they said afterwards. */
  taker_user_id: number | null;
  progress_json: string | null;
  no_show: number;
  player_confirmed_at: number | null;
  player_report: string | null;
  player_report_at: number | null;
  /** When each side's node gave its side up, if it did (abortRendezvous). */
  giver_gave_up_at: number | null;
  taker_gave_up_at: number | null;
  /** 1 once both receipts agreed and the meeting counted (completed swaps, attestations); a player meeting, once its node's receipt closed it. */
  counted: number;
}

export interface ReceiptRow {
  id: number;
  rendezvous_id: number;
  node_id: string;
  window: number;
  ok: number;
  gave_json: string;
  gave_refs_json: string;
  got_json: string;
  /** Per physical item with enchantments, when the node could read the window; null from an older node. */
  gave_items_json: string | null;
  got_items_json: string | null;
  partner_ign: string;
  error: string | null;
  at: number;
}

export type Qty = { itemId: string; qty: number };
/** One physical item as a receipt or a meeting describes it. */
export type ItemDetail = { itemId: string; enchants: number[] | null; count: number };

// --- limits -----------------------------------------------------------------

/**
 * A node's limits (2026-09-29): the same number of open offers for every
 * node; items per side up to the biggest trade inventory it reports (the
 * trade window shows both sides the real size, so overstating it only fails
 * its own trades); and one offer taken at a time per bot it can have online.
 */
export function limitsFor(db: Db, node: Pick<NodeRow, "id">): NodeLimitsWire {
  const row = db.prepare("SELECT completed_swaps, frozen, status_json FROM nodes WHERE id = ?").get(node.id) as { completed_swaps: number; frozen: number; status_json: string | null } | undefined;
  const status = parseStatus(row?.status_json ?? null);
  const slots = status?.maxTradeSlots;
  return {
    maxOpenOffers: MAX_OPEN_OFFERS,
    maxItemsPerSide: typeof slots === "number" && slots >= 1 ? Math.min(MAX_TRADE_ITEMS, slots) : DEFAULT_TRADE_SLOTS,
    completedSwaps: row?.completed_swaps ?? 0,
    frozen: !!row?.frozen,
    maxTakes: Math.max(1, status?.onlineCap ?? status?.proxies ?? 1),
  };
}

function openOffersOf(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM offers WHERE node_id = ? AND status = 'open'").get(nodeId) as { n: number }).n;
}

function activeTakes(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE taker_node_id = ? AND state = 'meet' AND kind = 'swap'").get(nodeId) as { n: number }).n;
}

// --- validation -------------------------------------------------------------

export const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function parseItems(raw: unknown, max: number, what: string): { items: OfferItemWire[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return refuse(400, `${what}: 1..${max} items`);
  const items: OfferItemWire[] = [];
  const refs = new Set<string>();
  for (const r of raw as Partial<OfferItemWire>[]) {
    if (!r || typeof r !== "object") return refuse(400, `${what}: bad item`);
    if (typeof r.ref !== "string" || !REF_RE.test(r.ref)) return refuse(400, `${what}: bad ref`);
    if (refs.has(r.ref)) return refuse(400, `${what}: duplicate ref ${r.ref}`);
    refs.add(r.ref);
    if (typeof r.itemId !== "string" || r.itemId.length < 1 || r.itemId.length > 64) return refuse(400, `${what}: bad itemId`);
    if (!isInt(r.count, 0, 8)) return refuse(400, `${what}: count must be 0..8`);
    if (r.enchants !== null && (!Array.isArray(r.enchants) || r.enchants.length > 8 || !r.enchants.every((e) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, `${what}: enchants must be null or integers`);
    items.push({ ref: r.ref, itemId: r.itemId, enchants: r.enchants === null ? null : [...r.enchants], count: r.count });
  }
  return { items };
}

export function parseWant(raw: unknown, maxQty: number): { want: WantLineWire[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return refuse(400, "want: 1..8 lines");
  const want: WantLineWire[] = [];
  let total = 0;
  for (const r of raw as Partial<WantLineWire>[]) {
    if (!r || typeof r !== "object") return refuse(400, "want: bad line");
    if (typeof r.itemId !== "string" || r.itemId.length < 1 || r.itemId.length > 64) return refuse(400, "want: bad itemId");
    // Each line's own bound is one full trade; the total below holds it to this node's limit.
    if (!isInt(r.qty, 1, MAX_TRADE_ITEMS)) return refuse(400, `want: qty must be 1..${MAX_TRADE_ITEMS}`);
    if (!isInt(r.slotsMin, 0, 8)) return refuse(400, "want: slotsMin must be 0..8");
    if (r.slotsExact !== null && !isInt(r.slotsExact, 0, 8)) return refuse(400, "want: slotsExact must be null or 0..8");
    if (!Array.isArray(r.enchants) || r.enchants.length > 32) return refuse(400, "want: enchants must be an array");
    total += r.qty;
    want.push({ itemId: r.itemId, qty: r.qty, slotsMin: r.slotsMin, slotsExact: r.slotsExact, enchants: JSON.parse(JSON.stringify(r.enchants)) });
  }
  if (total > maxQty) return refuse(409, `want: at most ${maxQty} items in total`);
  return { want };
}

function parseDetails(raw: unknown, what: string): { list: ItemDetail[] | null } | Refusal {
  if (raw === undefined) return { list: null };
  if (!Array.isArray(raw) || raw.length > 64) return refuse(400, `${what}: must be a list`);
  const list: ItemDetail[] = [];
  for (const r of raw as Partial<ItemDetail>[]) {
    if (!r || typeof r !== "object" || typeof r.itemId !== "string" || r.itemId.length < 1 || r.itemId.length > 64) return refuse(400, `${what}: bad entry`);
    if (r.enchants !== null && (!Array.isArray(r.enchants) || r.enchants.length > 8 || !r.enchants.every((e) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, `${what}: enchants must be null or integers`);
    if (!isInt(r.count, 0, 8)) return refuse(400, `${what}: count must be 0..8`);
    list.push({ itemId: r.itemId, enchants: r.enchants === null ? null : [...r.enchants], count: r.count });
  }
  return { list };
}

function parseQtys(raw: unknown, what: string): { list: Qty[] } | Refusal {
  if (!Array.isArray(raw) || raw.length > 64) return refuse(400, `${what}: must be a list`);
  const list: Qty[] = [];
  for (const r of raw as Partial<Qty>[]) {
    if (!r || typeof r !== "object" || typeof r.itemId !== "string" || r.itemId.length < 1 || r.itemId.length > 64 || !isInt(r.qty, 1, 64)) return refuse(400, `${what}: bad entry`);
    list.push({ itemId: r.itemId, qty: r.qty });
  }
  return { list };
}

// --- shaping ----------------------------------------------------------------

/** The node's owner's display name. */
export function posterOf(db: Db, nodeId: string): string {
  const r = db.prepare("SELECT u.display_name AS name FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.id = ?").get(nodeId) as { name: string } | undefined;
  return r?.name ?? "?";
}

function offerWire(db: Db, o: OfferRow, forNodeId: string, poster = posterOf(db, o.node_id), heldBy: number | null = null): OfferWire {
  const mine = o.node_id === forNodeId;
  return {
    id: o.id,
    poster,
    mine,
    // The poster's bot is named to its own node only: the other side learns it from the meeting, and nobody else ever (2026-09-25).
    botIgn: mine ? o.bot_ign : "",
    seasonal: !!o.seasonal,
    server: o.server,
    give: JSON.parse(o.give_json) as OfferItemWire[],
    want: JSON.parse(o.want_json) as WantLineWire[],
    status: o.status,
    createdAt: o.created_at,
    expiresAt: o.expires_at,
    ...(mine && heldBy !== null ? { heldBy } : {}),
    ...(mine && o.closed_reason ? { closedReason: o.closed_reason } : {}),
  };
}

/** "2× Ring of Decades, Doom Bow": what a list of items reads as to a person. */
export function describeItems(items: { itemId: string; qty?: number }[]): string {
  const qs = "qty" in (items[0] ?? {}) ? (items as Qty[]) : collapse(items as OfferItemWire[]);
  return qs.map((q) => (q.qty > 1 ? `${q.qty}× ${itemName(q.itemId)}` : itemName(q.itemId))).join(", ") || "nothing";
}

/** The hub users with a stake in a rendezvous: both nodes' owners, or the node's owner and the person of a player meeting. */
export function partiesOf(db: Db, rv: RendezvousRow): { giver: number | null; taker: number | null } {
  const owner = (nodeId: string | null) => (nodeId === null ? null : (db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(nodeId) as { user_id: number } | undefined)?.user_id ?? null);
  return { giver: owner(rv.giver_node_id), taker: rv.kind === "player" ? rv.taker_user_id : owner(rv.taker_node_id) };
}

/** A hub user's display name. */
export function userName(db: Db, userId: number | null): string {
  if (userId === null) return "?";
  const r = db.prepare("SELECT display_name AS name FROM users WHERE id = ?").get(userId) as { name: string } | undefined;
  return r?.name ?? "?";
}

/** The taker's name as people read it: the other node's owner, or the person of a player meeting. */
export function takerName(db: Db, rv: RendezvousRow): string {
  return rv.kind === "player" ? userName(db, rv.taker_user_id) : rv.taker_node_id === null ? "?" : posterOf(db, rv.taker_node_id);
}

/** The want lines of the offer behind a meeting (a player meeting judges what the person puts up by them). */
export function offerWant(db: Db, offerId: number | null): WantLineWire[] {
  if (offerId === null) return [];
  const r = db.prepare("SELECT want_json FROM offers WHERE id = ?").get(offerId) as { want_json: string } | undefined;
  return r ? (JSON.parse(r.want_json) as WantLineWire[]) : [];
}

/** Physical items → catalog counts, first-seen order. */
export function collapse(items: OfferItemWire[]): Qty[] {
  const out: Qty[] = [];
  for (const it of items) {
    const hit = out.find((q) => q.itemId === it.itemId);
    if (hit) hit.qty++;
    else out.push({ itemId: it.itemId, qty: 1 });
  }
  return out;
}

/** Catalog counts merged by item, first-seen order. */
export function collapseQty(list: Qty[]): Qty[] {
  const out: Qty[] = [];
  for (const q of list) {
    const hit = out.find((x) => x.itemId === q.itemId);
    if (hit) hit.qty += q.qty;
    else out.push({ itemId: q.itemId, qty: q.qty });
  }
  return out;
}

/** Canonical form for comparing receipts: merged by itemId, sorted. */
function canon(list: Qty[]): string {
  const m = new Map<string, number>();
  for (const q of list) m.set(q.itemId, (m.get(q.itemId) ?? 0) + q.qty);
  return JSON.stringify([...m.entries()].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Two per-item lists describe the same physical items: same catalog ids,
 * and the same enchant ids wherever both sides could read them (a null on
 * either side is an unreadable record and matches by catalog id alone).
 */
export function detailsAgree(a: ItemDetail[], b: ItemDetail[]): boolean {
  if (a.length !== b.length) return false;
  const key = (d: ItemDetail) => (d.enchants === null ? null : [...d.enchants].sort((x, y) => x - y).join(","));
  const used = new Set<number>();
  // Specific ones first so a wildcard never takes a copy a specific entry needed.
  const order = a.map((d, i) => ({ d, i })).sort((x, y) => Number(y.d.enchants !== null) - Number(x.d.enchants !== null));
  for (const { d } of order) {
    const k = key(d);
    const j = b.findIndex((e, idx) => !used.has(idx) && e.itemId === d.itemId && (k === null || key(e) === null || key(e) === k));
    if (j === -1) return false;
    used.add(j);
  }
  return true;
}

/** What the two receipts of a meeting say about what changed hands, compared as finely as both allow. */
function receiptsAgree(giver: ReceiptRow, taker: ReceiptRow): boolean {
  const counts = canon(JSON.parse(giver.gave_json)) === canon(JSON.parse(taker.got_json)) && canon(JSON.parse(taker.gave_json)) === canon(JSON.parse(giver.got_json));
  if (!counts) return false;
  const parse = (j: string | null): ItemDetail[] | null => (j === null ? null : (JSON.parse(j) as ItemDetail[]));
  const gg = parse(giver.gave_items_json), tg = parse(taker.got_items_json);
  if (gg && tg && !detailsAgree(gg, tg)) return false;
  const tgave = parse(taker.gave_items_json), ggot = parse(giver.got_items_json);
  if (tgave && ggot && !detailsAgree(tgave, ggot)) return false;
  return true;
}

/** One side's view of a rendezvous, swap or communism hand-over: what it gives, what it gets, who it meets. */
export function rendezvousWire(db: Db, rv: RendezvousRow, nodeId: string): RendezvousWire {
  if (rv.kind === "player") {
    // The node is always the one giving; what comes back is whatever covers the offer's want lines.
    const lines = offerWant(db, rv.offer_id);
    const mine = db.prepare("SELECT 1 FROM receipts WHERE rendezvous_id = ? AND node_id = ?").get(rv.id, nodeId);
    return {
      id: rv.id, kind: "player", offerId: rv.offer_id, communism: null, server: rv.server, seasonal: !!rv.seasonal, state: rv.state, createdAt: rv.created_at, deadlineAt: rv.deadline_at,
      me: { role: "give", botIgn: rv.giver_bot_ign, gives: JSON.parse(rv.giver_gives_json) as OfferItemWire[], gets: collapseQty(lines.map((l) => ({ itemId: l.itemId, qty: l.qty }))), getsLines: lines },
      partner: { botIgn: rv.taker_bot_ign, poster: userName(db, rv.taker_user_id), player: true },
      reported: { mine: !!mine, partner: false },
    };
  }
  const giving = rv.giver_node_id === nodeId;
  const mine = JSON.parse(giving ? rv.giver_gives_json : rv.taker_gives_json) as OfferItemWire[];
  const theirs = JSON.parse(giving ? rv.taker_gives_json : rv.giver_gives_json) as OfferItemWire[];
  const partnerId = (giving ? rv.taker_node_id : rv.giver_node_id) ?? "";
  const reported = db.prepare("SELECT DISTINCT node_id FROM receipts WHERE rendezvous_id = ?").all(rv.id) as { node_id: string }[];
  return {
    id: rv.id,
    kind: rv.kind,
    offerId: rv.offer_id,
    communism: rv.kind === "communism" && rv.communism_node_id !== null && rv.communism_ref !== null ? { nodeId: rv.communism_node_id, ref: rv.communism_ref } : null,
    server: rv.server,
    seasonal: !!rv.seasonal,
    state: rv.state,
    createdAt: rv.created_at,
    deadlineAt: rv.deadline_at,
    me: { role: giving ? "give" : "take", botIgn: giving ? rv.giver_bot_ign : rv.taker_bot_ign, gives: mine, gets: collapse(theirs), getsItems: theirs.map((t) => ({ itemId: t.itemId, enchants: t.enchants, count: t.count })) },
    partner: { botIgn: giving ? rv.taker_bot_ign : rv.giver_bot_ign, poster: posterOf(db, partnerId) },
    reported: { mine: reported.some((r) => r.node_id === nodeId), partner: reported.some((r) => r.node_id === partnerId) },
  };
}

// --- one item in several offers -------------------------------------------------
//
// A node may put one item in several offers at once (2026-09-29): it names
// the item by the same ref, its instance id (ITEM_REF_RE), in each of them and
// in whatever else it hands the item over in. While a meeting under way has
// the item, the node's other open offers naming it are held: left out of the
// open list and refused to takers, so two meetings never count on the same
// item. When the node reports the item traded away there, they are withdrawn;
// when the meeting ends without that, they are open again by themselves.

/** Refs among `items` that name a physical item the same way everywhere its node offers or hands it over. */
export function itemRefsOf(items: OfferItemWire[]): string[] {
  return items.map((i) => i.ref).filter((r) => ITEM_REF_RE.test(r));
}

type Busy = Map<string, Map<string, number>>;

/** What nodes are handing over in meetings under way (all of them, or `nodeId`'s): node -> item ref -> the meeting. */
function busyItems(db: Db, nodeId?: string): Busy {
  const cols = "id, giver_node_id, giver_gives_json, taker_node_id, taker_gives_json";
  const rows = (nodeId === undefined
    ? db.prepare(`SELECT ${cols} FROM rendezvous WHERE state = 'meet'`).all()
    : db.prepare(`SELECT ${cols} FROM rendezvous WHERE state = 'meet' AND (giver_node_id = ? OR taker_node_id = ?)`).all(nodeId, nodeId)) as Pick<RendezvousRow, "id" | "giver_node_id" | "giver_gives_json" | "taker_node_id" | "taker_gives_json">[];
  const out: Busy = new Map();
  const add = (node: string | null, gives: string, id: number) => {
    if (node === null || (nodeId !== undefined && node !== nodeId)) return;
    for (const ref of itemRefsOf(JSON.parse(gives) as OfferItemWire[])) {
      const m = out.get(node) ?? new Map<string, number>();
      m.set(ref, id);
      out.set(node, m);
    }
  };
  for (const r of rows) {
    add(r.giver_node_id, r.giver_gives_json, r.id);
    add(r.taker_node_id, r.taker_gives_json, r.id);
  }
  return out;
}

/** The meeting under way in which `nodeId` hands over one of `items`, or null. */
function busyIn(busy: Busy, nodeId: string, items: OfferItemWire[]): number | null {
  const mine = busy.get(nodeId);
  if (!mine) return null;
  for (const ref of itemRefsOf(items)) {
    const id = mine.get(ref);
    if (id !== undefined) return id;
  }
  return null;
}

/** The meeting holding an offer: one under way in which its node hands over one of its items. Null: nothing holds it. */
export function offerHeldBy(db: Db, o: Pick<OfferRow, "node_id" | "give_json">, busy: Busy = busyItems(db, o.node_id)): number | null {
  return busyIn(busy, o.node_id, JSON.parse(o.give_json) as OfferItemWire[]);
}

/** The meeting under way in which `nodeId` already hands over one of `items` (a new meeting cannot count on them too), or null. */
export function itemsInMeeting(db: Db, nodeId: string, items: OfferItemWire[]): number | null {
  return busyIn(busyItems(db, nodeId), nodeId, items);
}

export const HELD_OFFER = "one of that offer's items is in another trade right now; try again once that is over";

/**
 * A side reported handing items over in a meeting: its node's other open
 * offers naming any of them are withdrawn (the item is gone), each with the
 * reason, and its owner hears which.
 */
function withdrawTradedAway(db: Db, rv: RendezvousRow, which: Which, now: number): void {
  const nodeId = which === "giver" ? rv.giver_node_id : rv.taker_node_id;
  if (nodeId === null) return;
  const gone = new Set(itemRefsOf(JSON.parse(which === "giver" ? rv.giver_gives_json : rv.taker_gives_json) as OfferItemWire[]));
  if (!gone.size) return;
  const open = db.prepare("SELECT * FROM offers WHERE node_id = ? AND status = 'open' AND id IS NOT ?").all(nodeId, rv.offer_id) as OfferRow[];
  const owner = (db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(nodeId) as { user_id: number } | undefined)?.user_id ?? null;
  for (const o of open) {
    const shared = (JSON.parse(o.give_json) as OfferItemWire[]).filter((g) => gone.has(g.ref));
    if (!shared.length) continue;
    const reason = `${describeItems(shared)} ${shared.length === 1 ? "was" : "were"} traded away in meeting #${rv.id}`;
    db.prepare("UPDATE offers SET status = 'cancelled', closed_reason = ?, updated_at = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(reason, now, now, o.id);
    emit(db, { users: [owner], kind: "offer-withdrawn", tone: "muted", href: "/me", text: `Offer #${o.id} withdrawn: ${reason}.` }, now);
  }
}

// --- offers -----------------------------------------------------------------

export function createOffer(db: Db, node: NodeRow, req: CreateOfferRequest, now = Date.now()): Result<{ offer: OfferWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const limits = limitsFor(db, node);
  if (limits.frozen) return refuse(409, "the hub operator has frozen this node");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  if (typeof req.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
  if (!knownServer(req.server)) return refuse(400, "server: one of the game's servers");
  if (req.clientKey !== undefined && (typeof req.clientKey !== "string" || !CLIENT_KEY_RE.test(req.clientKey))) return refuse(400, "clientKey: letters, digits, _ or -, 8..64");
  if (req.clientKey !== undefined) {
    // The same post again (the node never got the first reply): the offer it made, not a second one.
    const same = db.prepare("SELECT * FROM offers WHERE node_id = ? AND client_key = ?").get(node.id, req.clientKey) as OfferRow | undefined;
    if (same) return { ok: true, offer: offerWire(db, same, node.id) };
  }
  if (Array.isArray(req.give) && req.give.length > limits.maxItemsPerSide) return refuse(409, `give: at most ${limits.maxItemsPerSide} items, this node's biggest trade inventory`);
  const give = parseItems(req.give, limits.maxItemsPerSide, "give");
  if ("ok" in give) return give;
  const want = parseWant(req.want, limits.maxItemsPerSide);
  if ("ok" in want) return want;
  if (openOffersOf(db, node.id) >= limits.maxOpenOffers) return refuse(409, `at most ${limits.maxOpenOffers} open offers at once`);
  const r = db.prepare(`INSERT INTO offers (node_id, bot_ign, seasonal, server, give_json, want_json, status, created_at, updated_at, expires_at, client_key)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(node.id, req.botIgn, req.seasonal ? 1 : 0, req.server, JSON.stringify(give.items), JSON.stringify(want.want), now, now, now + OFFER_TTL_MS, req.clientKey ?? null);
  const row = db.prepare("SELECT * FROM offers WHERE id = ?").get(r.lastInsertRowid) as OfferRow;
  afterOfferPosted(db, row.id, now);
  return { ok: true, offer: offerWire(db, row, node.id) };
}

/** Every open offer, newest first, minus those of frozen or offline nodes and those held by a meeting. Also sweeps. */
export function listOpen(db: Db, forNode: NodeRow, now = Date.now()): { offers: OfferWire[]; limits: NodeLimitsWire } {
  sweepRendezvous(db, now);
  const rows = db.prepare(`SELECT o.*, u.display_name AS poster FROM offers o JOIN nodes n ON n.id = o.node_id JOIN users u ON u.id = n.user_id
    WHERE o.status = 'open' AND n.frozen = 0 AND n.last_seen_at >= ?
    ORDER BY o.created_at DESC, o.id DESC`).all(now - NODE_ONLINE_MS) as (OfferRow & { poster: string })[];
  const busy = busyItems(db);
  return { offers: rows.filter((o) => offerHeldBy(db, o, busy) === null).map((o) => offerWire(db, o, forNode.id, o.poster)), limits: limitsFor(db, forNode) };
}

/** The node's own offers, newest first; an open one a meeting holds says which. Also sweeps. */
export function listMine(db: Db, node: NodeRow, now = Date.now()): { offers: OfferWire[]; limits: NodeLimitsWire } {
  sweepRendezvous(db, now);
  const rows = db.prepare("SELECT * FROM offers WHERE node_id = ? ORDER BY created_at DESC, id DESC").all(node.id) as OfferRow[];
  const busy = busyItems(db, node.id);
  return { offers: rows.map((o) => offerWire(db, o, node.id, undefined, o.status === "open" ? offerHeldBy(db, o, busy) : null)), limits: limitsFor(db, node) };
}

/** Another fourteen days for an offer of the caller's: an open one keeps going, an expired one is open again (within the open-offer limit). */
export function renewOffer(db: Db, node: NodeRow, offerId: number, now = Date.now()): Result<{ offer: OfferWire }> {
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow | undefined;
  if (!o || o.node_id !== node.id) return refuse(404, "no such offer");
  if (o.status !== "open" && o.status !== "expired") return refuse(409, `offer is ${o.status}`);
  const limits = limitsFor(db, node);
  if (limits.frozen) return refuse(409, "the hub operator has frozen this node");
  if (o.status === "expired" && openOffersOf(db, node.id) >= limits.maxOpenOffers) return refuse(409, `at most ${limits.maxOpenOffers} open offers at once`);
  db.prepare("UPDATE offers SET status = 'open', expires_at = ?, closed_at = NULL, updated_at = ? WHERE id = ?").run(now + OFFER_TTL_MS, now, offerId);
  return { ok: true, offer: offerWire(db, db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow, node.id) };
}

export function cancelOffer(db: Db, node: NodeRow, offerId: number, now = Date.now()): Result<Record<never, never>> {
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow | undefined;
  if (!o || o.node_id !== node.id) return refuse(404, "no such offer");
  if (o.status !== "open") return refuse(409, `offer is ${o.status}`);
  db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ?, closed_at = ? WHERE id = ?").run(now, now, offerId);
  return { ok: true };
}

export function acceptOffer(db: Db, taker: NodeRow, offerId: number, req: AcceptOfferRequest, now = Date.now()): Result<{ rendezvous: RendezvousWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const limits = limitsFor(db, taker);
  if (limits.frozen) return refuse(409, "the hub operator has frozen this node");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  if (req.server !== undefined && !knownServer(req.server)) return refuse(400, "server: one of the game's servers");
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow | undefined;
  if (!o) return refuse(404, "no such offer");
  if (o.node_id === taker.id) return refuse(409, "that is your own offer");
  // The taker may move the meeting when the poster's server is closed or busy on its node.
  const server = req.server ?? o.server;
  const poster = db.prepare("SELECT frozen, last_seen_at FROM nodes WHERE id = ?").get(o.node_id) as { frozen: number; last_seen_at: number | null } | undefined;
  if (o.status !== "open" || o.expires_at <= now || !poster || poster.frozen) return refuse(409, "offer is no longer open");
  if (poster.last_seen_at === null || poster.last_seen_at < now - NODE_ONLINE_MS) return refuse(409, "that offer's node is offline right now");
  if (offerHeldBy(db, o) !== null) return refuse(409, HELD_OFFER);
  const want = JSON.parse(o.want_json) as WantLineWire[];
  const give = JSON.parse(o.give_json) as OfferItemWire[];
  const expected = want.flatMap((w) => Array.from({ length: w.qty }, () => w.itemId));
  if (expected.length > limits.maxItemsPerSide || give.length > limits.maxItemsPerSide) return refuse(409, `this offer has more items on a side than your biggest trade inventory (${limits.maxItemsPerSide})`);
  // The taker's bot is one its heartbeat lists, of the offer's side: a seasonal character cannot trade a non-seasonal one.
  const bot = db.prepare("SELECT seasonal FROM node_bots WHERE node_id = ? AND lower(ign) = lower(?)").get(taker.id, req.botIgn) as { seasonal: number } | undefined;
  if (!bot) return refuse(409, `${req.botIgn} is not one of this node's accounts (as its last heartbeat listed them)`);
  if (!!bot.seasonal !== !!o.seasonal) return refuse(409, `${req.botIgn} is ${bot.seasonal ? "seasonal" : "non-seasonal"} and this offer is ${o.seasonal ? "seasonal" : "non-seasonal"}`);
  // Offers taken at once: one per bot it can have online (its self-report), and never more than the accounts of that side it lists.
  const maxTakes = limits.maxTakes ?? 1;
  if (activeTakes(db, taker.id) >= maxTakes) return refuse(409, `at most ${maxTakes} offer${maxTakes === 1 ? "" : "s"} taken at a time, one per bot this node can have online`);
  const sideBots = (db.prepare("SELECT COUNT(*) AS n FROM node_bots WHERE node_id = ? AND seasonal = ?").get(taker.id, o.seasonal) as { n: number }).n;
  const sideTakes = (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE taker_node_id = ? AND state = 'meet' AND kind = 'swap' AND seasonal = ?").get(taker.id, o.seasonal) as { n: number }).n;
  if (sideTakes >= sideBots) return refuse(409, `at most ${sideBots} ${o.seasonal ? "seasonal" : "non-seasonal"} offer${sideBots === 1 ? "" : "s"} taken at a time, one per account of that side this node has`);
  const items = parseItems(req.items, expected.length, "items");
  if ("ok" in items) return items;
  if (items.items.length !== expected.length) return refuse(400, `items: the offer wants ${expected.length} items, got ${items.items.length}`);
  for (let i = 0; i < expected.length; i++) if (items.items[i].itemId !== expected[i]) return refuse(400, `items[${i}]: want line asks for ${expected[i]}, got ${items.items[i].itemId}`);
  if (itemsInMeeting(db, taker.id, items.items) !== null) return refuse(409, "one of the items you would give is in another trade of yours right now");
  const rvId = db.transaction(() => {
    const u = db.prepare("UPDATE offers SET status = 'accepted', taker_node_id = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(taker.id, now, offerId);
    if (!u.changes) return null;
    const r = db.prepare(`INSERT INTO rendezvous (offer_id, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json)
      VALUES (?, ?, ?, 'meet', ?, ?, ?, ?, ?, ?, ?, ?)`).run(offerId, server, o.seasonal, now, now + RENDEZVOUS_MS, o.node_id, o.bot_ign, o.give_json, taker.id, req.botIgn, JSON.stringify(items.items));
    return Number(r.lastInsertRowid);
  })();
  if (rvId === null) return refuse(409, "offer is no longer open");
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(rvId) as RendezvousRow;
  const p = partiesOf(db, rv);
  const posterName = posterOf(db, o.node_id);
  const takerName = posterOf(db, taker.id);
  const moved = server !== o.server ? ` (moved from ${o.server}: the taker's node cannot trade there right now)` : "";
  emit(db, { users: [p.giver], kind: "meeting", tone: "accent", notify: true, href: "/me",
    text: `${takerName} accepted your offer: ${describeItems(give)} for ${describeItems(items.items)}. Meeting on ${server}${moved} now; your bot ${o.bot_ign} meets ${req.botIgn} ${MEETING_WITHIN}.` }, now);
  emit(db, { users: [p.taker], kind: "meeting", tone: "accent", notify: true, href: "/me",
    text: `You accepted ${posterName}'s offer: ${describeItems(items.items)} for ${describeItems(give)}. Meeting on ${server}${moved} now; your bot ${req.botIgn} meets ${o.bot_ign} ${MEETING_WITHIN}.` }, now);
  return { ok: true, rendezvous: rendezvousWire(db, rv, taker.id) };
}

// --- rendezvous -------------------------------------------------------------
//
// How a meeting between two nodes ends (2026-09-28). A trade in the game is
// one action: both sides accept and Realm swaps everything at once, and each
// bot checks the other side's window before it accepts. So each node's own
// word settles its own side, and nothing its partner says can touch it: the
// poster's offer closes on the poster's own "traded" and reopens on its own
// "did not trade", its giving up, or its silence at the deadline; a communism
// item's listing goes on its holder's own "traded"; a give's room comes back
// when the receiver says nothing arrived. The meeting as a whole is `done`
// once a side reports the trade and the other does not contradict it, and
// `disputed` when the two contradict each other: a record for both owners and
// the operator that freezes nobody. Completed swaps (they raise the offer
// limits) and attestations count only when both receipts agree, so a node
// lying on its own gains nothing. Freezing a node is the operator's call.

export function rendezvousFor(db: Db, node: NodeRow, now = Date.now()): RendezvousWire[] {
  sweepRendezvous(db, now);
  const rows = db.prepare(`SELECT * FROM (
      SELECT * FROM rendezvous WHERE (giver_node_id = ? OR taker_node_id = ?) AND state = 'meet'
      UNION ALL
      SELECT * FROM (SELECT * FROM rendezvous WHERE (giver_node_id = ? OR taker_node_id = ?) AND state != 'meet' ORDER BY closed_at DESC, id DESC LIMIT ?)
    ) ORDER BY (state = 'meet') DESC, created_at DESC, id DESC`).all(node.id, node.id, node.id, node.id, FINISHED_KEEP) as RendezvousRow[];
  return rows.map((rv) => rendezvousWire(db, rv, node.id));
}

/** The rendezvous `node` takes part in, and the other node (null for a player meeting, whose other side is a person). */
function partyOf(db: Db, node: NodeRow, rendezvousId: number): { rv: RendezvousRow; partnerId: string | null } | Refusal {
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(rendezvousId) as RendezvousRow | undefined;
  if (!rv || (rv.giver_node_id !== node.id && rv.taker_node_id !== node.id)) return refuse(404, "no such rendezvous");
  return { rv, partnerId: rv.giver_node_id === node.id ? rv.taker_node_id : rv.giver_node_id };
}

const rendezvousRow = (db: Db, id: number): RendezvousRow => db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(id) as RendezvousRow;

/** One side of a two-node meeting by its own node's word: its receipt, else its giving up; null while it has said nothing. */
type Side = "traded" | "not-traded" | "gave-up" | null;
type Which = "giver" | "taker";

function sideOf(db: Db, rv: RendezvousRow, which: Which): Side {
  const nodeId = which === "giver" ? rv.giver_node_id : rv.taker_node_id;
  if (nodeId === null) return null;
  const receipts = db.prepare("SELECT ok FROM receipts WHERE rendezvous_id = ? AND node_id = ?").all(rv.id, nodeId) as { ok: number }[];
  if (receipts.some((r) => r.ok)) return "traded";
  if (receipts.length) return "not-traded";
  return (which === "giver" ? rv.giver_gave_up_at : rv.taker_gave_up_at) !== null ? "gave-up" : null;
}

/** Whose side that is, as people read it: the node's owner. */
const sideName = (db: Db, rv: RendezvousRow, which: Which): string => (which === "giver" ? posterOf(db, rv.giver_node_id) : takerName(db, rv));

/** The poster's bot did not trade: its offer is open again, unless a newer meeting has taken it since. */
function reopenOffer(db: Db, rv: RendezvousRow, now: number): void {
  if (rv.offer_id === null) return;
  db.prepare("UPDATE offers SET status = 'open', taker_node_id = NULL, updated_at = ? WHERE id = ? AND status = 'accepted' AND NOT EXISTS (SELECT 1 FROM rendezvous r WHERE r.offer_id = offers.id AND r.id > ?)").run(now, rv.offer_id, rv.id);
}

/** The poster's bot traded: its offer is done. Reopened and taken by a newer meeting meanwhile, its items are gone: that meeting will fail, and both sides of this one hear so. */
function closeOfferDone(db: Db, rv: RendezvousRow, now: number): void {
  if (rv.offer_id === null) return;
  const newer = db.prepare("SELECT id FROM rendezvous WHERE offer_id = ? AND state = 'meet' AND id > ?").get(rv.offer_id, rv.id) as { id: number } | undefined;
  if (newer) {
    tell(db, rv, { kind: "meeting-warning", tone: "bad", notify: true, text: `Offer #${rv.offer_id} was taken again after meeting #${rv.id} had been closed, but that first trade did happen: its items are gone. Meeting #${newer.id} will fail; check the bots.` }, now);
    return;
  }
  db.prepare("UPDATE offers SET status = 'done', updated_at = ?, closed_at = ? WHERE id = ? AND status IN ('accepted', 'open', 'void')").run(now, now, rv.offer_id);
}

function close(db: Db, rv: RendezvousRow, state: RendezvousState, reason: string | null, now: number, from: RendezvousState[] = ["meet"]): void {
  db.prepare(`UPDATE rendezvous SET state = ?, reason = ?, closed_at = ? WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`).run(state, reason, now, rv.id, ...from);
  if (rv.kind === "communism" && rv.communism_ref) {
    const item = db.prepare("SELECT node_id, bot_ign, item_id, enchants_json, seasonal FROM communism_items WHERE node_id = ? AND ref = ?").get(rv.communism_node_id, rv.communism_ref) as { node_id: string; bot_ign: string; item_id: string; enchants_json: string; seasonal: number } | undefined;
    if (item) recordChange([{ key: stackKey(item), seasonal: !!item.seasonal }]);
  }
}

/** A swap's offer reopens; a communism item is simply no longer in a `meet` rendezvous, which is what listed it out. */
function what(rv: RendezvousRow): string {
  if (rv.kind === "player") {
    const back = JSON.parse(rv.taker_gives_json) as OfferItemWire[];
    return `the trade of ${describeItems(JSON.parse(rv.giver_gives_json) as OfferItemWire[])}${back.length ? ` for ${describeItems(back)}` : ""} with ${rv.taker_bot_ign}`;
  }
  return rv.kind === "communism" ? `the hand-over of ${describeItems(JSON.parse(rv.giver_gives_json) as OfferItemWire[])}` : `the swap of ${describeItems(JSON.parse(rv.giver_gives_json) as OfferItemWire[])} for ${describeItems(JSON.parse(rv.taker_gives_json) as OfferItemWire[])}`;
}
export function tell(db: Db, rv: RendezvousRow, e: { kind: string; tone: "good" | "bad" | "muted" | "accent"; text: string; notify?: boolean }, now: number): void {
  const p = partiesOf(db, rv);
  emit(db, { users: [p.giver, p.taker], href: rv.kind === "communism" ? "/communism" : rv.kind === "player" ? `/meetings/${rv.id}` : "/me", ...e }, now);
}

/** A player meeting that did not happen (players.ts): the offer reopens. */
export function fail(db: Db, rv: RendezvousRow, state: "failed" | "aborted", reason: string, now: number): void {
  close(db, rv, state, reason, now);
  reopenOffer(db, rv, now);
  tell(db, rv, { kind: `meeting-${state}`, tone: "muted", notify: true, text: state === "aborted" ? `Meeting #${rv.id} on ${rv.server} was called off (${reason}); ${what(rv)} did not happen${rv.offer_id !== null ? " and the offer is open again" : ""}.` : `Meeting #${rv.id} on ${rv.server} did not happen (${reason})${rv.offer_id !== null ? "; the offer is open again" : ""}.` }, now);
}

/**
 * A side's word (`after`; null: it said nothing by the time the meeting
 * ended), and what that settles on that side alone: the poster's offer, a
 * taken item's listing, a give's room on the receiving account, and the
 * side's other offers naming what it traded away. `late`: the meeting had
 * already ended, and what its end settled for a silent side stands.
 */
function sideEffects(db: Db, rv: RendezvousRow, which: Which, after: Side, now: number, late: boolean): void {
  const traded = after === "traded";
  if (traded) withdrawTradedAway(db, rv, which, now);
  if (rv.kind === "swap") {
    if (which !== "giver") return;
    if (traded) closeOfferDone(db, rv, now);
    else reopenOffer(db, rv, now);
  } else if (rv.kind === "communism") {
    if (rv.communism_ref !== null) {
      // A take: the item left the holder's bot, by the holder's own word. Its listing goes now rather than at the next publish.
      if (which !== "giver" || !traded) return;
      const item = db.prepare("SELECT node_id, bot_ign, item_id, enchants_json, seasonal FROM communism_items WHERE node_id = ? AND ref = ?").get(rv.communism_node_id, rv.communism_ref) as { node_id: string; bot_ign: string; item_id: string; enchants_json: string; seasonal: number } | undefined;
      if (!item) return;
      db.prepare("DELETE FROM communism_items WHERE node_id = ? AND ref = ?").run(rv.communism_node_id, rv.communism_ref);
      recordChange([{ key: stackKey(item), seasonal: !!item.seasonal }]);
    }
    // A give's room on the receiving account is counted only while its meeting is under way (requests.ts EFFECTIVE_FREE): nothing to give back here.
  }
}

/** Both sides' "traded" receipts, and whether they tell of the same trade (a one-way hand-over: the taker gave nothing). */
function agreement(db: Db, rv: RendezvousRow): { giver: ReceiptRow; taker: ReceiptRow; counts: boolean; agree: boolean } | null {
  const ok = (nodeId: string | null) => (nodeId === null ? undefined : (db.prepare("SELECT * FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND ok = 1 ORDER BY window LIMIT 1").get(rv.id, nodeId) as ReceiptRow | undefined));
  const giver = ok(rv.giver_node_id), taker = ok(rv.taker_node_id);
  if (!giver || !taker) return null;
  const counts = receiptsAgree(giver, taker);
  return { giver, taker, counts, agree: counts && (rv.kind !== "communism" || canon(JSON.parse(taker.gave_json)) === canon([])) };
}

/** How the meeting stands on both sides' word: null while it is still under way. `note`: the reason the latest word gave (a failure's error, a give-up's why). */
function verdict(db: Db, rv: RendezvousRow, now: number, note: string | null): { state: RendezvousState; reason: string | null } | null {
  const g = sideOf(db, rv, "giver"), t = sideOf(db, rv, "taker");
  const over = rv.state !== "meet" || now >= rv.deadline_at;
  if (g === "traded" && t === "traded") {
    const a = agreement(db, rv)!;
    if (a.agree) return { state: "done", reason: null };
    return { state: "disputed", reason: a.counts ? "the taker handed something over in a one-way hand-over" : "the two receipts disagree on what changed hands" };
  }
  if (g === "traded" || t === "traded") {
    const [us, them, other] = g === "traded" ? ["giver", "taker", t] as const : ["taker", "giver", g] as const;
    const who = sideName(db, rv, us), whom = sideName(db, rv, them);
    if (other === "not-traded") return { state: "disputed", reason: `${who}'s node reports the trade happened, ${whom}'s that it did not` };
    if (other === "gave-up") return { state: "done", reason: `${who}'s node reported the trade; ${whom}'s gave up without confirming it` };
    return over ? { state: "done", reason: `${who}'s node reported the trade; ${whom}'s sent nothing by the deadline` } : null;
  }
  // Nobody traded. One side saying so ends it: its bot has stopped, so the trade cannot happen now.
  if (g === "gave-up" || t === "gave-up") return { state: "aborted", reason: note ?? rv.reason ?? "aborted" };
  if (g === "not-traded" || t === "not-traded") return { state: "failed", reason: note ?? rv.reason ?? "reported failed" };
  return over ? { state: "failed", reason: "deadline passed" } : null;
}

/** Both receipts agree: the swap counts (completed swaps raise the offer limits) and each side's window attests the other's bot. Once. */
function countAgreement(db: Db, rv: RendezvousRow, now: number): boolean {
  const a = agreement(db, rv);
  if (!a?.agree || db.prepare("UPDATE rendezvous SET counted = 1 WHERE id = ? AND counted = 0").run(rv.id).changes === 0) return false;
  if (rv.kind === "swap") db.prepare("UPDATE nodes SET completed_swaps = completed_swaps + 1 WHERE id IN (?, ?)").run(rv.giver_node_id, rv.taker_node_id);
  const att = db.prepare("INSERT OR IGNORE INTO attestations (node_id, bot_ign, by_node_id, at) VALUES (?, ?, ?, ?)");
  att.run(rv.taker_node_id, a.giver.partner_ign, rv.giver_node_id, now);
  att.run(rv.giver_node_id, a.taker.partner_ign, rv.taker_node_id, now);
  return true;
}

const sentence = (s: string | null): string => (s ? `${s[0].toUpperCase()}${s.slice(1)}.` : "");

/** Both owners hear how a meeting ended; `late`: a word that came after it had closed changed that. */
function tellEnd(db: Db, rv: RendezvousRow, counted: boolean, late: boolean, now: number): void {
  const head = `${late ? "Done after all" : "Done"}: ${what(rv)} on ${rv.server}`;
  if (rv.state === "done") tell(db, rv, { kind: "meeting-done", tone: "good", notify: true, text: counted ? `${head}, both receipts matched.` : `${head}. ${sentence(rv.reason)}` }, now);
  else if (rv.state === "disputed") tell(db, rv, { kind: "meeting-disputed", tone: "bad", notify: true, text: `Meeting #${rv.id} on ${rv.server}: the two sides disagree (${rv.reason}). Each side's own report settled its own side, and nobody is frozen; the operator can see both receipts.` }, now);
  else tell(db, rv, { kind: `meeting-${rv.state}`, tone: "muted", notify: true, text: rv.state === "aborted" ? `Meeting #${rv.id} on ${rv.server} was called off (${rv.reason}); ${what(rv)} did not happen${rv.offer_id !== null ? " and the offer is open again" : ""}.` : `Meeting #${rv.id} on ${rv.server} did not happen (${rv.reason})${rv.offer_id !== null ? "; the offer is open again" : ""}.` }, now);
}

/**
 * Where a two-node meeting stands after a side's word or its deadline:
 * still under way, or over with the state both sides' words give. Ending it
 * settles each silent side too. A meeting already over moves only when a late
 * word changes its outcome; both receipts agreeing counts it, then or later.
 */
function settle(db: Db, rv: RendezvousRow, now: number, note: string | null = null): void {
  const v = verdict(db, rv, now, note);
  if (rv.state === "meet") {
    if (!v) return;
    close(db, rv, v.state, v.reason, now);
    for (const which of ["giver", "taker"] as const) if (sideOf(db, rv, which) === null) sideEffects(db, rv, which, null, now, false);
    const counted = countAgreement(db, rv, now);
    tellEnd(db, rendezvousRow(db, rv.id), counted, false, now);
    return;
  }
  if (v && v.state !== rv.state) {
    db.prepare("UPDATE rendezvous SET state = ?, reason = ?, closed_at = ? WHERE id = ?").run(v.state, `${v.reason ?? "both receipts agree"} (late: was ${rv.state}${rv.reason ? `: ${rv.reason}` : ""})`, now, rv.id);
    const counted = countAgreement(db, rv, now);
    tellEnd(db, rendezvousRow(db, rv.id), counted, true, now);
  } else if (countAgreement(db, rv, now)) {
    db.prepare("UPDATE rendezvous SET reason = ? WHERE id = ?").run(`both receipts agree (late: ${rv.reason ?? "one side had reported"})`, rv.id);
    tell(db, rv, { kind: "meeting-done", tone: "good", text: `Meeting #${rv.id} on ${rv.server}: both receipts agree now, and the ${rv.kind === "swap" ? "swap" : "hand-over"} counts.` }, now);
  }
}

/**
 * A player meeting the node's receipt says happened: done, the offer closed,
 * the node's player-trade count up (not its completed swaps: those drive the
 * offer limits and need two nodes to agree), and the IGN the trade window
 * showed recorded against the person. What they put up is kept from the
 * receipt, for the history.
 */
function completePlayer(db: Db, rv: RendezvousRow, receipt: ReceiptRow, now: number): void {
  const late = rv.state !== "meet";
  const got = receipt.got_items_json ? (JSON.parse(receipt.got_items_json) as ItemDetail[]) : (JSON.parse(receipt.got_json) as Qty[]).flatMap((q) => Array.from({ length: q.qty }, () => ({ itemId: q.itemId, enchants: null, count: 0 })));
  db.prepare("UPDATE rendezvous SET taker_gives_json = ? WHERE id = ?").run(JSON.stringify(got.map((d, i) => ({ ref: `p${i + 1}`, itemId: d.itemId, enchants: d.enchants, count: d.count }))), rv.id);
  const seen = receipt.partner_ign;
  const other = seen && seen.toLowerCase() !== rv.taker_bot_ign.toLowerCase() ? `the trade window showed ${seen}, not ${rv.taker_bot_ign}` : null;
  close(db, rv, "done", [late ? `completed late: the node reports the trade happened (was ${rv.state}${rv.reason ? `: ${rv.reason}` : ""})` : null, other].filter(Boolean).join("; ") || null, now, ["meet", "failed", "aborted"]);
  const fresh = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(rv.id) as RendezvousRow;
  db.prepare("UPDATE nodes SET completed_player_trades = completed_player_trades + 1 WHERE id = ?").run(rv.giver_node_id);
  if (rv.taker_user_id !== null) db.prepare("INSERT OR IGNORE INTO ign_sightings (user_id, ign, node_id, at) VALUES (?, ?, ?, ?)").run(rv.taker_user_id, seen || rv.taker_bot_ign, rv.giver_node_id, now);
  db.prepare("UPDATE rendezvous SET counted = 1 WHERE id = ?").run(rv.id);
  closeOfferDone(db, fresh, now);
  withdrawTradedAway(db, fresh, "giver", now);
  tell(db, fresh, { kind: "meeting-done", tone: "good", notify: true, text: `Done: ${what(fresh)} on ${rv.server}.${late ? " The meeting had been closed, but the node reports the trade went through." : ""}` }, now);
}

/** A player meeting the node's receipt says did not happen: the offer reopens; a person who never came counts a no-show. */
function failPlayer(db: Db, rv: RendezvousRow, reason: string, noShow: boolean, now: number): void {
  if (noShow) db.prepare("UPDATE rendezvous SET no_show = 1 WHERE id = ?").run(rv.id);
  fail(db, rv, "failed", reason, now);
}

function parseReceipt(raw: unknown): { r: ReceiptWire } | Refusal {
  if (!raw || typeof raw !== "object") return refuse(400, "bad json");
  const r = raw as Partial<ReceiptWire>;
  if (!isInt(r.window, 0, 1_000_000)) return refuse(400, "window must be a non-negative integer");
  if (typeof r.ok !== "boolean") return refuse(400, "ok must be a boolean");
  const gave = parseQtys(r.gave, "gave");
  if ("ok" in gave) return gave;
  const got = parseQtys(r.got, "got");
  if ("ok" in got) return got;
  if (!Array.isArray(r.gaveRefs) || r.gaveRefs.length > 64 || !r.gaveRefs.every((x) => typeof x === "string" && REF_RE.test(x))) return refuse(400, "gaveRefs: list of refs");
  if (typeof r.partnerIgn !== "string" || (r.partnerIgn !== "" && !IGN_RE.test(r.partnerIgn))) return refuse(400, "partnerIgn: letters only, 1..32");
  if (r.error !== undefined && typeof r.error !== "string") return refuse(400, "error must be a string");
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return refuse(400, "at must be a timestamp");
  const gaveItems = parseDetails(r.gaveItems, "gaveItems");
  if ("ok" in gaveItems) return gaveItems;
  const gotItems = parseDetails(r.gotItems, "gotItems");
  if ("ok" in gotItems) return gotItems;
  if (r.partnerAbsent !== undefined && typeof r.partnerAbsent !== "boolean") return refuse(400, "partnerAbsent must be a boolean");
  return { r: { window: r.window, ok: r.ok, gave: gave.list, gaveRefs: [...r.gaveRefs], got: got.list, ...(gaveItems.list ? { gaveItems: gaveItems.list } : {}), ...(gotItems.list ? { gotItems: gotItems.list } : {}), partnerIgn: r.partnerIgn, error: r.error === undefined ? undefined : r.error.slice(0, 200), ...(r.partnerAbsent ? { partnerAbsent: true } : {}), at: Math.round(r.at) } };
}

export function submitReceipt(db: Db, node: NodeRow, rendezvousId: number, raw: unknown, now = Date.now()): Result<{ state: RendezvousState }> {
  const p = partyOf(db, node, rendezvousId);
  if ("ok" in p) return p;
  const parsed = parseReceipt(raw);
  if ("ok" in parsed) return parsed;
  const { rv } = p;
  const rc = parsed.r;
  const state = db.transaction((): RendezvousState => {
    const which: Which = rv.giver_node_id === node.id ? "giver" : "taker";
    const before = rv.kind === "player" ? null : sideOf(db, rv, which);
    // The same node's receipt for the same window is taken once; a node re-sending it (the hub was unreachable) changes nothing.
    const inserted = db.prepare(`INSERT OR IGNORE INTO receipts (rendezvous_id, node_id, window, ok, gave_json, gave_refs_json, got_json, gave_items_json, got_items_json, partner_ign, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rv.id, node.id, rc.window, rc.ok ? 1 : 0, JSON.stringify(rc.gave), JSON.stringify(rc.gaveRefs), JSON.stringify(rc.got), rc.gaveItems ? JSON.stringify(rc.gaveItems) : null, rc.gotItems ? JSON.stringify(rc.gotItems) : null, rc.partnerIgn, rc.error ?? null, rc.at).changes > 0;
    const mine = db.prepare("SELECT * FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND window = ?").get(rv.id, node.id, rc.window) as ReceiptRow;
    if (rv.kind === "player") {
      // One witness: the node. Its receipt closes the meeting (a success after the hub had closed it still happened: the items moved).
      if (rv.state === "meet") {
        if (mine.ok) completePlayer(db, rv, mine, now);
        else failPlayer(db, rv, mine.error || "the trade did not happen", rc.partnerAbsent === true, now);
      } else if ((rv.state === "failed" || rv.state === "aborted") && mine.ok && inserted) completePlayer(db, rv, mine, now);
      return rendezvousRow(db, rv.id).state;
    }
    // Two nodes: this receipt settles this side; the meeting then stands on both sides' word.
    const fresh = rendezvousRow(db, rv.id);
    const after = sideOf(db, fresh, which);
    if (after !== before) sideEffects(db, fresh, which, after, now, fresh.state !== "meet");
    settle(db, fresh, now, mine.ok ? null : mine.error || "reported failed");
    return rendezvousRow(db, rv.id).state;
  })();
  return { ok: true, state };
}

/**
 * More time for a meeting still under way: a node whose bot is logging in,
 * queueing for the server or waiting for the partner asks before the
 * deadline. Ten minutes per ask, never past an hour from the start.
 */
export function extendRendezvous(db: Db, node: NodeRow, rendezvousId: number, reason: unknown, now = Date.now()): Result<{ deadlineAt: number }> {
  const p = partyOf(db, node, rendezvousId);
  if ("ok" in p) return p;
  const { rv } = p;
  if (rv.state !== "meet") return refuse(409, `rendezvous is ${rv.state}`);
  const cap = rv.created_at + RENDEZVOUS_MAX_MS;
  const next = Math.min(Math.max(rv.deadline_at, now) + RENDEZVOUS_EXTEND_MS, cap);
  if (next <= rv.deadline_at) return refuse(409, "the meeting has had all the time it can have");
  db.prepare("UPDATE rendezvous SET deadline_at = ? WHERE id = ? AND state = 'meet'").run(next, rv.id);
  const why = (typeof reason === "string" ? reason : "").slice(0, 200);
  tell(db, rv, { kind: "meeting-extended", tone: "muted", text: `Meeting #${rv.id} on ${rv.server} has until ${new Date(next).toISOString().slice(11, 16)} UTC now${why ? ` (${why})` : ""}.` }, now);
  return { ok: true, deadlineAt: next };
}

/**
 * A node gives its side of a meeting up (its bot will not log in, the server
 * is full). That settles its side as not traded, like a failure receipt, but
 * says nothing about the trade: with nobody having traded the meeting ends at
 * once (`aborted`), and a partner that already reported the trade keeps it
 * (`done`). A side that has reported cannot give up afterwards.
 */
export function abortRendezvous(db: Db, node: NodeRow, rendezvousId: number, reason: unknown, now = Date.now()): Result<{ state: RendezvousState }> {
  const p = partyOf(db, node, rendezvousId);
  if ("ok" in p) return p;
  const { rv, partnerId } = p;
  if (rv.state !== "meet") return refuse(409, `rendezvous is ${rv.state}`);
  const why = (typeof reason === "string" ? reason : "").slice(0, 200) || "aborted";
  // A player meeting has no partner node: the node calling it off ends it.
  if (partnerId === null) {
    fail(db, rv, "aborted", why, now);
    return { ok: true, state: "aborted" };
  }
  const which: Which = rv.giver_node_id === node.id ? "giver" : "taker";
  if (sideOf(db, rv, which) !== null) return refuse(409, "this node already reported on the meeting");
  db.transaction(() => giveUp(db, rv, which, why, now))();
  return { ok: true, state: rendezvousRow(db, rv.id).state };
}

function giveUp(db: Db, rv: RendezvousRow, which: Which, why: string, now: number): void {
  db.prepare(`UPDATE rendezvous SET ${which}_gave_up_at = ? WHERE id = ?`).run(now, rv.id);
  const fresh = rendezvousRow(db, rv.id);
  sideEffects(db, fresh, which, "gave-up", now, false);
  settle(db, fresh, now, why);
}

/**
 * A node that is going away (unlinked): every meeting under way it is in ends
 * on its side as if it had given up, where it had not said anything yet; a
 * player meeting of its is called off. What it already reported stands.
 */
export function giveUpMeetingsOf(db: Db, nodeId: string, why: string, now = Date.now()): void {
  const rows = db.prepare("SELECT * FROM rendezvous WHERE state = 'meet' AND (giver_node_id = ? OR taker_node_id = ?)").all(nodeId, nodeId) as RendezvousRow[];
  for (const rv of rows) {
    if (rv.kind === "player") {
      fail(db, rv, "aborted", why, now);
      continue;
    }
    const which: Which = rv.giver_node_id === nodeId ? "giver" : "taker";
    if (sideOf(db, rv, which) === null) giveUp(db, rv, which, why, now);
  }
}

/** Deadlines and expiries. Cheap; called from the list routes. */
export function sweepRendezvous(db: Db, now = Date.now()): void {
  const due = db.prepare("SELECT * FROM rendezvous WHERE state = 'meet' AND deadline_at <= ?").all(now) as RendezvousRow[];
  db.transaction(() => {
    for (const rv of due) {
      if (rv.kind === "player") fail(db, rv, "failed", "deadline passed with no word from the node", now);
      else settle(db, rv, now);
    }
    db.prepare("UPDATE offers SET status = 'expired', updated_at = ?, closed_at = ? WHERE status = 'open' AND expires_at <= ?").run(now, now, now);
  })();
}

/** A meeting as the website shows it to someone with a stake in it. */
export interface MeetingView {
  id: number;
  kind: RendezvousKind;
  state: RendezvousState;
  server: string;
  seasonal: boolean;
  createdAt: number;
  deadlineAt: number;
  closedAt: number | null;
  reason: string | null;
  giver: { name: string; botIgn: string; gives: Qty[]; mine: boolean };
  /** `player`: the taker is a person with their own character; `gives` is what the offer asks of them until the trade shows what they put up. */
  taker: { name: string; botIgn: string; gives: Qty[]; mine: boolean; player: boolean };
  reported: { giver: boolean; taker: boolean };
  /** A player meeting: the node's latest word on it. */
  progress: MeetingProgressWire | null;
}

export function meetingView(db: Db, rv: RendezvousRow, userId: number): MeetingView {
  const p = partiesOf(db, rv);
  const reported = db.prepare("SELECT DISTINCT node_id FROM receipts WHERE rendezvous_id = ?").all(rv.id) as { node_id: string }[];
  const player = rv.kind === "player";
  const takerGives = player && rv.state !== "done" ? collapseQty(offerWant(db, rv.offer_id).map((l) => ({ itemId: l.itemId, qty: l.qty }))) : collapse(JSON.parse(rv.taker_gives_json) as OfferItemWire[]);
  return {
    id: rv.id, kind: rv.kind, state: rv.state, server: rv.server, seasonal: !!rv.seasonal, createdAt: rv.created_at, deadlineAt: rv.deadline_at, closedAt: rv.closed_at, reason: rv.reason,
    giver: { name: posterOf(db, rv.giver_node_id), botIgn: rv.giver_bot_ign, gives: collapse(JSON.parse(rv.giver_gives_json) as OfferItemWire[]), mine: p.giver === userId },
    taker: { name: takerName(db, rv), botIgn: rv.taker_bot_ign, gives: takerGives, mine: p.taker === userId, player },
    reported: { giver: reported.some((r) => r.node_id === rv.giver_node_id), taker: rv.taker_node_id !== null && reported.some((r) => r.node_id === rv.taker_node_id) },
    progress: rv.progress_json ? (JSON.parse(rv.progress_json) as MeetingProgressWire) : null,
  };
}

/** Meetings under way for any of a person's nodes or with them as the player, then the last few finished ones. Also sweeps. */
export function meetingsFor(db: Db, userId: number, finished = 10, now = Date.now()): MeetingView[] {
  sweepRendezvous(db, now);
  const rows = db.prepare(`SELECT r.* FROM rendezvous r
      JOIN nodes g ON g.id = r.giver_node_id LEFT JOIN nodes t ON t.id = r.taker_node_id
      WHERE g.user_id = ? OR t.user_id = ? OR r.taker_user_id = ?
      ORDER BY (r.state = 'meet') DESC, COALESCE(r.closed_at, r.created_at) DESC, r.id DESC LIMIT 200`).all(userId, userId, userId) as RendezvousRow[];
  const out: MeetingView[] = [];
  let done = 0;
  for (const rv of rows) {
    if (rv.state !== "meet" && done++ >= finished) break;
    out.push(meetingView(db, rv, userId));
  }
  return out;
}

// --- operator view ----------------------------------------------------------

export interface DisputeRow extends RendezvousRow {
  giver_name: string;
  taker_name: string;
}
export interface FrozenNode {
  id: string;
  name: string;
  owner: string;
  frozen_reason: string | null;
}

export function operatorView(db: Db): { swaps: number; playerTrades: number; disputed: DisputeRow[]; frozen: FrozenNode[]; reports: DisputeRow[]; disputesByNode: Map<string, number> } {
  const withNames = `SELECT r.*, gu.display_name AS giver_name, COALESCE(tu.display_name, pu.display_name, '?') AS taker_name FROM rendezvous r
      JOIN nodes g ON g.id = r.giver_node_id JOIN users gu ON gu.id = g.user_id
      LEFT JOIN nodes t ON t.id = r.taker_node_id LEFT JOIN users tu ON tu.id = t.user_id
      LEFT JOIN users pu ON pu.id = r.taker_user_id`;
  return {
    swaps: (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE state = 'done' AND kind = 'swap' AND counted = 1").get() as { n: number }).n,
    playerTrades: (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE state = 'done' AND kind = 'player'").get() as { n: number }).n,
    disputed: db.prepare(`${withNames} WHERE r.state = 'disputed' ORDER BY r.closed_at DESC LIMIT 50`).all() as DisputeRow[],
    frozen: db.prepare("SELECT n.id, n.name, u.display_name AS owner, n.frozen_reason FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.frozen = 1 ORDER BY n.name").all() as FrozenNode[],
    // What players said went wrong with a trade: for the operator to look at. It freezes nobody.
    reports: db.prepare(`${withNames} WHERE r.player_report IS NOT NULL ORDER BY r.player_report_at DESC LIMIT 50`).all() as DisputeRow[],
    // How many meetings each node was in whose two sides contradicted each other: a node that keeps contradicting different partners stands out.
    disputesByNode: new Map((db.prepare(`SELECT node_id, COUNT(*) AS n FROM (
        SELECT giver_node_id AS node_id FROM rendezvous WHERE state = 'disputed'
        UNION ALL SELECT taker_node_id FROM rendezvous WHERE state = 'disputed' AND taker_node_id IS NOT NULL
      ) GROUP BY node_id`).all() as { node_id: string; n: number }[]).map((r) => [r.node_id, r.n])),
  };
}

/** The operator's call: no new offers or accepts from the node, and its offers hidden, until they unfreeze it. */
export function freezeNode(db: Db, nodeId: string, reason: string): boolean {
  return db.prepare("UPDATE nodes SET frozen = 1, frozen_reason = ? WHERE id = ?").run(reason.trim().slice(0, 200) || "frozen by the operator", nodeId).changes > 0;
}

export function unfreezeNode(db: Db, nodeId: string): boolean {
  return db.prepare("UPDATE nodes SET frozen = 0, frozen_reason = NULL WHERE id = ?").run(nodeId).changes > 0;
}
