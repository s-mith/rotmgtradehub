// What changed on communism board, for browsers that have it open: a
// revision counter and a short log of which tile stacks moved at each one.
// The page's script holds the revision it rendered; when the stream says
// there is a newer one it asks for the difference and gets back only the
// stacks that changed, not the whole grid (site/communism.tsx). A stack is one
// tile: the same item with the same enchantments on one account of one node.
//
// The log lives in memory. A revision the log no longer holds (a hub restart,
// a tab left open for hours) makes the client fetch the whole grid once.
import type { Db } from "./db";
import { NODE_ONLINE_MS } from "./nodes";

/** The tile a communism item belongs to. */
export function stackKey(r: { node_id: string; bot_ign: string; item_id: string; enchants_json: string }): string {
  const ench = (JSON.parse(r.enchants_json) as number[] | null) ?? [];
  return `${r.node_id}|${r.bot_ign}|${r.item_id}|${[...ench].sort((a, b) => a - b).join(",")}`;
}

interface Entry {
  rev: number;
  /** Stack keys that changed, per pool half (0 non-seasonal, 1 seasonal); `full` when the whole board should be refetched. */
  keys: Map<0 | 1, Set<string>>;
  full: boolean;
}

const KEEP = 400;
let rev = 0;
const log: Entry[] = [];
const listeners = new Set<(rev: number) => void>();

export function currentRev(): number {
  return rev;
}

function push(e: Omit<Entry, "rev">): void {
  rev++;
  log.push({ rev, ...e });
  if (log.length > KEEP) log.splice(0, log.length - KEEP);
  for (const fn of listeners) {
    try {
      fn(rev);
    } catch {
      // a dead stream
    }
  }
}

/** Some stacks changed (listed, delisted, counted differently, taken into a meeting). */
export function recordChange(changes: { key: string; seasonal: boolean }[]): void {
  if (!changes.length) return;
  const keys = new Map<0 | 1, Set<string>>();
  for (const c of changes) {
    const half = c.seasonal ? 1 : 0;
    let set = keys.get(half);
    if (!set) keys.set(half, (set = new Set()));
    set.add(c.key);
  }
  push({ keys, full: false });
}

/** Everything may have changed (a node came online or went offline). */
export function recordFull(): void {
  push({ keys: new Map(), full: true });
}

export function subscribe(fn: (rev: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** What moved in one half since `since`: the stack keys to re-render, or `full` when the log cannot say. */
export function changesSince(since: number, seasonal: boolean): { full: true } | { full: false; keys: string[] } {
  if (since === rev) return { full: false, keys: [] };
  if (since > rev || since < 0) return { full: true };
  const first = log.find((e) => e.rev === since + 1);
  if (!first) return { full: true };
  const half = seasonal ? 1 : 0;
  const keys = new Set<string>();
  for (const e of log) {
    if (e.rev <= since) continue;
    if (e.full) return { full: true };
    for (const k of e.keys.get(half) ?? []) keys.add(k);
  }
  return { full: false, keys: [...keys] };
}

// --- nodes coming and going --------------------------------------------------
// A node's items are on the board while its heartbeat is fresh. The board
// query decides that by time, so nothing records the moment a node crosses
// the line; this watcher does, so open pages learn of it within a few seconds.
let known: Map<string, boolean> | null = null;
export function checkNodes(db: Db, now = Date.now()): void {
  const rows = db.prepare("SELECT DISTINCT n.id, n.last_seen_at, n.frozen FROM nodes n JOIN communism_items ci ON ci.node_id = n.id").all() as { id: string; last_seen_at: number | null; frozen: number }[];
  const next = new Map<string, boolean>();
  for (const r of rows) next.set(r.id, !r.frozen && r.last_seen_at !== null && now - r.last_seen_at <= NODE_ONLINE_MS);
  let changed = false;
  if (known) {
    for (const [id, on] of next) if (known.get(id) !== on) changed = true;
    for (const id of known.keys()) if (!next.has(id)) changed = true;
  }
  known = next;
  if (changed) recordFull();
}

let watcher: ReturnType<typeof setInterval> | null = null;
export function watchNodes(db: Db, everyMs = 5_000): () => void {
  if (watcher) clearInterval(watcher);
  checkNodes(db);
  watcher = setInterval(() => checkNodes(db), everyMs);
  watcher.unref?.();
  return () => {
    if (watcher) clearInterval(watcher);
    watcher = null;
  };
}

/** Test hook. */
export function resetCommunismLive(): void {
  rev = 0;
  log.length = 0;
  known = null;
}
