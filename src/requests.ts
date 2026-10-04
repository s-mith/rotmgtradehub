// The request queue (docs/hub-protocol.md, "Requests"): what a hub user asks
// a node to do, queued here and executed by the node, which polls, reports
// progress and closes it. Anyone signed in may ask a node to meet them in
// game for a communism deposit or withdraw (with their own IGN); a node's
// owner may also post, accept and cancel offers from the website and move
// items between communism (take onto their node, give from it). The hub only
// checks what it can: communism capacity and listings it holds, the offer
// board, the shapes. Refs of the owner's own pool it cannot see; the node
// refuses those it does not have.
import type { GuestRequestKind, GuestRequestResult, GuestRequestState, GuestRequestWire, WantLineWire } from "rotmgtradenode/shared/hubWire";
import { loginNodeId, tradingIgnOf, type User } from "./auth";
import { ITEM_BY_ID } from "./catalog";
import type { Db } from "./db";
import { emit } from "./events";
import { NODE_ONLINE_MS, nodeStatus, takesByCount, type NodeRow } from "./nodes";
import { HELD_OFFER, IGN_RE, REF_RE, isInt, knownServer, limitsFor, offerHeldBy, parseWant, refuse, type OfferRow, type Refusal, type Result } from "./offers";

/** A request nobody took, or took and never answered, within this long is expired; a node's progress note starts it over. */
export const GUEST_REQUEST_TTL_MS = 30 * 60 * 1000;
/**
 * A request handed to a node is the node's once it answers (a progress note or
 * its result). One handed out and never answered within this long is handed
 * out again on the next poll: the reply carrying it may have gone to a
 * connection that was already gone (a node restarting during its long poll).
 * Nodes take a request once by its id, so a second hand-out runs nothing twice.
 */
export const TAKE_LEASE_MS = 2 * 60 * 1000;
/**
 * Nodes wait on `GET /guest-requests?wait=N` for up to N seconds; a request
 * queued for a node wakes its waiter at once, so nothing sits in the queue
 * for a poll interval. One waiter per node at a time is the normal case.
 */
const waiters = new Map<string, Set<() => void>>();
export function waitForRequest(nodeId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(nodeId);
    if (!set) waiters.set(nodeId, (set = new Set()));
    const done = () => {
      clearTimeout(t);
      set!.delete(done);
      if (!set!.size) waiters.delete(nodeId);
      resolve();
    };
    const t = setTimeout(done, ms);
    set.add(done);
  });
}
function wakeNode(nodeId: string): void {
  for (const fn of [...(waiters.get(nodeId) ?? [])]) fn();
}
/** The longest a node may wait on the queue in one request. */
export const MAX_REQUEST_WAIT_S = 25;

/** A person may have this many unanswered requests per node. */
export const MAX_OPEN_REQUESTS = 10;
/** A deposit or a hand-over moves at most one trade window's worth. */
export const MAX_TRADE_ITEMS = 24;
/** A communism withdraw takes at most this many items in one meeting. */
export const MAX_WITHDRAW_ITEMS = 8;
/** One withdraw from the website may pick from this many nodes: a request each, met one after another. */
export const MAX_WITHDRAW_NODES = 8;
export const KINDS: readonly GuestRequestKind[] = ["deposit", "withdraw", "offer-create", "offer-accept", "offer-cancel", "communism-take", "communism-give"];
/** What only a node's owner may queue: the node acts with its own pool and bots. */
export const OWNER_KINDS: readonly GuestRequestKind[] = ["offer-create", "offer-accept", "offer-cancel", "communism-take", "communism-give"];

// --- rows -------------------------------------------------------------------

/**
 * True while an open request (`pending` or `taken`) has spoken for the listed communism item `ci`: a person's withdraw
 * from its node, or another node's take of it. `except` (a node id, or NULL) leaves out that node's own takes: the node
 * carrying out a take asks for the item it is the request for.
 */
export const REQUEST_HOLDS = (except: string) => `EXISTS (SELECT 1 FROM guest_requests g, json_each(g.refs_json) j WHERE g.state IN ('pending', 'taken') AND j.value = ci.ref
  AND ((g.kind = 'withdraw' AND g.node_id = ci.node_id) OR (g.kind = 'communism-take' AND g.communism_node_id = ci.node_id AND g.node_id IS NOT ${except})))`;
/** True while someone is meeting the contributor for the listed communism item `ci`: another node's take of it. */
export const IN_MEETING = "EXISTS (SELECT 1 FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_node_id = ci.node_id AND rv.communism_ref = ci.ref)";
/**
 * True while the listed communism item `ci` is being handed over by its own node in a give under way: a full communism
 * passing its surplus on to another node's (docs/relay/ADVANCED.md). Its node takes it off its listing at once; until
 * that publish lands it is held here.
 */
export const PASSING = "EXISTS (SELECT 1 FROM rendezvous rv, json_each(rv.giver_gives_json) gv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL AND rv.giver_node_id = ci.node_id AND json_extract(gv.value, '$.ref') = ci.ref)";

export interface GuestRequestRow {
  id: number;
  node_id: string;
  user_id: number;
  ign: string;
  kind: GuestRequestKind;
  seasonal: number;
  server: string | null;
  count: number | null;
  refs_json: string | null;
  want_json: string | null;
  offer_id: number | null;
  communism_node_id: string | null;
  state: GuestRequestState;
  created_at: number;
  taken_at: number | null;
  result_json: string | null;
  /** Handed to its node only after this request (the person's previous trade, on another node) closed; then `ready_at` says when. */
  after_id: number | null;
  ready_at: number | null;
  /** The node's last progress note: the request's half hour counts from it. */
  progress_at: number | null;
}

type RequestJoin = GuestRequestRow & { display_name: string; owner_id: number; node_name: string };

/** A request as the website shows it: the wire shape plus the node's name, and the request it waits for, if any. */
export interface RequestView extends GuestRequestWire {
  nodeName: string;
  after: number | null;
}

function requestWire(r: RequestJoin): RequestView {
  const refs = r.refs_json === null ? null : (JSON.parse(r.refs_json) as string[]);
  return {
    id: r.id,
    nodeId: r.node_id,
    nodeName: r.node_name,
    after: r.after_id,
    requester: { userId: r.user_id, displayName: r.display_name },
    owner: r.user_id === r.owner_id,
    ign: r.ign,
    kind: r.kind,
    seasonal: !!r.seasonal,
    server: r.server,
    count: r.count,
    refs,
    want: r.want_json === null ? null : (JSON.parse(r.want_json) as WantLineWire[]),
    offerId: r.offer_id,
    communism: r.communism_node_id === null ? null : r.kind === "communism-take" ? (refs?.length ? { nodeId: r.communism_node_id, ref: refs[0] } : null) : { nodeId: r.communism_node_id, ref: null },
    state: r.state,
    createdAt: r.created_at,
    result: r.result_json === null ? null : (JSON.parse(r.result_json) as GuestRequestResult),
  };
}

const REQUEST_SELECT = "SELECT r.*, u.display_name, n.user_id AS owner_id, n.name AS node_name FROM guest_requests r JOIN users u ON u.id = r.user_id JOIN nodes n ON n.id = r.node_id";

// --- validation -------------------------------------------------------------

/** What the website hands in; everything is checked here. */
export interface GuestRequestInput {
  kind: string;
  seasonal?: boolean;
  server?: string;
  count?: number;
  refs?: string[];
  want?: unknown;
  offerId?: number;
  /** communism-take: the listed item. communism-give: the node whose communism receives. */
  communism?: { nodeId: string; ref?: string };
  /** A deposit or withdraw that waits for this earlier request of the same person to close first (one trade window at a time). */
  after?: number;
  /** Deposit or withdraw: which of the person's characters meets the bot; their main one when absent. */
  ign?: string;
}

/** Distinct, well-formed refs, 1..max. */
function parseRefs(raw: unknown, max: number): { refs: string[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1) return refuse(400, "refs: pick at least one item");
  if (raw.length > max) return refuse(409, `refs: at most ${max} items at a time`);
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string" || !REF_RE.test(r)) return refuse(400, "refs: bad ref");
    if (seen.has(r)) return refuse(400, `refs: duplicate ${r}`);
    seen.add(r);
  }
  return { refs: [...seen] };
}

function openRequestsOf(db: Db, nodeId: string, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE node_id = ? AND user_id = ? AND state IN ('pending', 'taken')").get(nodeId, userId) as { n: number }).n;
}

const online = (n: { last_seen_at: number | null; frozen: number }, now: number): boolean => !n.frozen && n.last_seen_at !== null && n.last_seen_at >= now - NODE_ONLINE_MS;

/**
 * Items hand-overs under way are bringing to communism account `a` (a give: no communism ref, the account receiving).
 * They are not in what its node published yet; once the meeting closes the node's next publish has them, or not.
 */
const INCOMING = "(SELECT COALESCE(SUM(json_array_length(rv.giver_gives_json)), 0) FROM rendezvous rv WHERE rv.kind = 'communism' AND rv.state = 'meet' AND rv.communism_ref IS NULL AND rv.taker_node_id = a.node_id AND rv.taker_bot_ign = a.ign)";
/** A communism account's room: what its node published, less what gives under way bring it. `a` is the communism_accounts row. */
export const EFFECTIVE_FREE = `MAX(a.free - ${INCOMING}, 0)`;

/** Communism account of `nodeId` in that half with the most room, if any has room for `need` items. */
export function accountWithRoom(db: Db, nodeId: string, seasonal: boolean, need: number): { ign: string; free: number } | undefined {
  return db.prepare(`SELECT ign, free FROM (SELECT a.ign, ${EFFECTIVE_FREE} AS free FROM communism_accounts a WHERE a.node_id = ? AND a.seasonal = ?) WHERE free >= ? ORDER BY free DESC, ign LIMIT 1`).get(nodeId, seasonal ? 1 : 0, need) as { ign: string; free: number } | undefined;
}

/** Room across every communism account of `nodeId` in that half. */
function roomOnNode(db: Db, nodeId: string, seasonal: boolean): number {
  return (db.prepare(`SELECT COALESCE(SUM(${EFFECTIVE_FREE}), 0) AS free FROM communism_accounts a WHERE a.node_id = ? AND a.seasonal = ?`).get(nodeId, seasonal ? 1 : 0) as { free: number }).free;
}

/**
 * Plain copies (no enchantments) of `itemId` a "N of this item" withdraw could still get from `nodeId`'s communism in
 * that half: those listed and free (nobody meeting for them, asking for them by ref or being handed them), less what
 * open by-count withdraws there already ask for. Which copies those take is the node's choice, so a later pick by ref
 * can still find one gone; the node then says so.
 */
export function availableCopies(db: Db, nodeId: string, seasonal: boolean, itemId: string): number {
  const listed = (db.prepare(`SELECT COUNT(*) AS n FROM communism_items ci WHERE ci.node_id = ? AND ci.item_id = ? AND ci.seasonal = ? AND ci.count = 0
    AND NOT ${IN_MEETING} AND NOT ${REQUEST_HOLDS("NULL")} AND NOT ${PASSING}`).get(nodeId, itemId, seasonal ? 1 : 0) as { n: number }).n;
  // Only counts the node has not answered yet: once it has, the copies it picked are spoken for there and leave its listing.
  const asked = (db.prepare(`SELECT COALESCE(SUM(json_extract(j.value, '$.qty')), 0) AS n FROM guest_requests g, json_each(g.want_json) j
    WHERE g.node_id = ? AND g.kind = 'withdraw' AND g.state IN ('pending', 'taken') AND g.result_json IS NULL AND g.refs_json IS NULL AND g.seasonal = ? AND json_extract(j.value, '$.itemId') = ?`).get(nodeId, seasonal ? 1 : 0, itemId) as { n: number }).n;
  return Math.max(0, listed - asked);
}

/**
 * Refs of `nodeId`'s listed communism items that open requests here hold: withdraws by ref (waiting their turn or not),
 * other nodes' takes, and take meetings. A withdraw by count carries them to the node (GuestRequestWire.held), whose
 * pick leaves them alone.
 */
export function heldRefsOf(db: Db, nodeId: string): string[] {
  return (db.prepare(`SELECT communism_ref AS ref FROM rendezvous WHERE kind = 'communism' AND state = 'meet' AND communism_node_id = ? AND communism_ref IS NOT NULL
    UNION SELECT j.value FROM guest_requests g, json_each(g.refs_json) j WHERE g.state IN ('pending', 'taken') AND g.kind = 'withdraw' AND g.node_id = ?
    UNION SELECT j.value FROM guest_requests g, json_each(g.refs_json) j WHERE g.state IN ('pending', 'taken') AND g.kind = 'communism-take' AND g.communism_node_id = ?`).all(nodeId, nodeId, nodeId) as { ref: string }[]).map((r) => r.ref);
}

/** "N of this item": catalog items and whole numbers, each item once, MAX_WITHDRAW_ITEMS in all; as want lines for plain copies. */
function parseCountWant(raw: unknown): { want: WantLineWire[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1) return refuse(400, "want: ask for at least one item");
  const qty = new Map<string, number>();
  for (const l of raw as { itemId?: unknown; qty?: unknown }[]) {
    if (!l || typeof l !== "object" || typeof l.itemId !== "string" || !ITEM_BY_ID.has(l.itemId)) return refuse(400, "want: unknown item");
    if (!isInt(l.qty, 1, MAX_WITHDRAW_ITEMS)) return refuse(400, `want: how many, 1..${MAX_WITHDRAW_ITEMS}`);
    qty.set(l.itemId, (qty.get(l.itemId) ?? 0) + (l.qty as number));
  }
  const total = [...qty.values()].reduce((n, q) => n + q, 0);
  if (total > MAX_WITHDRAW_ITEMS) return refuse(409, `want: at most ${MAX_WITHDRAW_ITEMS} items at a time`);
  return { want: [...qty].map(([itemId, q]) => ({ itemId, qty: q, slotsMin: 0, slotsExact: 0, enchants: [] })) };
}

export function createGuestRequest(db: Db, user: Pick<User, "id">, nodeId: string, input: GuestRequestInput, now = Date.now()): Result<{ request: RequestView }> {
  sweepGuestRequests(db, now);
  const node = db.prepare("SELECT * FROM nodes WHERE id = ? AND unlinked_at IS NULL").get(nodeId) as NodeRow | undefined;
  if (!node) return refuse(404, "no such node");
  const own = node.user_id === user.id;
  const kind = input.kind as GuestRequestKind;
  if (!KINDS.includes(kind)) return refuse(400, `kind must be one of ${KINDS.join(", ")}`);
  if (!own && OWNER_KINDS.includes(kind)) return refuse(403, "only the node's owner does that with it");
  if (openRequestsOf(db, nodeId, user.id) >= MAX_OPEN_REQUESTS) return refuse(409, `you already have ${MAX_OPEN_REQUESTS} requests waiting on this node`);

  let ign = "";
  let seasonal: boolean;
  let server: string | null = null;
  let count: number | null = null;
  let refs: string[] | null = null;
  let want: WantLineWire[] | null = null;
  let offerId: number | null = null;
  let communismNodeId: string | null = null;
  const needsServer = kind === "deposit" || kind === "withdraw" || kind === "offer-create" || kind === "communism-take" || kind === "communism-give";
  if (needsServer) {
    if (!knownServer(input.server)) return refuse(400, "server: one of the game's servers");
    server = input.server;
  }
  if (kind === "deposit" || kind === "offer-create" || kind === "communism-give") {
    if (typeof input.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
    seasonal = input.seasonal;
  } else {
    seasonal = false; // replaced by the listing's or the offer's below
  }
  const limits = limitsFor(db, node);

  if (kind === "deposit" || kind === "withdraw") {
    // With a login node on this hub, only a character proven by a whisper counts; before that, the typed name does.
    const picked = typeof input.ign === "string" && input.ign.trim() ? input.ign : null;
    const mine = tradingIgnOf(db, user.id, picked);
    if (!mine && picked) return refuse(403, loginNodeId(db) ? `${picked} is not a character you proved with a whisper` : `${picked} is not one of your characters`);
    if (!mine) return refuse(403, loginNodeId(db) ? "prove the character you play (your IGN) with a whisper in settings first" : "set the character you play as (your IGN) in settings first");
    ign = mine;
    if (!online(node, now)) return refuse(409, "that node is offline right now");
  }

  // "N of this item" from a node that picks the copies itself (CommunismNodeWire.byCount): no refs, want lines.
  const byCount = kind === "withdraw" && input.want !== undefined && (input.refs === undefined || (Array.isArray(input.refs) && input.refs.length === 0));
  if (kind === "deposit") {
    if (!isInt(input.count, 1, MAX_TRADE_ITEMS)) return refuse(400, `count must be 1..${MAX_TRADE_ITEMS}`);
    if (takesByCount(nodeStatus(db, nodeId))) {
      // Advanced management (docs/relay/ADVANCED.md): a deposit bigger than one character carries on with the next
      // empty one, on another account if need be, so the node's room counts across its accounts; the node has the last word.
      const room = roomOnNode(db, nodeId, seasonal);
      const any = accountWithRoom(db, nodeId, seasonal, 0);
      if (!any) return refuse(409, `that node has no ${seasonal ? "seasonal" : "non-seasonal"} account in the pool`);
      if (room < input.count) return refuse(409, `that node's ${seasonal ? "seasonal" : "non-seasonal"} pool has room for ${room} item${room === 1 ? "" : "s"} right now`);
    } else {
      const acct = accountWithRoom(db, nodeId, seasonal, input.count);
      if (!acct) {
        const best = accountWithRoom(db, nodeId, seasonal, 0);
        return refuse(409, best ? `that node's ${seasonal ? "seasonal" : "non-seasonal"} pool has room for ${best.free} item${best.free === 1 ? "" : "s"} on one account right now` : `that node has no ${seasonal ? "seasonal" : "non-seasonal"} account in the pool`);
      }
    }
    count = input.count;
  } else if (byCount) {
    if (!takesByCount(nodeStatus(db, nodeId))) return refuse(409, "that node takes withdraws item by item: pick the items");
    if (typeof input.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
    const w = parseCountWant(input.want);
    if ("ok" in w) return w;
    for (const line of w.want) {
      const have = availableCopies(db, nodeId, input.seasonal, line.itemId);
      const name = ITEM_BY_ID.get(line.itemId)?.name ?? line.itemId;
      if (have < line.qty) return refuse(409, `${have ? `only ${have}` : "no"} ${name} left in that node's ${input.seasonal ? "seasonal" : "non-seasonal"} pool`);
    }
    seasonal = input.seasonal;
    want = w.want;
  } else if (kind === "withdraw") {
    const r = parseRefs(input.refs, MAX_WITHDRAW_ITEMS);
    if ("ok" in r) return r;
    const listed = db.prepare(`SELECT ref, seasonal FROM communism_items ci WHERE node_id = ? AND ref IN (${r.refs.map(() => "?").join(", ")})
      AND NOT ${IN_MEETING} AND NOT ${REQUEST_HOLDS("NULL")} AND NOT ${PASSING}`).all(nodeId, ...r.refs) as { ref: string; seasonal: number }[];
    for (const ref of r.refs) if (!listed.some((l) => l.ref === ref)) return refuse(409, `refs: ${ref} is not listed on that node any more, or someone asked for it first`);
    const halves = new Set(listed.map((l) => l.seasonal));
    if (halves.size > 1) return refuse(400, "refs: pick items from one pool half at a time");
    seasonal = !!listed[0].seasonal;
    refs = r.refs;
  } else if (kind === "offer-create") {
    const r = parseRefs(input.refs, limits.maxItemsPerSide);
    if ("ok" in r) return r;
    refs = r.refs;
    const w = parseWant(input.want, limits.maxItemsPerSide);
    if ("ok" in w) return w;
    want = w.want;
  } else if (kind === "communism-take") {
    const c = input.communism;
    if (!c || typeof c.nodeId !== "string" || !c.nodeId || typeof c.ref !== "string" || !REF_RE.test(c.ref)) return refuse(400, "communism: which listed item?");
    if (c.nodeId === nodeId) return refuse(409, "that item is on this node already");
    const listed = db.prepare(`SELECT ci.item_id, ci.seasonal, n.last_seen_at, n.frozen, (${REQUEST_HOLDS("NULL")} OR ${PASSING}) AS held FROM communism_items ci JOIN nodes n ON n.id = ci.node_id WHERE ci.node_id = ? AND ci.ref = ?`).get(c.nodeId, c.ref) as { item_id: string; seasonal: number; last_seen_at: number | null; frozen: number; held: number } | undefined;
    if (!listed) return refuse(404, "that item is not listed any more");
    if (listed.held) return refuse(409, "someone asked for that item first");
    if (!online(listed, now)) return refuse(409, "the contributor's node is offline right now");
    seasonal = !!listed.seasonal;
    refs = [c.ref];
    communismNodeId = c.nodeId;
  } else if (kind === "communism-give") {
    const c = input.communism;
    if (!c || typeof c.nodeId !== "string" || !c.nodeId) return refuse(400, "communism: which node's communism?");
    if (c.nodeId === nodeId) return refuse(409, "that is this node's own communism");
    const r = parseRefs(input.refs, MAX_TRADE_ITEMS);
    if ("ok" in r) return r;
    const target = db.prepare("SELECT last_seen_at, frozen FROM nodes WHERE id = ? AND unlinked_at IS NULL").get(c.nodeId) as { last_seen_at: number | null; frozen: number } | undefined;
    if (!target) return refuse(404, "no such node");
    if (!online(target, now)) return refuse(409, "that node is offline right now");
    if (!accountWithRoom(db, c.nodeId, seasonal, r.refs.length)) return refuse(409, `that node's ${seasonal ? "seasonal" : "non-seasonal"} communism has no account with room for ${r.refs.length} item${r.refs.length === 1 ? "" : "s"}`);
    refs = r.refs;
    communismNodeId = c.nodeId;
  } else {
    if (!isInt(input.offerId, 1, Number.MAX_SAFE_INTEGER)) return refuse(400, "offerId must be an offer id");
    const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(input.offerId) as OfferRow | undefined;
    if (kind === "offer-accept") {
      if (!o || o.status !== "open") return refuse(o ? 409 : 404, o ? `offer is ${o.status}` : "no such offer");
      if (o.node_id === nodeId) return refuse(409, "that offer is from this node");
      if (offerHeldBy(db, o) !== null) return refuse(409, HELD_OFFER);
      seasonal = !!o.seasonal;
      if (input.refs !== undefined) {
        const r = parseRefs(input.refs, limits.maxItemsPerSide);
        if ("ok" in r) return r;
        refs = r.refs;
      }
    } else {
      if (!o || o.node_id !== nodeId) return refuse(404, "no such offer of yours");
      if (o.status !== "open") return refuse(409, `offer is ${o.status}`);
      seasonal = !!o.seasonal;
    }
    offerId = o.id;
  }

  // Waiting its turn behind the person's previous trade: only an open request of theirs, else it goes out at once.
  let afterId: number | null = null;
  if (input.after !== undefined && (kind === "deposit" || kind === "withdraw")) {
    const prev = db.prepare("SELECT id, state FROM guest_requests WHERE id = ? AND user_id = ?").get(input.after, user.id) as { id: number; state: GuestRequestState } | undefined;
    if (!prev) return refuse(400, "after: no such request of yours");
    if (prev.state === "pending" || prev.state === "taken") afterId = prev.id;
  }
  const r = db.prepare(`INSERT INTO guest_requests (node_id, user_id, ign, kind, seasonal, server, count, refs_json, want_json, offer_id, communism_node_id, state, created_at, after_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
    nodeId, user.id, ign, kind, seasonal ? 1 : 0, server, count, refs === null ? null : JSON.stringify(refs), want === null ? null : JSON.stringify(want), offerId, communismNodeId, now, afterId);
  const row = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(r.lastInsertRowid) as RequestJoin;
  if (afterId === null) wakeNode(nodeId);
  return { ok: true, request: requestWire(row) };
}

/** A person's requests across every node, newest first: every one still open, and the latest `finished` of the rest. Also sweeps. */
export function recentRequestsFor(db: Db, userId: number, finished = 20, now = Date.now()): RequestView[] {
  sweepGuestRequests(db, now);
  const rows = db.prepare(`${REQUEST_SELECT} WHERE r.user_id = ? AND (r.state IN ('pending', 'taken') OR r.id IN (
      SELECT id FROM guest_requests WHERE user_id = ? AND state NOT IN ('pending', 'taken') ORDER BY created_at DESC, id DESC LIMIT ?))
    ORDER BY r.created_at DESC, r.id DESC`).all(userId, userId, finished) as RequestJoin[];
  return rows.map(requestWire);
}

/** Where a request waits for an earlier one, it may go out once that closed (its turn: `ready_at`). */
const READY = "(r.after_id IS NULL OR r.ready_at IS NOT NULL)";

/** A request closed: the one waiting behind it may go out now, and its node hears at once. */
function releaseNext(db: Db, closedId: number, now: number): void {
  const next = db.prepare("SELECT id, node_id FROM guest_requests WHERE after_id = ? AND ready_at IS NULL AND state = 'pending'").all(closedId) as { id: number; node_id: string }[];
  for (const n of next) {
    db.prepare("UPDATE guest_requests SET ready_at = ? WHERE id = ?").run(now, n.id);
    wakeNode(n.node_id);
  }
}

/**
 * The node's poll: every pending request whose turn it is becomes `taken` and is handed over, oldest first; so is one
 * handed out before that the node never answered within TAKE_LEASE_MS (the reply may not have reached it).
 */
export function takePendingRequests(db: Db, node: NodeRow, now = Date.now()): GuestRequestWire[] {
  sweepGuestRequests(db, now);
  return db.transaction(() => {
    const rows = db.prepare(`${REQUEST_SELECT} WHERE r.node_id = ? AND ${READY}
      AND (r.state = 'pending' OR (r.state = 'taken' AND r.result_json IS NULL AND r.taken_at <= ?)) ORDER BY r.created_at, r.id`).all(node.id, now - TAKE_LEASE_MS) as RequestJoin[];
    const take = db.prepare("UPDATE guest_requests SET state = 'taken', taken_at = ? WHERE id = ? AND state IN ('pending', 'taken')");
    for (const r of rows) {
      take.run(now, r.id);
      r.state = "taken";
      r.taken_at = now;
    }
    let held: string[] | null = null;
    return rows.map((r) => {
      const { nodeName: _n, ...wire } = requestWire(r);
      // A withdraw by count: what other requests here hold, so the node's pick does not take it from under them.
      if (wire.kind === "withdraw" && !wire.refs?.length && wire.want?.length) wire.held = held ??= heldRefsOf(db, node.id);
      return wire;
    });
  })();
}

function parseResult(raw: unknown): { result: GuestRequestResult } | Refusal {
  if (!raw || typeof raw !== "object") return refuse(400, "bad json");
  const res = raw as Partial<GuestRequestResult>;
  if (typeof res.ok !== "boolean") return refuse(400, "ok must be a boolean");
  if (res.pending !== undefined && typeof res.pending !== "boolean") return refuse(400, "pending must be a boolean");
  if (res.error !== undefined && typeof res.error !== "string") return refuse(400, "error must be a string");
  if (res.detail !== undefined && typeof res.detail !== "string") return refuse(400, "detail must be a string");
  if (res.requestId !== undefined && !isInt(res.requestId, 0, Number.MAX_SAFE_INTEGER)) return refuse(400, "requestId must be an integer");
  if (res.offerId !== undefined && !isInt(res.offerId, 0, Number.MAX_SAFE_INTEGER)) return refuse(400, "offerId must be an integer");
  if (res.botIgn !== undefined && (typeof res.botIgn !== "string" || !IGN_RE.test(res.botIgn))) return refuse(400, "botIgn: letters only, 1..32");
  const result: GuestRequestResult = { ok: res.ok };
  if (res.pending) result.pending = true;
  if (res.error !== undefined) result.error = res.error.slice(0, 200);
  if (res.detail !== undefined) result.detail = res.detail.slice(0, 400);
  if (res.requestId !== undefined) result.requestId = res.requestId;
  if (res.offerId !== undefined) result.offerId = res.offerId;
  if (res.botIgn !== undefined) result.botIgn = res.botIgn;
  return { result };
}

/**
 * The node's word on a request. A report with `pending: true` is a progress
 * note: the request stays open (`taken`) and shows the note; nodes may post
 * several. A report without it closes the request as done or failed.
 */
export function submitResult(db: Db, node: NodeRow, id: number, raw: unknown, now = Date.now()): Result<{ state: GuestRequestState }> {
  const r = db.prepare("SELECT * FROM guest_requests WHERE id = ? AND node_id = ?").get(id, node.id) as GuestRequestRow | undefined;
  if (!r) return refuse(404, "no such request");
  if (r.state !== "pending" && r.state !== "taken") return refuse(409, `request is ${r.state}`);
  const parsed = parseResult(raw);
  if ("ok" in parsed) return parsed;
  const { result } = parsed;
  const what = `${r.kind.replace("-", " ")} on node "${node.name}"`;
  const said = (result.detail ?? result.error ?? "").trim();
  if (result.pending) {
    db.prepare("UPDATE guest_requests SET state = 'taken', taken_at = COALESCE(taken_at, ?), progress_at = ?, result_json = ? WHERE id = ?").run(now, now, JSON.stringify(result), id);
    // A note worth hearing once: the bot to /trade, or a new word from the node.
    const before = r.result_json === null ? null : (JSON.parse(r.result_json) as GuestRequestResult);
    const news = result.botIgn !== before?.botIgn || said !== (before?.detail ?? before?.error ?? "").trim();
    if (news) emit(db, { users: [r.user_id], kind: "request-progress", tone: "accent", notify: !!result.botIgn && result.botIgn !== before?.botIgn, href: "/me",
      text: `Your ${what}${result.botIgn ? `: /trade ${result.botIgn} on ${r.server ?? "the server you chose"}` : ""}${said ? ` (${said})` : ""}.` }, now);
    return { ok: true, state: "taken" };
  }
  const state: GuestRequestState = result.ok ? "done" : "failed";
  db.prepare("UPDATE guest_requests SET state = ?, result_json = ? WHERE id = ?").run(state, JSON.stringify(result), id);
  releaseNext(db, id, now);
  emit(db, { users: [r.user_id], kind: `request-${state}`, tone: result.ok ? "good" : "bad", notify: true, href: "/me",
    text: `Your ${what} ${result.ok ? "is done" : "failed"}${said ? `: ${said}` : "."}` }, now);
  return { ok: true, state };
}

/**
 * A request still pending or taken half an hour after it was queued is
 * expired; one that waited its turn behind another counts from its turn, and
 * does not age while it waits; one its node is working on counts from the
 * node's last progress note.
 */
export function sweepGuestRequests(db: Db, now = Date.now()): void {
  const due = db.prepare(`SELECT id FROM guest_requests r WHERE state IN ('pending', 'taken') AND ${READY} AND MAX(COALESCE(progress_at, 0), COALESCE(ready_at, created_at)) <= ?`).all(now - GUEST_REQUEST_TTL_MS) as { id: number }[];
  if (!due.length) return;
  db.transaction(() => {
    for (const d of due) {
      db.prepare("UPDATE guest_requests SET state = 'expired' WHERE id = ?").run(d.id);
      releaseNext(db, d.id, now);
    }
  })();
}

/**
 * A node is going away (unlinked): every open request queued for it, and every
 * open take or give that names it as the other communism, fails with `why`;
 * a request waiting behind one of them goes out.
 */
export function failRequestsFor(db: Db, nodeId: string, why: string, now = Date.now()): void {
  const rows = db.prepare("SELECT id, user_id, kind FROM guest_requests WHERE state IN ('pending', 'taken') AND (node_id = ? OR communism_node_id = ?)").all(nodeId, nodeId) as { id: number; user_id: number; kind: string }[];
  for (const r of rows) {
    db.prepare("UPDATE guest_requests SET state = 'failed', result_json = ? WHERE id = ?").run(JSON.stringify({ ok: false, error: why } satisfies GuestRequestResult), r.id);
    releaseNext(db, r.id, now);
    emit(db, { users: [r.user_id], kind: "request-failed", tone: "bad", notify: true, href: "/me", text: `Your ${r.kind.replace("-", " ")} request #${r.id} failed: ${why}.` }, now);
  }
}
