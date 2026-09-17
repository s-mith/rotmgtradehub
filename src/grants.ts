// Phase 4b of docs/hub-protocol.md: shared vaults. A grant says which hub
// user may keep items in a node's vault, under which IGN, with how many
// slots and which rights. The node mirrors grants, publishes what each
// guest's vault holds (catalog ids and its own refs, never an instance),
// and executes the requests guests queue here from the website. The hub
// only checks the rules it can check: the grant, the role, the published
// free slots and refs.
import type {
  CreateGrantRequest, GrantRole, GrantWire, GuestRequestKind, GuestRequestResult, GuestRequestState, GuestRequestWire, GuestVaultHalfWire, PublishVaultsRequest, UpdateGrantRequest, WantLineWire,
} from "rotmgtradenode/shared/hubWire";
import type { User } from "./auth";
import type { Db } from "./db";
import type { NodeRow } from "./nodes";
import { IGN_RE, REF_RE, SERVER_RE, isInt, limitsFor, parseWant, refuse, type OfferRow, type Refusal, type Result } from "./offers";

/** A request nobody took, or took and never answered, within this long is expired. */
export const GUEST_REQUEST_TTL_MS = 30 * 60 * 1000;
/** A node whose last heartbeat is older than this shows as offline to its guests (heartbeats are a minute apart). */
export const NODE_ONLINE_MS = 3 * 60 * 1000;
export const MAX_SLOTS = 200;
/** A guest may have this many unanswered requests per node. */
export const MAX_OPEN_REQUESTS = 10;
export const ROLES: readonly GrantRole[] = ["deposit", "withdraw-own", "withdraw-any", "co-owner"];
export const KINDS: readonly GuestRequestKind[] = ["deposit", "withdraw", "offer-create", "offer-accept", "offer-cancel"];
const WITHDRAW_ROLES: readonly GrantRole[] = ["withdraw-own", "withdraw-any", "co-owner"];

// --- rows -------------------------------------------------------------------

export interface GrantRow {
  id: number;
  node_id: string;
  user_id: number;
  ign: string;
  slots_seasonal: number;
  slots_nonseasonal: number;
  role: GrantRole;
  trade: number;
  paused: number;
  created_at: number;
  updated_at: number;
}

interface GuestVaultRow {
  node_id: string;
  user_id: number;
  seasonal: number;
  slots: number;
  used: number;
  items_json: string;
  updated_at: number;
}

interface GuestRequestRow {
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
  state: GuestRequestState;
  created_at: number;
  taken_at: number | null;
  result_json: string | null;
}

type GrantWithGuest = GrantRow & { display_name: string; email: string };

function grantWire(g: GrantWithGuest, withEmail: boolean): GrantWire {
  return {
    id: g.id,
    nodeId: g.node_id,
    guest: withEmail ? { userId: g.user_id, displayName: g.display_name, email: g.email } : { userId: g.user_id, displayName: g.display_name },
    ign: g.ign,
    slotsSeasonal: g.slots_seasonal,
    slotsNonseasonal: g.slots_nonseasonal,
    role: g.role,
    trade: !!g.trade,
    paused: !!g.paused,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

function grantById(db: Db, nodeId: string, id: number): GrantWithGuest | undefined {
  return db.prepare("SELECT g.*, u.display_name, u.email FROM grants g JOIN users u ON u.id = g.user_id WHERE g.id = ? AND g.node_id = ?").get(id, nodeId) as GrantWithGuest | undefined;
}

function grantFor(db: Db, nodeId: string, userId: number): GrantRow | undefined {
  return db.prepare("SELECT * FROM grants WHERE node_id = ? AND user_id = ?").get(nodeId, userId) as GrantRow | undefined;
}

function requestWire(r: GuestRequestRow & { display_name: string }): GuestRequestWire {
  return {
    id: r.id,
    nodeId: r.node_id,
    guest: { userId: r.user_id, displayName: r.display_name },
    ign: r.ign,
    kind: r.kind,
    seasonal: !!r.seasonal,
    server: r.server,
    count: r.count,
    refs: r.refs_json === null ? null : (JSON.parse(r.refs_json) as string[]),
    want: r.want_json === null ? null : (JSON.parse(r.want_json) as WantLineWire[]),
    offerId: r.offer_id,
    state: r.state,
    createdAt: r.created_at,
    result: r.result_json === null ? null : (JSON.parse(r.result_json) as GuestRequestWire["result"]),
  };
}

const REQUEST_SELECT = "SELECT r.*, u.display_name FROM guest_requests r JOIN users u ON u.id = r.user_id";

// --- validation -------------------------------------------------------------

type Fields = Partial<Pick<CreateGrantRequest, "ign" | "slotsSeasonal" | "slotsNonseasonal" | "role" | "trade">>;

/** Checks whichever grant fields are present; `required` demands all of them. */
function checkFields(req: Fields, required: boolean): Refusal | null {
  const has = (k: keyof Fields) => req[k] !== undefined;
  if ((required || has("ign")) && (typeof req.ign !== "string" || !IGN_RE.test(req.ign))) return refuse(400, "ign: letters only, 1..32");
  if ((required || has("slotsSeasonal")) && !isInt(req.slotsSeasonal, 0, MAX_SLOTS)) return refuse(400, `slotsSeasonal must be 0..${MAX_SLOTS}`);
  if ((required || has("slotsNonseasonal")) && !isInt(req.slotsNonseasonal, 0, MAX_SLOTS)) return refuse(400, `slotsNonseasonal must be 0..${MAX_SLOTS}`);
  if ((required || has("role")) && !ROLES.includes(req.role as GrantRole)) return refuse(400, `role must be one of ${ROLES.join(", ")}`);
  if ((required || has("trade")) && typeof req.trade !== "boolean") return refuse(400, "trade must be a boolean");
  return null;
}

function parseHalf(raw: unknown, what: string): { half: GuestVaultHalfWire } | Refusal {
  if (!raw || typeof raw !== "object") return refuse(400, `${what}: bad half`);
  const h = raw as Partial<GuestVaultHalfWire>;
  if (!isInt(h.slots, 0, MAX_SLOTS)) return refuse(400, `${what}.slots must be 0..${MAX_SLOTS}`);
  if (!isInt(h.used, 0, MAX_SLOTS)) return refuse(400, `${what}.used must be 0..${MAX_SLOTS}`);
  if (!Array.isArray(h.items) || h.items.length > MAX_SLOTS) return refuse(400, `${what}.items: up to ${MAX_SLOTS} items`);
  const items: GuestVaultHalfWire["items"] = [];
  const refs = new Set<string>();
  for (const it of h.items as Partial<GuestVaultHalfWire["items"][number]>[]) {
    if (!it || typeof it !== "object") return refuse(400, `${what}.items: bad item`);
    if (typeof it.ref !== "string" || !REF_RE.test(it.ref)) return refuse(400, `${what}.items: bad ref`);
    if (refs.has(it.ref)) return refuse(400, `${what}.items: duplicate ref ${it.ref}`);
    refs.add(it.ref);
    if (typeof it.itemId !== "string" || it.itemId.length < 1 || it.itemId.length > 64) return refuse(400, `${what}.items: bad itemId`);
    if (typeof it.name !== "string" || it.name.length > 80) return refuse(400, `${what}.items: bad name`);
    if (!isInt(it.count, 0, 8)) return refuse(400, `${what}.items: count must be 0..8`);
    if (it.enchants !== null && (!Array.isArray(it.enchants) || it.enchants.length > 8 || !it.enchants.every((e) => typeof e === "number" && Number.isInteger(e)))) return refuse(400, `${what}.items: enchants must be null or integers`);
    if (typeof it.online !== "boolean") return refuse(400, `${what}.items: online must be a boolean`);
    items.push({ ref: it.ref, itemId: it.itemId, name: it.name, enchants: it.enchants === null ? null : [...it.enchants], count: it.count, online: it.online });
  }
  return { half: { slots: h.slots, used: h.used, items } };
}

// --- grants (node-signed) ---------------------------------------------------

export function createGrant(db: Db, node: NodeRow, req: CreateGrantRequest, now = Date.now()): Result<{ grant: GrantWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  if (typeof req.email !== "string") return refuse(400, "email must be a string");
  const guest = db.prepare("SELECT id FROM users WHERE email = ?").get(req.email.trim().toLowerCase()) as { id: number } | undefined;
  if (!guest) return refuse(404, "no account with that email");
  if (guest.id === node.user_id) return refuse(400, "that is this node's own owner");
  const bad = checkFields(req, true);
  if (bad) return bad;
  if (grantFor(db, node.id, guest.id)) return refuse(409, "that account already has a grant on this node");
  const r = db.prepare(`INSERT INTO grants (node_id, user_id, ign, slots_seasonal, slots_nonseasonal, role, trade, paused, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(node.id, guest.id, req.ign, req.slotsSeasonal, req.slotsNonseasonal, req.role, req.trade ? 1 : 0, now, now);
  return { ok: true, grant: grantWire(grantById(db, node.id, Number(r.lastInsertRowid))!, true) };
}

export function listGrants(db: Db, node: NodeRow): GrantWire[] {
  const rows = db.prepare("SELECT g.*, u.display_name, u.email FROM grants g JOIN users u ON u.id = g.user_id WHERE g.node_id = ? ORDER BY g.created_at, g.id").all(node.id) as GrantWithGuest[];
  return rows.map((g) => grantWire(g, true));
}

export function updateGrant(db: Db, node: NodeRow, id: number, req: UpdateGrantRequest, now = Date.now()): Result<{ grant: GrantWire }> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  const g = grantById(db, node.id, id);
  if (!g) return refuse(404, "no such grant");
  const bad = checkFields(req, false);
  if (bad) return bad;
  if (req.paused !== undefined && typeof req.paused !== "boolean") return refuse(400, "paused must be a boolean");
  db.prepare("UPDATE grants SET ign = ?, slots_seasonal = ?, slots_nonseasonal = ?, role = ?, trade = ?, paused = ?, updated_at = ? WHERE id = ?").run(
    req.ign ?? g.ign, req.slotsSeasonal ?? g.slots_seasonal, req.slotsNonseasonal ?? g.slots_nonseasonal, req.role ?? g.role,
    req.trade === undefined ? g.trade : req.trade ? 1 : 0, req.paused === undefined ? g.paused : req.paused ? 1 : 0, now, id);
  return { ok: true, grant: grantWire(grantById(db, node.id, id)!, true) };
}

/** Revokes: the grant, what was published for that guest, and any request of theirs still waiting. */
export function deleteGrant(db: Db, node: NodeRow, id: number): Result<Record<never, never>> {
  const g = grantById(db, node.id, id);
  if (!g) return refuse(404, "no such grant");
  db.transaction(() => {
    db.prepare("DELETE FROM grants WHERE id = ?").run(id);
    db.prepare("DELETE FROM guest_vaults WHERE node_id = ? AND user_id = ?").run(node.id, g.user_id);
    db.prepare("UPDATE guest_requests SET state = 'expired' WHERE node_id = ? AND user_id = ? AND state IN ('pending', 'taken')").run(node.id, g.user_id);
  })();
  return { ok: true };
}

// --- published vaults -------------------------------------------------------

/** Replaces everything the node published before. Guests without a grant are ignored, not an error. */
export function publishVaults(db: Db, node: NodeRow, req: PublishVaultsRequest, now = Date.now()): Result<Record<never, never>> {
  if (!req || typeof req !== "object") return refuse(400, "bad json");
  if (!Array.isArray(req.guests) || req.guests.length > 500) return refuse(400, "guests: up to 500 entries");
  const at = typeof req.at === "number" && Number.isFinite(req.at) && req.at > 0 ? Math.round(req.at) : now;
  const parsed: { userId: number; seasonal: GuestVaultHalfWire; nonseasonal: GuestVaultHalfWire }[] = [];
  for (const g of req.guests as Partial<PublishVaultsRequest["guests"][number]>[]) {
    if (!g || typeof g !== "object" || !isInt(g.userId, 1, Number.MAX_SAFE_INTEGER)) return refuse(400, "guests: bad userId");
    const s = parseHalf(g.seasonal, `guest ${g.userId} seasonal`);
    if ("ok" in s) return s;
    const n = parseHalf(g.nonseasonal, `guest ${g.userId} nonseasonal`);
    if ("ok" in n) return n;
    parsed.push({ userId: g.userId, seasonal: s.half, nonseasonal: n.half });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM guest_vaults WHERE node_id = ?").run(node.id);
    const ins = db.prepare("INSERT INTO guest_vaults (node_id, user_id, seasonal, slots, used, items_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const g of parsed) {
      if (!grantFor(db, node.id, g.userId)) continue;
      ins.run(node.id, g.userId, 1, g.seasonal.slots, g.seasonal.used, JSON.stringify(g.seasonal.items), at);
      ins.run(node.id, g.userId, 0, g.nonseasonal.slots, g.nonseasonal.used, JSON.stringify(g.nonseasonal.items), at);
    }
  })();
  return { ok: true };
}

// --- the guest's view (website) ---------------------------------------------

export interface HalfView {
  /** Slots the grant gives. */
  granted: number;
  /** Slots and items as the node last published (slots is `granted` unless the node applied something else). */
  slots: number;
  used: number;
  items: GuestVaultHalfWire["items"];
  publishedAt: number | null;
}

export interface GuestVaultView {
  nodeId: string;
  nodeName: string;
  owner: string;
  lastSeenAt: number | null;
  online: boolean;
  ign: string;
  role: GrantRole;
  trade: boolean;
  paused: boolean;
  seasonal: HalfView;
  nonseasonal: HalfView;
}

type GrantJoin = GrantRow & { node_name: string; owner: string; last_seen_at: number | null };

function halfView(db: Db, g: GrantRow, seasonal: boolean): HalfView {
  const granted = seasonal ? g.slots_seasonal : g.slots_nonseasonal;
  const row = db.prepare("SELECT * FROM guest_vaults WHERE node_id = ? AND user_id = ? AND seasonal = ?").get(g.node_id, g.user_id, seasonal ? 1 : 0) as GuestVaultRow | undefined;
  if (!row) return { granted, slots: granted, used: 0, items: [], publishedAt: null };
  return { granted, slots: row.slots, used: row.used, items: JSON.parse(row.items_json) as GuestVaultHalfWire["items"], publishedAt: row.updated_at };
}

function vaultView(db: Db, g: GrantJoin, now: number): GuestVaultView {
  return {
    nodeId: g.node_id,
    nodeName: g.node_name,
    owner: g.owner,
    lastSeenAt: g.last_seen_at,
    online: g.last_seen_at !== null && now - g.last_seen_at <= NODE_ONLINE_MS,
    ign: g.ign,
    role: g.role,
    trade: !!g.trade,
    paused: !!g.paused,
    seasonal: halfView(db, g, true),
    nonseasonal: halfView(db, g, false),
  };
}

const GRANT_JOIN = "SELECT g.*, n.name AS node_name, n.last_seen_at, u.display_name AS owner FROM grants g JOIN nodes n ON n.id = g.node_id JOIN users u ON u.id = n.user_id";

/** Every vault the user is a guest of. */
export function guestVaultsFor(db: Db, userId: number, now = Date.now()): GuestVaultView[] {
  const rows = db.prepare(`${GRANT_JOIN} WHERE g.user_id = ? ORDER BY g.created_at, g.id`).all(userId) as GrantJoin[];
  return rows.map((g) => vaultView(db, g, now));
}

export function guestVaultOf(db: Db, userId: number, nodeId: string, now = Date.now()): GuestVaultView | null {
  const g = db.prepare(`${GRANT_JOIN} WHERE g.user_id = ? AND g.node_id = ?`).get(userId, nodeId) as GrantJoin | undefined;
  return g ? vaultView(db, g, now) : null;
}

// --- guest requests ---------------------------------------------------------

/** What the website (or any guest-side caller) hands in; everything is checked here. */
export interface GuestRequestInput {
  kind: string;
  seasonal?: boolean;
  server?: string;
  count?: number;
  refs?: string[];
  want?: unknown;
  offerId?: number;
}

function parseRefs(raw: unknown, published: GuestVaultHalfWire["items"], max: number): { refs: string[] } | Refusal {
  if (!Array.isArray(raw) || raw.length < 1) return refuse(400, "refs: pick at least one item");
  if (raw.length > max) return refuse(409, `refs: at most ${max} items at a time`);
  const seen = new Set<string>();
  const have = new Set(published.map((it) => it.ref));
  for (const r of raw) {
    if (typeof r !== "string" || !REF_RE.test(r)) return refuse(400, "refs: bad ref");
    if (seen.has(r)) return refuse(400, `refs: duplicate ${r}`);
    if (!have.has(r)) return refuse(409, `refs: ${r} is not in your vault as last published`);
    seen.add(r);
  }
  return { refs: [...seen] };
}

function openRequestsOf(db: Db, nodeId: string, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE node_id = ? AND user_id = ? AND state IN ('pending', 'taken')").get(nodeId, userId) as { n: number }).n;
}

export function createGuestRequest(db: Db, user: Pick<User, "id">, nodeId: string, input: GuestRequestInput, now = Date.now()): Result<{ request: GuestRequestWire }> {
  sweepGuestRequests(db, now);
  const g = grantFor(db, nodeId, user.id);
  if (!g) return refuse(404, "you have no vault on that node");
  if (g.paused) return refuse(403, "the owner paused your access to this vault");
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRow | undefined;
  if (!node) return refuse(404, "that node is gone");
  const kind = input.kind as GuestRequestKind;
  if (!KINDS.includes(kind)) return refuse(400, `kind must be one of ${KINDS.join(", ")}`);
  if (openRequestsOf(db, nodeId, user.id) >= MAX_OPEN_REQUESTS) return refuse(409, `you already have ${MAX_OPEN_REQUESTS} requests waiting on this node`);

  let seasonal: boolean;
  let server: string | null = null;
  let count: number | null = null;
  let refs: string[] | null = null;
  let want: WantLineWire[] | null = null;
  let offerId: number | null = null;
  const needsServer = kind === "deposit" || kind === "withdraw" || kind === "offer-create";
  if (needsServer) {
    if (typeof input.seasonal !== "boolean") return refuse(400, "seasonal must be a boolean");
    seasonal = input.seasonal;
    if (typeof input.server !== "string" || !SERVER_RE.test(input.server)) return refuse(400, "server: letters and digits, 1..24");
    server = input.server;
  } else {
    seasonal = false; // replaced by the offer's below
  }
  const half = () => halfView(db, g, seasonal);
  const limits = limitsFor(db, node);

  if (kind === "deposit") {
    if (!isInt(input.count, 1, 24)) return refuse(400, "count must be 1..24");
    const h = half();
    const free = Math.max(0, h.slots - h.used);
    if (input.count > free) return refuse(409, `only ${free} free slot${free === 1 ? "" : "s"} in that half as last published`);
    count = input.count;
  } else if (kind === "withdraw") {
    if (!WITHDRAW_ROLES.includes(g.role)) return refuse(403, "your grant only allows deposits");
    const r = parseRefs(input.refs, half().items, 24);
    if ("ok" in r) return r;
    refs = r.refs;
  } else if (kind === "offer-create") {
    if (!g.trade) return refuse(403, "your grant does not allow trading");
    const r = parseRefs(input.refs, half().items, limits.maxItemsPerSide);
    if ("ok" in r) return r;
    refs = r.refs;
    const w = parseWant(input.want, limits.maxItemsPerSide);
    if ("ok" in w) return w;
    want = w.want;
  } else {
    if (!g.trade) return refuse(403, "your grant does not allow trading");
    if (!isInt(input.offerId, 1, Number.MAX_SAFE_INTEGER)) return refuse(400, "offerId must be an offer id");
    const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(input.offerId) as OfferRow | undefined;
    if (kind === "offer-accept") {
      if (!o || o.status !== "open") return refuse(o ? 409 : 404, o ? `offer is ${o.status}` : "no such offer");
      if (o.node_id === nodeId) return refuse(409, "that offer is from this node");
      seasonal = !!o.seasonal;
      if (input.refs !== undefined) {
        const r = parseRefs(input.refs, half().items, limits.maxItemsPerSide);
        if ("ok" in r) return r;
        refs = r.refs;
      }
    } else {
      if (!o || o.node_id !== nodeId || o.for_user_id !== user.id) return refuse(404, "no such offer of yours");
      if (o.status !== "open") return refuse(409, `offer is ${o.status}`);
      seasonal = !!o.seasonal;
    }
    offerId = o.id;
  }

  const r = db.prepare(`INSERT INTO guest_requests (node_id, user_id, ign, kind, seasonal, server, count, refs_json, want_json, offer_id, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    nodeId, user.id, g.ign, kind, seasonal ? 1 : 0, server, count, refs === null ? null : JSON.stringify(refs), want === null ? null : JSON.stringify(want), offerId, now);
  const row = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(r.lastInsertRowid) as GuestRequestRow & { display_name: string };
  return { ok: true, request: requestWire(row) };
}

/** The guest's latest requests on one node, newest first. */
export function recentRequestsFor(db: Db, userId: number, nodeId: string, limit = 20, now = Date.now()): GuestRequestWire[] {
  sweepGuestRequests(db, now);
  const rows = db.prepare(`${REQUEST_SELECT} WHERE r.user_id = ? AND r.node_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(userId, nodeId, limit) as (GuestRequestRow & { display_name: string })[];
  return rows.map(requestWire);
}

/** The node's poll: every pending request becomes `taken` and is handed over, oldest first. */
export function takePendingRequests(db: Db, node: NodeRow, now = Date.now()): GuestRequestWire[] {
  sweepGuestRequests(db, now);
  return db.transaction(() => {
    const rows = db.prepare(`${REQUEST_SELECT} WHERE r.node_id = ? AND r.state = 'pending' ORDER BY r.created_at, r.id`).all(node.id) as (GuestRequestRow & { display_name: string })[];
    const take = db.prepare("UPDATE guest_requests SET state = 'taken', taken_at = ? WHERE id = ? AND state = 'pending'");
    for (const r of rows) {
      take.run(now, r.id);
      r.state = "taken";
      r.taken_at = now;
    }
    return rows.map(requestWire);
  })();
}

export function submitResult(db: Db, node: NodeRow, id: number, raw: unknown): Result<{ state: GuestRequestState }> {
  const r = db.prepare("SELECT * FROM guest_requests WHERE id = ? AND node_id = ?").get(id, node.id) as GuestRequestRow | undefined;
  if (!r) return refuse(404, "no such request");
  if (r.state !== "pending" && r.state !== "taken") return refuse(409, `request is ${r.state}`);
  if (!raw || typeof raw !== "object") return refuse(400, "bad json");
  const res = raw as Partial<GuestRequestResult>;
  if (typeof res.ok !== "boolean") return refuse(400, "ok must be a boolean");
  if (res.error !== undefined && typeof res.error !== "string") return refuse(400, "error must be a string");
  if (res.detail !== undefined && typeof res.detail !== "string") return refuse(400, "detail must be a string");
  if (res.requestId !== undefined && !isInt(res.requestId, 0, Number.MAX_SAFE_INTEGER)) return refuse(400, "requestId must be an integer");
  if (res.offerId !== undefined && !isInt(res.offerId, 0, Number.MAX_SAFE_INTEGER)) return refuse(400, "offerId must be an integer");
  const result: GuestRequestResult = { ok: res.ok };
  if (res.error !== undefined) result.error = res.error.slice(0, 200);
  if (res.detail !== undefined) result.detail = res.detail.slice(0, 400);
  if (res.requestId !== undefined) result.requestId = res.requestId;
  if (res.offerId !== undefined) result.offerId = res.offerId;
  const state: GuestRequestState = res.ok ? "done" : "failed";
  db.prepare("UPDATE guest_requests SET state = ?, result_json = ? WHERE id = ?").run(state, JSON.stringify(result), id);
  return { ok: true, state };
}

/** A request still pending or taken half an hour after it was queued is expired. */
export function sweepGuestRequests(db: Db, now = Date.now()): void {
  db.prepare("UPDATE guest_requests SET state = 'expired' WHERE state IN ('pending', 'taken') AND created_at <= ?").run(now - GUEST_REQUEST_TTL_MS);
}
