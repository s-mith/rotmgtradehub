// Player meetings (docs/hub-protocol.md, "Player meetings"): someone who runs
// no node takes a node's offer with their own character. The hub makes the
// meeting at once (a rendezvous of kind "player": the node gives, the person
// is the taker), the node's bot comes to the server's nexus, the person
// /trades it and puts up what the offer asks for, and the node's receipt
// alone closes it: there is no second node to agree, and the trade window is
// all or nothing for both sides. The person can confirm afterwards or report
// a problem; a report goes to the operator and the node's owner and freezes
// nobody (anyone could make one up).
import type { MeetingProgressWire, MeetingStage, NodeStatusWire, OfferItemWire, WantLineWire } from "rotmgtradenode/shared/hubWire";
import { tradingIgnOf, type User } from "./auth";
import type { Db } from "./db";
import { emit } from "./events";
import { NODE_ONLINE_MS, nodeStatus } from "./nodes";
import { limitsOf } from "./personLimits";
import { HELD_OFFER, MEETING_WITHIN, RENDEZVOUS_MS, SERVER_RE, IGN_RE, knownServer, describeItems, fail, offerHeldBy, offerWant, posterOf, refuse, sweepRendezvous, type OfferRow, type RendezvousRow, type Result } from "./offers";

/** A person has at most this many player meetings under way at once. */
export const MAX_OPEN_PLAYER_MEETINGS = 1;
/**
 * This many meetings failed because the person never came, within
 * NO_SHOW_WINDOW_MS, pause them for NO_SHOW_PAUSE_MS: unless the node whose
 * offer they take says otherwise (its owner sets it in the control panel,
 * NodeStatusWire.players.noShow; a limit of 0 never pauses anyone).
 */
export const NO_SHOW_LIMIT = 2;
export const NO_SHOW_WINDOW_MS = 24 * 3600 * 1000;
export const NO_SHOW_PAUSE_MS = 24 * 3600 * 1000;
// Player meetings started per person per hour, called off or not: DEFAULT_PLAYER_STARTS_PER_HOUR (6) unless the operator
// set the person's own number, or no limit, on the admin page (src/personLimits.ts).
const STAGES: readonly MeetingStage[] = ["queued", "on-the-way", "ready", "trading", "holding", "retry"];

type PlayersStatus = NonNullable<NodeStatusWire["players"]>;

/** Whether a node takes trades with players right now, by its last heartbeat: online, not frozen, and its owner said yes. */
export function playerTradesOf(db: Db, nodeId: string, now = Date.now()): { ok: true; players: PlayersStatus } | { ok: false; why: string } {
  const n = db.prepare("SELECT last_seen_at, frozen FROM nodes WHERE id = ?").get(nodeId) as { last_seen_at: number | null; frozen: number } | undefined;
  if (!n) return { ok: false, why: "no such node" };
  if (n.frozen) return { ok: false, why: "the hub operator has frozen that node" };
  if (n.last_seen_at === null || now - n.last_seen_at > NODE_ONLINE_MS) return { ok: false, why: "that node is offline right now" };
  const players = nodeStatus(db, nodeId)?.players;
  if (!players?.enabled) return { ok: false, why: "that node does not take trades with players" };
  return { ok: true, players };
}

/** Why this person may not start a player meeting with a node now, or null. `noShow`: that node's rule for people who did not come. */
export function playerPause(db: Db, userId: number, noShow: { limit: number; pauseHours: number } = { limit: NO_SHOW_LIMIT, pauseHours: NO_SHOW_PAUSE_MS / 3600_000 }, now = Date.now()): string | null {
  const open = (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'player' AND taker_user_id = ? AND state = 'meet'").get(userId) as { n: number }).n;
  if (open >= MAX_OPEN_PLAYER_MEETINGS) return "you already have a trade in game under way; finish or cancel it first";
  if (noShow.limit > 0 && noShow.pauseHours > 0) {
    const noShows = db.prepare("SELECT closed_at FROM rendezvous WHERE kind = 'player' AND taker_user_id = ? AND no_show = 1 AND closed_at >= ? ORDER BY closed_at DESC").all(userId, now - NO_SHOW_WINDOW_MS) as { closed_at: number }[];
    if (noShows.length >= noShow.limit) {
      const until = noShows[noShow.limit - 1].closed_at + noShow.pauseHours * 3600_000;
      if (until > now) return `you did not come to ${noShows.length} trades in the last day; this node takes trades in game from you again ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
  }
  const perHour = limitsOf(db, userId).playerStartsPerHour;
  const started = perHour === null ? 0 : (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'player' AND taker_user_id = ? AND created_at >= ?").get(userId, now - 3600 * 1000) as { n: number }).n;
  if (perHour !== null && started >= perHour) return `at most ${perHour} trades in game an hour; try again later`;
  return null;
}

/**
 * Take a node's offer with your own character: the meeting starts now, on the
 * offer's server unless the person picks another the node meets on. The offer
 * turns `accepted`; the node picks the meeting up on its next poll.
 */
export function startPlayerMeeting(db: Db, user: Pick<User, "id" | "displayName">, offerId: number, input: { server?: string }, now = Date.now()): Result<{ id: number }> {
  sweepRendezvous(db, now);
  const ign = tradingIgnOf(db, user.id);
  if (!ign) return refuse(403, "set the character you trade with (your IGN) in settings first");
  if (!IGN_RE.test(ign)) return refuse(403, "your IGN is not a character name; fix it in settings");
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(offerId) as OfferRow | undefined;
  if (!o) return refuse(404, "no such offer");
  if (o.status !== "open" || o.expires_at <= now) return refuse(409, "that offer is no longer open");
  if (offerHeldBy(db, o) !== null) return refuse(409, HELD_OFFER);
  const owner = (db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(o.node_id) as { user_id: number } | undefined)?.user_id;
  if (owner === user.id) return refuse(409, "that offer is from your own node");
  const node = playerTradesOf(db, o.node_id, now);
  if (!node.ok) return refuse(409, node.why);
  const pause = playerPause(db, user.id, node.players.noShow, now);
  if (pause) return refuse(409, pause);
  const running = (db.prepare("SELECT COUNT(*) AS n FROM rendezvous WHERE kind = 'player' AND giver_node_id = ? AND state = 'meet'").get(o.node_id) as { n: number }).n;
  if (running >= node.players.maxMeetings) return refuse(409, "that node's bots are busy with other players right now; try again in a few minutes");
  const server = input.server?.trim() || o.server;
  if (!knownServer(server)) return refuse(400, "server: one of the game's servers");
  if (node.players.servers.length && !node.players.servers.includes(server)) return refuse(409, `that node meets on ${node.players.servers.join(", ")}`);
  const id = db.transaction(() => {
    const u = db.prepare("UPDATE offers SET status = 'accepted', taker_node_id = NULL, updated_at = ? WHERE id = ? AND status = 'open'").run(now, offerId);
    if (!u.changes) return null;
    const r = db.prepare(`INSERT INTO rendezvous (offer_id, kind, server, seasonal, state, created_at, deadline_at, giver_node_id, giver_bot_ign, giver_gives_json, taker_node_id, taker_user_id, taker_bot_ign, taker_gives_json)
      VALUES (?, 'player', ?, ?, 'meet', ?, ?, ?, ?, ?, NULL, ?, ?, '[]')`).run(offerId, server, o.seasonal, now, now + RENDEZVOUS_MS, o.node_id, o.bot_ign, o.give_json, user.id, ign);
    return Number(r.lastInsertRowid);
  })();
  if (id === null) return refuse(409, "that offer is no longer open");
  const give = JSON.parse(o.give_json) as OfferItemWire[];
  const want = JSON.parse(o.want_json) as WantLineWire[];
  const wants = describeItems(want.map((w) => ({ itemId: w.itemId, qty: w.qty })));
  emit(db, { users: [owner], kind: "meeting", tone: "accent", notify: true, href: `/meetings/${id}`,
    text: `${user.displayName} (${ign}) is taking your offer #${offerId} in game: ${describeItems(give)} for ${wants}. Your bot ${o.bot_ign} meets them on ${server} ${MEETING_WITHIN}.` }, now);
  emit(db, { users: [user.id], kind: "meeting", tone: "accent", href: `/meetings/${id}`,
    text: `Trade in game #${id}: ${posterOf(db, o.node_id)}'s bot ${o.bot_ign} brings ${describeItems(give)} to the ${server} nexus for your ${wants}. You will be told when it is there.` }, now);
  return { ok: true, id };
}

function playerRow(db: Db, id: number): RendezvousRow | undefined {
  return db.prepare("SELECT * FROM rendezvous WHERE id = ? AND kind = 'player'").get(id) as RendezvousRow | undefined;
}

/** The person calls it off before it happens: the offer is open again and the node lets its bot go. Not a no-show. */
export function cancelPlayerMeeting(db: Db, user: Pick<User, "id">, id: number, now = Date.now()): Result<Record<never, never>> {
  const rv = playerRow(db, id);
  if (!rv || rv.taker_user_id !== user.id) return refuse(404, "no such trade of yours");
  if (rv.state !== "meet") return refuse(409, `that trade is ${rv.state === "done" ? "done" : "already over"}`);
  if (db.prepare("SELECT 1 FROM receipts WHERE rendezvous_id = ? AND ok = 1").get(id)) return refuse(409, "the node reports the trade happened");
  fail(db, rv, "aborted", "called off by the player", now);
  return { ok: true };
}

/** The person says they got their items: a vouch for the node, nothing more. */
export function confirmPlayerMeeting(db: Db, user: Pick<User, "id">, id: number, now = Date.now()): Result<Record<never, never>> {
  const rv = playerRow(db, id);
  if (!rv || rv.taker_user_id !== user.id) return refuse(404, "no such trade of yours");
  if (rv.state !== "done") return refuse(409, "only a finished trade can be confirmed");
  db.prepare("UPDATE rendezvous SET player_confirmed_at = COALESCE(player_confirmed_at, ?) WHERE id = ?").run(now, id);
  return { ok: true };
}

/** The person says something went wrong: kept for the operator, told to the node's owner. It freezes nobody. */
export function reportPlayerMeeting(db: Db, user: Pick<User, "id" | "displayName">, id: number, text: string, now = Date.now()): Result<Record<never, never>> {
  const rv = playerRow(db, id);
  if (!rv || rv.taker_user_id !== user.id) return refuse(404, "no such trade of yours");
  if (rv.state === "meet") return refuse(409, "the trade is still under way; cancel it if you want out");
  const said = text.trim().replace(/\s+/g, " ").slice(0, 500);
  if (said.length < 3) return refuse(400, "say what went wrong");
  db.prepare("UPDATE rendezvous SET player_report = ?, player_report_at = ? WHERE id = ?").run(said, now, id);
  const owner = (db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(rv.giver_node_id) as { user_id: number } | undefined)?.user_id;
  emit(db, { users: [owner], kind: "meeting-report", tone: "bad", notify: true, href: `/meetings/${id}`, text: `${user.displayName} reported a problem with trade in game #${id} on ${rv.server}: "${said}". The hub operator can see it too.` }, now);
  return { ok: true };
}

/** A player meeting's progress, from its node: kept for the page; the moment the bot is in the nexus is worth a notification. */
export function recordProgress(db: Db, node: { id: string }, id: number, raw: unknown, now = Date.now()): Result<Record<never, never>> {
  const rv = db.prepare("SELECT * FROM rendezvous WHERE id = ?").get(id) as RendezvousRow | undefined;
  if (!rv || rv.giver_node_id !== node.id) return refuse(404, "no such rendezvous");
  if (rv.state !== "meet") return refuse(409, `rendezvous is ${rv.state}`);
  const p = parseProgress(raw);
  if ("ok" in p) return p;
  const before = rv.progress_json ? (JSON.parse(rv.progress_json) as MeetingProgressWire) : null;
  const next: MeetingProgressWire = { ...p.progress, at: now };
  db.prepare("UPDATE rendezvous SET progress_json = ? WHERE id = ?").run(JSON.stringify(next), id);
  if (rv.kind === "player" && next.stage === "ready" && before?.stage !== "ready") {
    emit(db, { users: [rv.taker_user_id], kind: "meeting-ready", tone: "accent", notify: true, href: `/meetings/${id}`,
      text: `${next.botIgn ?? rv.giver_bot_ign} is in the ${next.server ?? rv.server} nexus for your trade: /trade ${next.botIgn ?? rv.giver_bot_ign}` }, now);
  }
  return { ok: true };
}

function parseProgress(raw: unknown): { progress: Omit<MeetingProgressWire, "at"> } | ReturnType<typeof refuse> {
  if (!raw || typeof raw !== "object") return refuse(400, "bad json");
  const r = raw as Partial<MeetingProgressWire>;
  if (!STAGES.includes(r.stage as MeetingStage)) return refuse(400, `stage must be one of ${STAGES.join(", ")}`);
  if (typeof r.detail !== "string" || !r.detail.trim()) return refuse(400, "detail: say what is happening");
  if (r.botIgn !== undefined && (typeof r.botIgn !== "string" || !IGN_RE.test(r.botIgn))) return refuse(400, "botIgn: letters only, 1..32");
  if (r.server !== undefined && (typeof r.server !== "string" || !SERVER_RE.test(r.server))) return refuse(400, "server: letters and digits, 1..24");
  return { progress: { stage: r.stage as MeetingStage, detail: r.detail.trim().slice(0, 300), ...(r.botIgn ? { botIgn: r.botIgn } : {}), ...(r.server ? { server: r.server } : {}) } };
}

// --- what the website shows ------------------------------------------------------

export interface PlayerMeetingView {
  id: number;
  offerId: number | null;
  state: RendezvousRow["state"];
  server: string;
  seasonal: boolean;
  createdAt: number;
  deadlineAt: number;
  closedAt: number | null;
  reason: string | null;
  /** The node's side: its owner, its bot, and the exact items it hands over. */
  node: { id: string; name: string; owner: string; ownerId: number | null; botIgn: string; gives: OfferItemWire[] };
  /** The person's side: who, which character, what the offer asks of them, and (once done) what they put up. */
  player: { userId: number | null; name: string; ign: string; wants: WantLineWire[]; gave: OfferItemWire[] };
  progress: MeetingProgressWire | null;
  noShow: boolean;
  confirmedAt: number | null;
  report: string | null;
}

export function playerMeetingView(db: Db, rv: RendezvousRow): PlayerMeetingView {
  const node = db.prepare("SELECT n.id, n.name, n.user_id, u.display_name FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.id = ?").get(rv.giver_node_id) as { id: string; name: string; user_id: number; display_name: string } | undefined;
  const person = rv.taker_user_id === null ? undefined : (db.prepare("SELECT display_name FROM users WHERE id = ?").get(rv.taker_user_id) as { display_name: string } | undefined);
  return {
    id: rv.id, offerId: rv.offer_id, state: rv.state, server: rv.server, seasonal: !!rv.seasonal, createdAt: rv.created_at, deadlineAt: rv.deadline_at, closedAt: rv.closed_at, reason: rv.reason,
    node: { id: rv.giver_node_id, name: node?.name ?? "?", owner: node?.display_name ?? "?", ownerId: node?.user_id ?? null, botIgn: rv.giver_bot_ign, gives: JSON.parse(rv.giver_gives_json) as OfferItemWire[] },
    player: { userId: rv.taker_user_id, name: person?.display_name ?? "?", ign: rv.taker_bot_ign, wants: offerWant(db, rv.offer_id), gave: JSON.parse(rv.taker_gives_json) as OfferItemWire[] },
    progress: rv.progress_json ? (JSON.parse(rv.progress_json) as MeetingProgressWire) : null,
    noShow: !!rv.no_show, confirmedAt: rv.player_confirmed_at, report: rv.player_report,
  };
}

/** One player meeting, for someone allowed to see it: the person, the node's owner, or the operator. */
export function playerMeetingFor(db: Db, id: number, viewer: { id: number; admin: boolean }, now = Date.now()): PlayerMeetingView | null {
  sweepRendezvous(db, now);
  const rv = playerRow(db, id);
  if (!rv) return null;
  const v = playerMeetingView(db, rv);
  return viewer.admin || v.player.userId === viewer.id || v.node.ownerId === viewer.id ? v : null;
}

/** A person's trades in game, newest first. */
export function playerMeetingsOf(db: Db, userId: number, limit = 10, now = Date.now()): PlayerMeetingView[] {
  sweepRendezvous(db, now);
  return (db.prepare("SELECT * FROM rendezvous WHERE kind = 'player' AND taker_user_id = ? ORDER BY (state = 'meet') DESC, created_at DESC, id DESC LIMIT ?").all(userId, limit) as RendezvousRow[]).map((rv) => playerMeetingView(db, rv));
}

/** Something that changes whenever the meeting page would: the page polls it while the meeting is under way. */
export function playerMeetingRev(v: PlayerMeetingView): string {
  return [v.state, v.progress?.at ?? 0, v.closedAt ?? 0, v.confirmedAt ?? 0, v.report ? 1 : 0].join(":");
}
