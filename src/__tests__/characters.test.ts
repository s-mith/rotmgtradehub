// Several characters per hub account (src/auth.ts): typed ones count while
// the hub has no login node; with one, only characters proven by a whisper
// do, each proven on one account at a time, and every proven character signs
// in to its account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setSettings, type Db } from "../db";
import { addTypedCharacter, charactersOf, createUser, ignOf, removeCharacter, setMainIgn, setVerifiedIgn, signInWithRealm, tradingIgnOf, tradingIgnsOf } from "../auth";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});
const names = (userId: number) => charactersOf(db, userId).map((c) => [c.ign, c.provenAt !== null, c.main]);

describe("characters", () => {
  it("typed ones count without a login node: added, made main, picked, removed", () => {
    const gwen = createUser(db, "g@x.test", "Gwen");
    expect(tradingIgnOf(db, gwen.id)).toBeNull();
    expect(addTypedCharacter(db, gwen.id, "Gwen")).toEqual({ ok: true });
    expect(addTypedCharacter(db, gwen.id, "GwenAlt")).toEqual({ ok: true });
    expect(addTypedCharacter(db, gwen.id, "Not A Name")).toMatchObject({ ok: false });
    // The first one added is the main one; forms use it unless they pick another.
    expect(names(gwen.id)).toEqual([["Gwen", false, true], ["GwenAlt", false, false]]);
    expect(tradingIgnOf(db, gwen.id)).toBe("Gwen");
    expect(tradingIgnOf(db, gwen.id, "gwenalt")).toBe("GwenAlt");
    expect(tradingIgnOf(db, gwen.id, "Stranger")).toBeNull();
    expect(setMainIgn(db, gwen.id, "gwenALT")).toBe(true);
    expect(setMainIgn(db, gwen.id, "Stranger")).toBe(false);
    expect(ignOf(db, gwen.id)).toBe("GwenAlt");
    expect(tradingIgnsOf(db, gwen.id)).toEqual(["GwenAlt", "Gwen"]);
    // Removing the main one hands the part to the next.
    expect(removeCharacter(db, gwen.id, "GwenAlt")).toBe(true);
    expect(names(gwen.id)).toEqual([["Gwen", false, true]]);
    expect(removeCharacter(db, gwen.id, "Gwen")).toBe(true);
    expect(ignOf(db, gwen.id)).toBeNull();
  });

  it("with a login node only proven ones count; each signs in to its account; the last whisper wins a character", () => {
    setSettings(db, { loginNodeId: "n_login" });
    const gwen = createUser(db, "g@x.test", "Gwen");
    addTypedCharacter(db, gwen.id, "Typed");
    expect(tradingIgnOf(db, gwen.id)).toBeNull();
    setVerifiedIgn(db, gwen.id, "Gwen");
    // A proven character takes over as main from an unproven one.
    expect(names(gwen.id)).toEqual([["Gwen", true, true], ["Typed", false, false]]);
    setVerifiedIgn(db, gwen.id, "GwenAlt");
    expect(names(gwen.id)).toEqual([["Gwen", true, true], ["Typed", false, false], ["GwenAlt", true, false]]);
    expect(tradingIgnsOf(db, gwen.id)).toEqual(["Gwen", "GwenAlt"]);
    expect(tradingIgnOf(db, gwen.id, "Typed")).toBeNull();
    // Either proven character signs in to the same account (names match in any case; the whisper's spelling is kept).
    expect(signInWithRealm(db, "GwenAlt").id).toBe(gwen.id);
    expect(tradingIgnOf(db, gwen.id, "gwenalt")).toBe("GwenAlt");
    expect(signInWithRealm(db, "Gwen").id).toBe(gwen.id);
    // Someone else whispers as GwenAlt: they hold it now, and Gwen's account keeps it only as a name.
    const mal = createUser(db, "m@x.test", "Mal");
    setVerifiedIgn(db, mal.id, "GwenAlt");
    expect(names(gwen.id)).toEqual([["Gwen", true, true], ["Typed", false, false], ["GwenAlt", false, false]]);
    expect(signInWithRealm(db, "GwenAlt").id).toBe(mal.id);
    // A character nobody proved yet signs in as a new account of its own.
    const fresh = signInWithRealm(db, "Newcomer");
    expect(fresh.id).not.toBe(gwen.id);
    expect(names(fresh.id)).toEqual([["Newcomer", true, true]]);
  });

  it("a database from before gets each account's one IGN as its first character, proven if it was", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-chars-")), "hub.db");
    const old = openDb(file);
    const a = createUser(old, "a@x.test", "Ann");
    const b = createUser(old, "b@x.test", "Bob");
    old.exec("DROP TABLE characters");
    old.prepare("UPDATE users SET ign = 'AnnChar', ign_verified_at = 5 WHERE id = ?").run(a.id);
    old.prepare("UPDATE users SET ign = 'BobChar', ign_verified_at = NULL WHERE id = ?").run(b.id);
    old.close();
    db = openDb(file);
    expect(names(a.id)).toEqual([["AnnChar", true, true]]);
    expect(names(b.id)).toEqual([["BobChar", false, true]]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE ign_verified_at IS NOT NULL").get() as { n: number }).n).toBe(0);
    expect(new Database(file, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE name = 'users_verified_ign'").get()).toBeUndefined();
    db.close();
  });
});
