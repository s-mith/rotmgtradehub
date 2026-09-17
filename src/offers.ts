// Phase 3 of docs/hub-protocol.md: the offer board, rendezvous between two
// nodes' bots, and the receipts that close them. Pure functions over the db;
// the routes in app.tsx only translate results to JSON. The hub never sees
// an item instance: offers carry catalog ids and the poster's own refs.
// Phase 4b: an offer may be posted or accepted on behalf of a guest of the
// node (`onBehalfOf`); the guest's name shows as poster, everything else
// (limits, freezes, attestations) stays the node's.
import type { AcceptOfferRequest, CreateOfferRequest, NodeLimitsWire, OfferItemWire, OfferStatusWire, OfferWire, ReceiptWire, RendezvousState, RendezvousWire, WantLineWire } from "rotmgtrade/shared/hubWire";
import type { Db } from "./db";
import type { NodeRow } from "./nodes";

export const OFFER_TTL_MS = 14 * 24 * 3600 * 1000;
export const RENDEZVOUS_MS = 30 * 60 * 1000;
export const FINISHED_KEEP = 20;

export const IGN_RE = /^[A-Za-z]{1,32}$/;
export const SERVER_RE = /^[A-Za-z0-9]{1,24}$/;
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
  /** Phase 4b: the guest of the poster's node this offer is for (null: the owner's own). */
  for_user_id: number | null;
  /** Phase 4b: the guest of the taker's node that accepted it. */
  taker_for_user_id: number | null;
}

export interface RendezvousRow {
  id: number;
  offer_id: number;
  server: string;
  seasonal: number;
  state: RendezvousState;
  created_at: number;
  deadline_at: number;
  giver_node_id: string;
  giver_bot_ign: string;
  giver_gives_json: string;
  taker_node_id: string;
  taker_bot_ign: string;
  taker_gives_json: string;
  closed_at: number | null;
  reason: string | null;
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
  partner_ign: string;
  error: string | null;
  at: number;
}

type Qty = { itemId: string; qty: number };

// --- limits -----------------------------------------------------------------

export function limitsFor(db: Db, node: Pick<NodeRow, "id">): NodeLimitsWire {
  const row = db.prepare("SELECT completed_swaps, frozen FROM nodes WHERE id = ?").get(node.id) as { completed_swaps: number; frozen: number } | undefined;
  const completedSwaps = row?.completed_swaps ?? 0;
  return {
    maxOpenOffers: Math.min(8, 1 + Math.floor(completedSwaps / 3)),
    maxItemsPerSide: Math.min(24, 4 + 2 * completedSwaps),
    completedSwaps,
    frozen: !!row?.frozen,
  };
}

function openOffersOf(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM offers WHERE node_id = ? AND status = 'open'").get(nodeId) as { n: number }).n;
}

function activeTakes(db: Db, nodeId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE taker_node_id = ? AND state = 'meet'").get(nodeId) as { n: number }).n;
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
    if (!isInt(r.qty, 1, 8)) return refuse(400, "want: qty must be 1..8");
    if (!isInt(r.slotsMin, 0, 8)) return refuse(400, "want: slotsMin must be 0..8");
    if (r.slotsExact !== null && !isInt(r.slotsExact, 0, 8)) return refuse(400, "want: slotsExact must be null or 0..8");
    if (!Array.isArray(r.enchants) || r.enchants.length > 32) return refuse(400, "want: enchants must be an array");
    total += r.qty;
    want.push({ itemId: r.itemId, qty: r.qty, slotsMin: r.slotsMin, slotsExact: r.slotsExact, enchants: JSON.parse(JSON.stringify(r.enchants)) });
  }
  if (total > maxQty) return refuse(409, `want: at most ${maxQty} items in total`);
  return { want };
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

function posterOf(db: Db, nodeId: string, forUserId: number | null = null): string {
  if (forUserId !== null) {
    const g = db.prepare("SELECT display_name AS name FROM users WHERE id = ?").get(forUserId) as { name: string } | undefined;
    if (g) return g.name;
  }
  const r = db.prepare("SELECT u.display_name AS name FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.id = ?").get(nodeId) as { name: string } | undefined;
  return r?.name ?? "?";
}

/** Phase 4b: the grant that lets `userId` trade through `nodeId`, if any. */
function tradeGrant(db: Db, nodeId: string, userId: number): boolean {
  return !!db.prepare("SELECT 1 FROM grants WHERE node_id = ? AND user_id = ? AND trade = 1 AND paused = 0").get(nodeId, userId);
}

/** Resolves `onBehalfOf`: absent → null (the node's owner); otherwise a guest with a live trade grant, else 403. */
function guestOf(db: Db, node: NodeRow, onBehalfOf: unknown): { userId: number | null } | Refusal {
  if (onBehalfOf === undefined || onBehalfOf === null) return { userId: null };
  if (!isInt(onBehalfOf, 1, Number.MAX_SAFE_INTEGER)) return refuse(400, "onBehalfOf must be a user id");
  if (!tradeGrant(db, node.id, onBehalfOf)) return refuse(403, "no trade grant for that guest on this node");
  return { userId: onBehalfOf };
}

function offerWire(db: Db, o: OfferRow, forNodeId: string, poster = posterOf(db, o.node_id, o.for_user_id)): OfferWire {
  return {
    id: o.id,
    poster,
    mine: o.node_id === forNodeId,
    onBehalfOf: o.for_user_id,
    botIgn: o.bot_ign,
    seasonal: !!o.seasonal,
    server: o.server,
    give: JSON.parse(o.give_json) as OfferItemWire[],
    want: JSON.parse(o.want_json) as WantLineWire[],
    status: o.status,
    createdAt: o.created_at,
    expiresAt: o.expires_at,
  };
}

/** Physical items → catalog counts, first-seen order. */
function collapse(items: OfferItemWire[]): Qty[] {
  const out: Qty[] = [];
  for (const it of items) {
    const hit = out.find((q) => q.itemId === it.itemId);
    if (hit) hit.qty++;
    else out.push({ itemId: it.itemId, qty: 1 });
  }
  return out;
}

/** Canonical form for comparing receipts: merged by itemId, sorted. */
function canon(list: Qty[]): string {
  const m = new Map<string, number>();
  for (const q of list) m.set(q.itemId, (m.get(q.itemId) ?? 0) + q.qty);
  return JSON.stringify([...m.entries()].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function rendezvousWire(db: Db, rv: RendezvousRow, nodeId: string): RendezvousWire {
  const giving = rv.giver_node_id === nodeId;
  const mine = JSON.parse(giving ? rv.giver_gives_json : rv.taker_gives_json) as OfferItemWire[];
  const theirs = JSON.parse(giving ? rv.taker_gives_json : rv.giver_gives_json) as OfferItemWire[];
  const partnerId = giving ? rv.taker_node_id : rv.giver_node_id;
  const offer = db.prepare("SELECT for_user_id, taker_for_user_id FROM offers WHERE id = ?").get(rv.offer_id) as { for_user_id: number | null; taker_for_user_id: number | null } | undefined;
  const partnerGuest = giving ? offer?.taker_for_user_id ?? null : offer?.for_user_id ?? null;
  const reported = db.prepare("SELECT DISTINCT node_id FROM receipts WHERE rendezvous_id = ?").all(rv.id) as { node_id: string }[];
  return {
    id: rv.id,
    offerId: rv.offer_id,
    server: rv.server,
    seasonal: !!rv.seasonal,
    state: rv.state,
    createdAt: rv.created_at,
    deadlineAt: rv.deadline_at,
    me: { role: giving ? "give" : "take", botIgn: giving ? rv.giver_bot_ign : rv.taker_bot_ign, gives: mine, gets: collapse(theirs) },
    partner: { botIgn: giving ? rv.taker_bot_ign : rv.giver_bot_ign, poster: posterOf(db, partnerId, partnerGuest) },
    reported: { mine: reported.some((r) => r.node_id === nodeId), partner: reported.some((r) => r.node_id === partnerId) },
  };
}

// --- offers -----------------------------------------------------------------

export function createOffer(db: Db, node: NodeRow, req: CreateOfferRequest, now = Date.now()): Result<{ offer: OfferWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const limits = limitsFor(db, node);
  if (limits.frozen) return refuse(409, "this node is frozen until the operator clears its dispute");
  const guest = guestOf(db, node, req.onBehalfOf);
  if ("ok" in guest) return guest;
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  if (typeof req.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
  if (typeof req.server !== "string" || !SERVER_RE.test(req.server)) return refuse(400, "server: letters and digits, 1..24");
  if (Array.isArray(req.give) && req.give.length > limits.maxItemsPerSide) return refuse(409, `give: at most ${limits.maxItemsPerSide} items per side until more swaps complete`);
  const give = parseItems(req.give, limits.maxItemsPerSide, "give");
  if ("ok" in give) return give;
  const want = parseWant(req.want, limits.maxItemsPerSide);
  if ("ok" in want) return want;
  if (openOffersOf(db, node.id) >= limits.maxOpenOffers) return refuse(409, `at most ${limits.maxOpenOffers} open offer${limits.maxOpenOffers === 1 ? "" : "s"} until more swaps complete`);
  const r = db.prepare(`INSERT INTO offers (node_id, bot_ign, seasonal, server, give_json, want_json, status, created_at, updated_at, expires_at, for_user_id)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`).run(node.id, req.botIgn, req.seasonal ? 1 : 0, req.server, JSON.stringify(give.items), JSON.stringify(want.want), now, now, now + OFFER_TTL_MS, guest.userId);
  const row = db.prepare("SELECT * FROM offers WHERE id = ?").get(r.lastInsertRowid) as OfferRow;
  return { ok: true, offer: offerWire(db, row, node.id) };
}

/** Every open offer, newest first, minus those of frozen nodes. Also sweeps. */
export function listOpen(db: Db, forNode: NodeRow, now = Date.now()): { offers: OfferWire[]; limits: NodeLimitsWire } {
  sweepRendezvous(db, now);
  // A guest's offer shows under the guest's name and is hidden while their grant is paused, revoked, or no longer allows trading.
  const rows = db.prepare(`SELECT o.*, COALESCE(g.display_name, u.display_name) AS poster FROM offers o JOIN nodes n ON n.id = o.node_id JOIN users u ON u.id = n.user_id
    LEFT JOIN users g ON g.id = o.for_user_id
    LEFT JOIN grants gr ON gr.node_id = o.node_id AND gr.user_id = o.for_user_id
    WHERE o.status = 'open' AND n.frozen = 0 AND (o.for_user_id IS NULL OR (gr.id IS NOT NULL AND gr.paused = 0 AND gr.trade = 1))
    ORDER BY o.created_at DESC, o.id DESC`).all() as (OfferRow & { poster: string })[];
  return { offers: rows.map((o) => offerWire(db, o, forNode.id, o.poster)), limits: limitsFor(db, forNode) };
}

export function listMine(db: Db, node: NodeRow, now = Date.now()): { offers: OfferWire[]; limits: NodeLimitsWire } {
  sweepRendezvous(db, now);
  const rows = db.prepare("SELECT * FROM offers WHERE node_id = ? ORDER BY created_at DESC, id DESC").all(node.id) as OfferRow[];
  return { offers: rows.map((o) => offerWire(db, o, node.id)), limits: limitsFor(db, node) };
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
  if (limits.frozen) return refuse(409, "this node is frozen until the operator clears its dispute");
  if (typeof req.botIgn !== "string" || !IGN_RE.test(req.botIgn)) return refuse(400, "botIgn: letters only, 1..32");
  const guest = guestOf(db, taker, req.onBehalfOf);
  if ("ok" in guest) return guest;
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow | undefined;
  if (!o) return refuse(404, "no such offer");
  if (o.node_id === taker.id) return refuse(409, "that is your own offer");
  const poster = db.prepare("SELECT frozen FROM nodes WHERE id = ?").get(o.node_id) as { frozen: number } | undefined;
  if (o.status !== "open" || o.expires_at <= now || !poster || poster.frozen) return refuse(409, "offer is no longer open");
  if (o.for_user_id !== null && !tradeGrant(db, o.node_id, o.for_user_id)) return refuse(409, "offer is no longer open");
  const want = JSON.parse(o.want_json) as WantLineWire[];
  const give = JSON.parse(o.give_json) as OfferItemWire[];
  const expected = want.flatMap((w) => Array.from({ length: w.qty }, () => w.itemId));
  if (expected.length > limits.maxItemsPerSide || give.length > limits.maxItemsPerSide) return refuse(409, `this offer is above your ${limits.maxItemsPerSide} items per side`);
  if (activeTakes(db, taker.id) >= limits.maxOpenOffers) return refuse(409, `at most ${limits.maxOpenOffers} rendezvous as taker at a time`);
  const items = parseItems(req.items, expected.length, "items");
  if ("ok" in items) return items;
  if (items.items.length !== expected.length) return refuse(400, `items: the offer wants ${expected.length} items, got ${items.items.length}`);
  for (let i = 0; i < expected.length; i++) if (items.items[i].itemId !== expected[i]) return refuse(400, `items[${i}]: want line asks for ${expected[i]}, got ${items.items[i].itemId}`);
  const rvId = db.transaction(() => {
    const u = db.prepare("UPDATE offers SET status = 'accepted', taker_node_id = ?, taker_for_user_id = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(taker.id, guest.userId, now, offerId);
    if (!u.changes) return null;
    const r = db.prepare(`INSERT INTO rendezvous (offer_id, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_bot_ign, taker_gives_json)
      VALUES (?, ?, ?, 'meet', ?, ?, ?, ?, ?, ?, ?, ?)`).run(offerId, o.server, o.seasonal, now, now + RENDEZVOUS_MS, o.node_id, o.bot_ign, o.give_json, taker.id, req.botIgn, JSON.stringify(items.items));
    return Number(r.lastInsertRowid);
  })();
  if (rvId === null) return refuse(409, "offer is no longer open");
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(rvId) as RendezvousRow;
  return { ok: true, rendezvous: rendezvousWire(db, rv, taker.id) };
}

// --- rendezvous -------------------------------------------------------------

export function rendezvousFor(db: Db, node: NodeRow, now = Date.now()): RendezvousWire[] {
  sweepRendezvous(db, now);
  const rows = db.prepare(`SELECT * FROM (
      SELECT * FROM rendezvous WHERE (giver_node_id = ? OR taker_node_id = ?) AND state = 'meet'
      UNION ALL
      SELECT * FROM (SELECT * FROM rendezvous WHERE (giver_node_id = ? OR taker_node_id = ?) AND state != 'meet' ORDER BY closed_at DESC, id DESC LIMIT ?)
    ) ORDER BY (state = 'meet') DESC, created_at DESC, id DESC`).all(node.id, node.id, node.id, node.id, FINISHED_KEEP) as RendezvousRow[];
  return rows.map((rv) => rendezvousWire(db, rv, node.id));
}

function partyOf(db: Db, node: NodeRow, rendezvousId: number): { rv: RendezvousRow; partnerId: string } | Refusal {
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(rendezvousId) as RendezvousRow | undefined;
  if (!rv || (rv.giver_node_id !== node.id && rv.taker_node_id !== node.id)) return refuse(404, "no such rendezvous");
  return { rv, partnerId: rv.giver_node_id === node.id ? rv.taker_node_id : rv.giver_node_id };
}

function reopenOffer(db: Db, offerId: number, now: number): void {
  db.prepare("UPDATE offers SET status = 'open', taker_node_id = NULL, taker_for_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'accepted'").run(now, offerId);
}

function close(db: Db, rv: RendezvousRow, state: RendezvousState, reason: string | null, now: number): void {
  db.prepare("UPDATE rendezvous SET state = ?, reason = ?, closed_at = ? WHERE id = ? AND state = 'meet'").run(state, reason, now, rv.id);
}

function fail(db: Db, rv: RendezvousRow, state: "failed" | "aborted", reason: string, now: number): void {
  close(db, rv, state, reason, now);
  reopenOffer(db, rv.offer_id, now);
}

function dispute(db: Db, rv: RendezvousRow, reason: string, now: number): void {
  close(db, rv, "disputed", reason, now);
  db.prepare("UPDATE offers SET status = 'void', updated_at = ?, closed_at = ? WHERE id = ? AND status = 'accepted'").run(now, now, rv.offer_id);
  db.prepare("UPDATE nodes SET frozen = 1, frozen_reason = ? WHERE id IN (?, ?)").run(`disputed rendezvous #${rv.id}: ${reason}`, rv.giver_node_id, rv.taker_node_id);
}

function complete(db: Db, rv: RendezvousRow, giverReceipt: ReceiptRow, takerReceipt: ReceiptRow, now: number): void {
  close(db, rv, "done", null, now);
  db.prepare("UPDATE nodes SET completed_swaps = completed_swaps + 1 WHERE id IN (?, ?)").run(rv.giver_node_id, rv.taker_node_id);
  const att = db.prepare("INSERT OR IGNORE INTO attestations (node_id, bot_ign, by_node_id, at) VALUES (?, ?, ?, ?)");
  att.run(rv.taker_node_id, giverReceipt.partner_ign, rv.giver_node_id, now);
  att.run(rv.giver_node_id, takerReceipt.partner_ign, rv.taker_node_id, now);
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
  return { r: { window: r.window, ok: r.ok, gave: gave.list, gaveRefs: [...r.gaveRefs], got: got.list, partnerIgn: r.partnerIgn, error: r.error === undefined ? undefined : r.error.slice(0, 200), at: Math.round(r.at) } };
}

export function submitReceipt(db: Db, node: NodeRow, rendezvousId: number, raw: unknown, now = Date.now()): Result<{ state: RendezvousState }> {
  const p = partyOf(db, node, rendezvousId);
  if ("ok" in p) return p;
  const parsed = parseReceipt(raw);
  if ("ok" in parsed) return parsed;
  const { rv, partnerId } = p;
  const rc = parsed.r;
  const state = db.transaction((): RendezvousState => {
    db.prepare(`INSERT OR IGNORE INTO receipts (rendezvous_id, node_id, window, ok, gave_json, gave_refs_json, got_json, partner_ign, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rv.id, node.id, rc.window, rc.ok ? 1 : 0, JSON.stringify(rc.gave), JSON.stringify(rc.gaveRefs), JSON.stringify(rc.got), rc.partnerIgn, rc.error ?? null, rc.at);
    if (rv.state !== "meet") return rv.state;
    const mine = db.prepare("SELECT * FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND window = ?").get(rv.id, node.id, rc.window) as ReceiptRow;
    const theirs = db.prepare("SELECT * FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND window = ?").get(rv.id, partnerId, rc.window) as ReceiptRow | undefined;
    if (theirs) {
      const giver = rv.giver_node_id === node.id ? mine : theirs;
      const taker = rv.giver_node_id === node.id ? theirs : mine;
      const match = !!mine.ok && !!theirs.ok && canon(JSON.parse(giver.gave_json)) === canon(JSON.parse(taker.got_json)) && canon(JSON.parse(taker.gave_json)) === canon(JSON.parse(giver.got_json));
      if (match) complete(db, rv, giver, taker, now);
      else dispute(db, rv, !mine.ok || !theirs.ok ? "one side reported failure, the other success" : "the two receipts disagree on what changed hands", now);
    } else if (!mine.ok) {
      // Alone with a failure: the swap did not happen unless the partner already claims it did.
      const partnerOk = db.prepare("SELECT 1 FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND ok = 1").get(rv.id, partnerId);
      if (partnerOk) dispute(db, rv, "one side reported failure, the other success", now);
      else fail(db, rv, "failed", mine.error || "reported failed", now);
    }
    return (db.prepare("SELECT state FROM rendezvous WHERE id = ?").get(rv.id) as { state: RendezvousState }).state;
  })();
  return { ok: true, state };
}

export function abortRendezvous(db: Db, node: NodeRow, rendezvousId: number, reason: unknown, now = Date.now()): Result<{ state: RendezvousState }> {
  const p = partyOf(db, node, rendezvousId);
  if ("ok" in p) return p;
  const { rv, partnerId } = p;
  if (rv.state !== "meet") return refuse(409, `rendezvous is ${rv.state}`);
  const why = (typeof reason === "string" ? reason : "").slice(0, 200) || "aborted";
  db.transaction(() => {
    // Walking away after the partner reported a completed trade is a dispute, not an abort.
    const partnerOk = db.prepare("SELECT 1 FROM receipts WHERE rendezvous_id = ? AND node_id = ? AND ok = 1").get(rv.id, partnerId);
    if (partnerOk) dispute(db, rv, `aborted after the partner reported success: ${why}`, now);
    else fail(db, rv, "aborted", why, now);
  })();
  return { ok: true, state: (db.prepare("SELECT state FROM rendezvous WHERE id = ?").get(rv.id) as { state: RendezvousState }).state };
}

/** Deadlines and expiries. Cheap; called from the list routes. */
export function sweepRendezvous(db: Db, now = Date.now()): void {
  const due = db.prepare("SELECT * FROM rendezvous WHERE state = 'meet' AND deadline_at <= ?").all(now) as RendezvousRow[];
  db.transaction(() => {
    for (const rv of due) {
      const anyOk = db.prepare("SELECT 1 FROM receipts WHERE rendezvous_id = ? AND ok = 1").get(rv.id);
      if (anyOk) dispute(db, rv, "deadline passed with an unconfirmed success report", now);
      else fail(db, rv, "failed", "deadline passed", now);
    }
    db.prepare("UPDATE offers SET status = 'expired', updated_at = ?, closed_at = ? WHERE status = 'open' AND expires_at <= ?").run(now, now, now);
  })();
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

export function operatorView(db: Db): { swaps: number; disputed: DisputeRow[]; frozen: FrozenNode[] } {
  return {
    swaps: (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE state = 'done'").get() as { n: number }).n,
    disputed: db.prepare(`SELECT r.*, gu.display_name AS giver_name, tu.display_name AS taker_name FROM rendezvous r
      JOIN nodes g ON g.id = r.giver_node_id JOIN users gu ON gu.id = g.user_id
      JOIN nodes t ON t.id = r.taker_node_id JOIN users tu ON tu.id = t.user_id
      WHERE r.state = 'disputed' ORDER BY r.closed_at DESC LIMIT 50`).all() as DisputeRow[],
    frozen: db.prepare("SELECT n.id, n.name, u.display_name AS owner, n.frozen_reason FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.frozen = 1 ORDER BY n.name").all() as FrozenNode[],
  };
}

export function unfreezeNode(db: Db, nodeId: string): boolean {
  return db.prepare("UPDATE nodes SET frozen = 0, frozen_reason = NULL WHERE id = ?").run(nodeId).changes > 0;
}
