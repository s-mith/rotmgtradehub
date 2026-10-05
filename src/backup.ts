// Copies of the database while the hub runs: one at start and one every
// BACKUP_EVERY_MINUTES (60; 0 turns them off), each a consistent, compacted
// snapshot of the live file (VACUUM INTO), in BACKUP_DIR (default
// <DATA_DIR>/backups). The last two days of copies are kept, and past that the
// first copy of each day for thirty days. They sit next to the database, so
// copying the folder somewhere else is what protects against losing the disk.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";

const KEEP_ALL_MS = 48 * 3_600_000;
const KEEP_DAILY_MS = 30 * 86_400_000;
const NAME_RE = /^hub-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.db$/;

export function backupDir(): string {
  return process.env.BACKUP_DIR || path.join(process.env.DATA_DIR || "./data", "backups");
}

/** One copy now, named for the UTC minute (hub-2026-10-04T06-39.db). Returns its path. */
export function snapshot(db: Db, dir = backupDir(), now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `hub-${now.toISOString().slice(0, 16).replace(":", "-")}.db`);
  // Written beside the final name and renamed, so a copy cut short never looks like a whole one.
  const part = `${file}.part`;
  fs.rmSync(part, { force: true });
  db.prepare("VACUUM INTO ?").run(part);
  fs.renameSync(part, file);
  return file;
}

/** Delete the copies past their keep; returns the names deleted. */
export function prune(dir = backupDir(), now = Date.now()): string[] {
  if (!fs.existsSync(dir)) return [];
  const copies = fs.readdirSync(dir).flatMap((name) => {
    const m = NAME_RE.exec(name);
    return m ? [{ name, day: m[1], at: Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) }] : [];
  }).sort((a, b) => a.at - b.at);
  const firstOfDay = new Set<string>();
  const seenDays = new Set<string>();
  for (const c of copies) if (!seenDays.has(c.day)) { seenDays.add(c.day); firstOfDay.add(c.name); }
  const gone = copies.filter((c) => now - c.at > KEEP_DAILY_MS || (now - c.at > KEEP_ALL_MS && !firstOfDay.has(c.name)));
  for (const c of gone) fs.rmSync(path.join(dir, c.name), { force: true });
  return gone.map((c) => c.name);
}

/** Start the copies; returns the function that stops them. */
export function startBackups(db: Db, everyMinutes = Number(process.env.BACKUP_EVERY_MINUTES ?? 60)): () => void {
  if (!(everyMinutes > 0)) return () => {};
  const run = () => {
    try {
      snapshot(db);
      prune();
    } catch (e) {
      console.error(`[hub] backup failed: ${(e as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, everyMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
