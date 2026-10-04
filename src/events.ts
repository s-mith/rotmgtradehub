// What happened, for people: one row per thing a person would want to know
// about (a node linked, a meeting scheduled, a swap done, a request
// answered), addressed to the hub users it concerns. Pages list them, the
// activity stream pushes them, and a Discord webhook can carry them out.
import type { Db } from "./db";

export type EventTone = "good" | "bad" | "accent" | "muted";

export interface EventView {
  id: number;
  kind: string;
  tone: EventTone;
  text: string;
  href: string | null;
  at: number;
}

class EventBus {
  private readonly listeners = new Map<number, Set<(id: number) => void>>();
  subscribe(userId: number, fn: (id: number) => void): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(userId);
    };
  }
  publish(userId: number, id: number): void {
    for (const fn of this.listeners.get(userId) ?? []) {
      try {
        fn(id);
      } catch {
        // a dead stream
      }
    }
  }
}
export const bus = new EventBus();

/** Notifiers run outside the request (a webhook); tests replace this. */
export let notify: (db: Db, userId: number, e: EventView) => void = (db, userId, e) => {
  void sendDiscordWebhook(db, userId, e);
};
export function setNotifier(fn: typeof notify): void {
  notify = fn;
}

export interface EventInput {
  /** Hub users this concerns; duplicates are fine. */
  users: (number | null | undefined)[];
  kind: string;
  tone?: EventTone;
  text: string;
  href?: string | null;
  /** Worth a notification outside the site (a meeting, a swap, a request answered). */
  notify?: boolean;
}

export function emit(db: Db, e: EventInput, now = Date.now()): void {
  const users = [...new Set(e.users.filter((u): u is number => typeof u === "number" && u > 0))];
  if (!users.length) return;
  const ins = db.prepare("INSERT INTO events (user_id, kind, tone, text, href, notify, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rows: { userId: number; id: number }[] = [];
  db.transaction(() => {
    for (const userId of users) rows.push({ userId, id: Number(ins.run(userId, e.kind, e.tone ?? "muted", e.text.slice(0, 400), e.href ?? null, e.notify ? 1 : 0, now).lastInsertRowid) });
  })();
  for (const r of rows) {
    bus.publish(r.userId, r.id);
    if (e.notify) notify(db, r.userId, { id: r.id, kind: e.kind, tone: e.tone ?? "muted", text: e.text, href: e.href ?? null, at: now });
  }
}

/** A person's events, newest first; `beforeId` pages back from an event already shown. */
export function listEventsFor(db: Db, userId: number, limit = 50, beforeId?: number): EventView[] {
  if (beforeId !== undefined) return db.prepare("SELECT id, kind, tone, text, href, at FROM events WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(userId, beforeId, limit) as EventView[];
  return (db.prepare("SELECT id, kind, tone, text, href, at FROM events WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(userId, limit) as EventView[]);
}

/** The owner of a node, for addressing. */
export function ownerOf(db: Db, nodeId: string): number | null {
  const r = db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(nodeId) as { user_id: number } | undefined;
  return r?.user_id ?? null;
}

// --- Discord webhook ----------------------------------------------------------

export const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export function webhookFor(db: Db, userId: number): string | null {
  const r = db.prepare("SELECT discord_webhook FROM users WHERE id = ?").get(userId) as { discord_webhook: string | null } | undefined;
  return r?.discord_webhook ?? null;
}

export function setWebhook(db: Db, userId: number, url: string | null): { ok: true } | { ok: false; error: string } {
  if (url !== null && !WEBHOOK_RE.test(url)) return { ok: false, error: "that is not a Discord webhook URL (Server settings → Integrations → Webhooks → copy URL)" };
  db.prepare("UPDATE users SET discord_webhook = ? WHERE id = ?").run(url, userId);
  return { ok: true };
}

export async function sendDiscordWebhook(db: Db, userId: number, e: EventView, fetchImpl: typeof fetch = fetch, baseUrl = process.env.BASE_URL?.replace(/\/$/, "") ?? ""): Promise<boolean> {
  const url = webhookFor(db, userId);
  if (!url) return false;
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: e.href && baseUrl ? `${e.text}\n${baseUrl}${e.href}` : e.text, username: "rotmg trade", allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
