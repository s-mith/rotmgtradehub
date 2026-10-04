// What happens when an offer is posted: crosses (an open offer that mirrors
// it, so either poster can accept) and watches (people who asked to hear
// when someone gives or wants an item). Both go out as events, which also
// reach Discord webhooks. Nothing here matches or moves anything.
import type { OfferItemWire, WantLineWire } from "rotmgtradenode/shared/hubWire";
import { itemName } from "./catalog";
import type { Db } from "./db";
import { emit } from "./events";

export type WatchSide = "give" | "want";

export interface Watch {
  id: number;
  itemId: string;
  side: WatchSide;
  createdAt: number;
}

export function listWatches(db: Db, userId: number): Watch[] {
  return (db.prepare("SELECT id, item_id AS itemId, side, created_at AS createdAt FROM watches WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Watch[]);
}

export function isWatching(db: Db, userId: number, itemId: string, side: WatchSide): boolean {
  return !!db.prepare("SELECT 1 FROM watches WHERE user_id = ? AND item_id = ? AND side = ?").get(userId, itemId, side);
}

export function setWatch(db: Db, userId: number, itemId: string, side: WatchSide, on: boolean, now = Date.now()): void {
  if (on) db.prepare("INSERT OR IGNORE INTO watches (user_id, item_id, side, created_at) VALUES (?, ?, ?, ?)").run(userId, itemId, side, now);
  else db.prepare("DELETE FROM watches WHERE user_id = ? AND item_id = ? AND side = ?").run(userId, itemId, side);
}

// --- crosses ---------------------------------------------------------------

type Qty = { itemId: string; qty: number };
const collapse = (items: OfferItemWire[]): Qty[] => {
  const out: Qty[] = [];
  for (const it of items) {
    const hit = out.find((q) => q.itemId === it.itemId);
    if (hit) hit.qty++;
    else out.push({ itemId: it.itemId, qty: 1 });
  }
  return out;
};
const describe = (qs: Qty[]): string => qs.map((q) => (q.qty > 1 ? `${q.qty}× ${itemName(q.itemId)}` : itemName(q.itemId))).join(", ") || "nothing";

/** Do these items cover every want line (by kind, count and enchant minimum)? */
export function covers(give: OfferItemWire[], want: WantLineWire[]): boolean {
  const used = new Set<string>();
  for (const w of want) {
    let taken = 0;
    for (const it of give) {
      if (taken >= w.qty) break;
      if (used.has(it.ref) || it.itemId !== w.itemId || it.count < w.slotsMin || (w.slotsExact !== null && it.count !== w.slotsExact)) continue;
      used.add(it.ref);
      taken++;
    }
    if (taken < w.qty) return false;
  }
  return true;
}

interface Posted {
  id: number;
  node_id: string;
  seasonal: number;
  give_json: string;
  want_json: string;
}

/** The offer's poster: the node's owner. */
function partiesOfOffer(db: Db, o: Posted): (number | null)[] {
  return [(db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(o.node_id) as { user_id: number } | undefined)?.user_id ?? null];
}

function nameOf(db: Db, o: Posted): string {
  return (db.prepare("SELECT u.display_name AS name FROM nodes n JOIN users u ON u.id = n.user_id WHERE n.id = ?").get(o.node_id) as { name: string } | undefined)?.name ?? "someone";
}

/** Tell crosses and watchers about a freshly posted offer. */
export function afterOfferPosted(db: Db, offerId: number, now = Date.now()): void {
  const o = db.prepare("SELECT id, node_id, seasonal, give_json, want_json FROM offers WHERE id = ?").get(offerId) as Posted | undefined;
  if (!o) return;
  const give = JSON.parse(o.give_json) as OfferItemWire[];
  const want = JSON.parse(o.want_json) as WantLineWire[];
  const poster = nameOf(db, o);
  const mine = partiesOfOffer(db, o);

  // Crosses: open offers from other nodes in the same half whose give covers this want and whose want this give covers.
  const others = db.prepare(`SELECT o.id, o.node_id, o.seasonal, o.give_json, o.want_json FROM offers o JOIN nodes n ON n.id = o.node_id
    WHERE o.status = 'open' AND o.id != ? AND o.node_id != ? AND o.seasonal = ? AND n.frozen = 0`).all(o.id, o.node_id, o.seasonal) as Posted[];
  for (const b of others) {
    const bGive = JSON.parse(b.give_json) as OfferItemWire[];
    const bWant = JSON.parse(b.want_json) as WantLineWire[];
    if (!covers(bGive, want) || !covers(give, bWant)) continue;
    const them = nameOf(db, b);
    emit(db, { users: mine, kind: "cross", tone: "accent", notify: true, href: "/me", text: `Cross: ${them} gives ${describe(collapse(bGive))} for ${describe(bWant)}, the mirror of your offer. Either of you can accept it on your node.` }, now);
    emit(db, { users: partiesOfOffer(db, b), kind: "cross", tone: "accent", notify: true, href: "/me", text: `Cross: ${poster} gives ${describe(collapse(give))} for ${describe(want)}, the mirror of your offer #${b.id}. Either of you can accept it on your node.` }, now);
  }

  // Watches: everyone who asked about these items, except the poster's side.
  const watchers = (itemIds: string[], side: WatchSide): Map<number, string[]> => {
    const out = new Map<number, string[]>();
    if (!itemIds.length) return out;
    const rows = db.prepare(`SELECT user_id, item_id FROM watches WHERE side = ? AND item_id IN (${itemIds.map(() => "?").join(", ")})`).all(side, ...itemIds) as { user_id: number; item_id: string }[];
    for (const r of rows) {
      if (mine.includes(r.user_id)) continue;
      out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.item_id]);
    }
    return out;
  };
  for (const [userId, items] of watchers([...new Set(give.map((g) => g.itemId))], "give")) {
    emit(db, { users: [userId], kind: "watch", tone: "accent", notify: true, href: "/me", text: `${poster} is giving ${describe(collapse(give))} for ${describe(want)} (you watch ${items.map(itemName).join(", ")}).` }, now);
  }
  for (const [userId, items] of watchers([...new Set(want.map((w) => w.itemId))], "want")) {
    emit(db, { users: [userId], kind: "watch", tone: "accent", notify: true, href: "/me", text: `${poster} wants ${describe(want)} and gives ${describe(collapse(give))} (you watch ${items.map(itemName).join(", ")}).` }, now);
  }
}
