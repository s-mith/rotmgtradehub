import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db";
import { prune, snapshot } from "../backup";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "hub-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("backups", () => {
  it("copies the live database to a file that opens on its own", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)").run("kept@x.test", "Kept", 1);
    const dir = tempDir();
    const file = snapshot(db, dir, new Date("2026-10-04T06:39:12Z"));
    expect(path.basename(file)).toBe("hub-2026-10-04T06-39.db");
    expect(fs.readdirSync(dir)).toEqual(["hub-2026-10-04T06-39.db"]);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare("SELECT email FROM users").all()).toEqual([{ email: "kept@x.test" }]);
    copy.close();
    db.close();
  });

  it("keeps two days of copies, then the first of each day for thirty days", () => {
    const dir = tempDir();
    const names = [
      "hub-2026-08-01T00-00.db", // past thirty days: gone
      "hub-2026-09-20T03-00.db", // first of its day: kept
      "hub-2026-09-20T04-00.db", // same day, older than two days: gone
      "hub-2026-10-03T07-00.db", // within two days: kept
      "hub-2026-10-03T08-00.db", // within two days: kept
      "notes.txt", // not a copy: left alone
    ];
    for (const n of names) fs.writeFileSync(path.join(dir, n), "");
    const gone = prune(dir, Date.parse("2026-10-04T12:00:00Z"));
    expect(gone.sort()).toEqual(["hub-2026-08-01T00-00.db", "hub-2026-09-20T04-00.db"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["hub-2026-09-20T03-00.db", "hub-2026-10-03T07-00.db", "hub-2026-10-03T08-00.db", "notes.txt"]);
  });
});
