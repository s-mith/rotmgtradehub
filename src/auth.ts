// Hub user accounts: made by signing in with Google (src/google.ts) or
// Discord (src/discord.ts); there are no passwords. Opaque session tokens
// in a cookie for the website; one-shot link codes that let a node join an
// account. The node never gets a session: after linking, its key is its
// credential (docs/hub-protocol.md in the node repo). The users table's
// password_hash column is a leftover from v0 and is always NULL now.
import { randomBytes } from "node:crypto";
import type { Db } from "./db";

/** A session lasts this long from its last renewal; using the site renews it (renewSession), so an active person stays signed in. */
export const SESSION_MS = 30 * 24 * 3600 * 1000;
/** A session in use is renewed once it is this old, not on every request. */
const SESSION_RENEW_MS = 24 * 3600 * 1000;
const LINK_CODE_MS = 15 * 60 * 1000;
/** Link codes alive at once per account: linking two nodes from two tabs works; a fourth code drops the oldest. */
const LIVE_LINK_CODES = 3;
/** Link codes: eight characters from an alphabet with no 0/O or 1/I, so they survive being read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISPLAY_NAME_RE = /^[A-Za-z0-9 _-]{2,24}$/;

export interface User {
  id: number;
  /** Null for an account made by signing in with a Realm character (src/realmLogin.ts). */
  email: string | null;
  displayName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An account with no sign-in of its own yet (tests, operator scripts): the first Google or Discord sign-in with this email attaches to it. */
export function createUser(db: Db, email: string, displayName: string): User {
  email = email.trim().toLowerCase();
  displayName = displayName.trim();
  if (!EMAIL_RE.test(email)) throw new Error("that email does not look right");
  if (!DISPLAY_NAME_RE.test(displayName)) throw new Error("display name: 2-24 letters, digits, spaces, _ or -");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("that email already has an account");
  const r = db.prepare("INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)").run(email, displayName, Date.now());
  return { id: Number(r.lastInsertRowid), email, displayName };
}

/**
 * A new account's display name: "Trader" and four digits, not taken. Never
 * the name Google or Discord has for the person, their email or their
 * character: the display name is what everyone else sees on offers and
 * meetings, so it says nothing about who is behind it until they pick one
 * themselves (Settings; 2026-09-25).
 */
export function neutralDisplayName(db: Db): string {
  for (let i = 0; i < 50; i++) {
    const name = `Trader${1000 + (randomBytes(2).readUInt16BE(0) % 9000)}`;
    if (!displayNameTaken(db, name)) return name;
  }
  return `Trader${randomBytes(4).readUInt32BE(0)}`;
}

function displayNameTaken(db: Db, name: string, exceptUserId = 0): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE lower(display_name) = lower(?) AND id != ?").get(name, exceptUserId);
}

/** The name others see, as the person picks it: 2-24 letters, digits, spaces, _ or -, and nobody else's (any case), so no one passes for someone else. */
export function setDisplayName(db: Db, userId: number, raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!DISPLAY_NAME_RE.test(name)) return { ok: false, error: "A display name is 2-24 letters, digits, spaces, _ or -." };
  if (displayNameTaken(db, name, userId)) return { ok: false, error: "Someone else already goes by that name." };
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, userId);
  return { ok: true, name };
}

/**
 * The account behind a Google sign-in: the one already tied to this Google
 * subject; else the account with this (verified) email, which the subject
 * is attached to; else a new account. A user row is never made from
 * anything but a verified email.
 */
export function signInWithGoogle(db: Db, claims: { sub: string; email: string; name?: string }): User {
  const email = claims.email.trim().toLowerCase();
  const bySub = db.prepare("SELECT id, email, display_name FROM users WHERE google_sub = ?").get(claims.sub) as { id: number; email: string; display_name: string } | undefined;
  if (bySub) return { id: bySub.id, email: bySub.email, displayName: bySub.display_name };
  const byEmail = db.prepare("SELECT id, email, display_name FROM users WHERE email = ?").get(email) as { id: number; email: string; display_name: string } | undefined;
  if (byEmail) {
    db.prepare("UPDATE users SET google_sub = ? WHERE id = ?").run(claims.sub, byEmail.id);
    return { id: byEmail.id, email: byEmail.email, displayName: byEmail.display_name };
  }
  const displayName = neutralDisplayName(db);
  const r = db.prepare("INSERT INTO users (email, display_name, google_sub, created_at) VALUES (?, ?, ?, ?)").run(email, displayName, claims.sub, Date.now());
  return { id: Number(r.lastInsertRowid), email, displayName };
}

/** The account behind a Discord sign-in: the same rules as Google, keyed by Discord's account id (verified email only, src/discord.ts). */
export function signInWithDiscord(db: Db, claims: { id: string; email: string; name?: string }): User {
  const email = claims.email.trim().toLowerCase();
  const byId = db.prepare("SELECT id, email, display_name FROM users WHERE discord_id = ?").get(claims.id) as { id: number; email: string; display_name: string } | undefined;
  if (byId) return { id: byId.id, email: byId.email, displayName: byId.display_name };
  const byEmail = db.prepare("SELECT id, email, display_name FROM users WHERE email = ?").get(email) as { id: number; email: string; display_name: string } | undefined;
  if (byEmail) {
    db.prepare("UPDATE users SET discord_id = ? WHERE id = ?").run(claims.id, byEmail.id);
    return { id: byEmail.id, email: byEmail.email, displayName: byEmail.display_name };
  }
  const displayName = neutralDisplayName(db);
  const r = db.prepare("INSERT INTO users (email, display_name, discord_id, created_at) VALUES (?, ?, ?, ?)").run(email, displayName, claims.id, Date.now());
  return { id: Number(r.lastInsertRowid), email, displayName };
}

/** A fresh code for the website to show; it is the one secret a node ever carries, and only once. */
export function createLinkCode(db: Db, userId: number, now = Date.now()): { code: string; expiresAt: number } {
  const bytes = randomBytes(8);
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  // A few live codes per account; asking for another drops the oldest past that, and any that ran out.
  db.prepare(`DELETE FROM link_codes WHERE user_id = ? AND used_at IS NULL AND (expires_at <= ? OR code NOT IN (
    SELECT code FROM link_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?))`).run(userId, now, userId, now, LIVE_LINK_CODES - 1);
  db.prepare("INSERT INTO link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(code, userId, now, now + LINK_CODE_MS);
  return { code, expiresAt: now + LINK_CODE_MS };
}

/** Tidy what a person typed or pasted: case, spaces and dashes do not matter. */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The account a live, unused code belongs to, or null. `spendLinkCode` burns it once the link succeeded. */
export function lookupLinkCode(db: Db, raw: string, now = Date.now()): User | null {
  const code = normalizeLinkCode(raw);
  if (code.length !== 8) return null;
  const row = db.prepare("SELECT u.id, u.email, u.display_name FROM link_codes c JOIN users u ON u.id = c.user_id WHERE c.code = ? AND c.used_at IS NULL AND c.expires_at > ?").get(code, now) as { id: number; email: string | null; display_name: string } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
}

export function spendLinkCode(db: Db, raw: string, now = Date.now()): void {
  db.prepare("UPDATE link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL").run(now, normalizeLinkCode(raw));
  db.prepare("DELETE FROM link_codes WHERE expires_at < ?").run(now - 24 * 3600 * 1000);
}

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, Date.now(), Date.now() + SESSION_MS);
  return token;
}

export function userFromSession(db: Db, token: string | undefined, now = Date.now()): User | null {
  if (!token) return null;
  const row = db.prepare("SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?").get(token, now) as { id: number; email: string | null; display_name: string } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
}

/** A live session in use gets a full SESSION_MS again, at most once a day. True when it moved: the cookie should follow. */
export function renewSession(db: Db, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  return db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at > ? AND expires_at < ?").run(now + SESSION_MS, token, now, now + SESSION_MS - SESSION_RENEW_MS).changes > 0;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** The character a person meets communism bots with: letters only, as Realm names are. */
export const USER_IGN_RE = /^[A-Za-z]{1,32}$/;

export function ignOf(db: Db, userId: number): string | null {
  const r = db.prepare("SELECT ign FROM users WHERE id = ?").get(userId) as { ign: string | null } | undefined;
  return r?.ign ?? null;
}

/** One of a person's characters: the name as Realm shows it, when a whisper proved it (null: only typed), and whether it is their main one. */
export interface Character {
  ign: string;
  provenAt: number | null;
  main: boolean;
}

/** A person's characters, the main one first (what forms use unless they pick another), then the oldest first. */
export function charactersOf(db: Db, userId: number): Character[] {
  const main = ignOf(db, userId)?.toLowerCase() ?? null;
  const rows = db.prepare("SELECT ign, proven_at FROM characters WHERE user_id = ? ORDER BY added_at, rowid").all(userId) as { ign: string; proven_at: number | null }[];
  return rows.map((r) => ({ ign: r.ign, provenAt: r.proven_at, main: r.ign.toLowerCase() === main })).sort((a, b) => Number(b.main) - Number(a.main));
}

/** The main character and whether a whisper to the login node proved it (src/realmLogin.ts). */
export function ignStatusOf(db: Db, userId: number): { ign: string | null; verifiedAt: number | null } {
  const main = charactersOf(db, userId).find((c) => c.main);
  return { ign: main?.ign ?? null, verifiedAt: main?.provenAt ?? null };
}

/** The node that signs people in with a character, if the operator named one. */
export function loginNodeId(db: Db): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'loginNodeId'").get() as { value: string } | undefined;
  const id = r ? (JSON.parse(r.value) as unknown) : "";
  return typeof id === "string" && id ? id : null;
}

/**
 * The characters a person trades with in game (communism deposits and
 * withdraws, player meetings), main first. Once the operator has named a
 * login node only characters proven by a whisper to it count; before that,
 * typed ones do too.
 */
export function tradingIgnsOf(db: Db, userId: number): string[] {
  const provenOnly = loginNodeId(db) !== null;
  return charactersOf(db, userId).filter((c) => !provenOnly || c.provenAt !== null).map((c) => c.ign);
}

/** The character to trade as: `pick` when it is one of theirs that counts (null otherwise), else the main one if it counts, else the first that does. */
export function tradingIgnOf(db: Db, userId: number, pick?: string | null): string | null {
  const usable = tradingIgnsOf(db, userId);
  if (pick) return usable.find((i) => i.toLowerCase() === pick.trim().toLowerCase()) ?? null;
  return usable[0] ?? null;
}

/** The first character of an account without a main one, or one whose main was just removed: proven ones first, then the oldest. */
function pickMain(db: Db, userId: number): void {
  const next = db.prepare("SELECT ign FROM characters WHERE user_id = ? ORDER BY proven_at IS NULL, added_at, rowid LIMIT 1").get(userId) as { ign: string } | undefined;
  db.prepare("UPDATE users SET ign = ? WHERE id = ?").run(next?.ign ?? null, userId);
}

/**
 * A typed character: added to the account as a name only (a proven one of the
 * same name stays proven) and made the main one. Null forgets the main
 * character; the next one, if any, takes its place.
 */
export function setIgn(db: Db, userId: number, ign: string | null, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (ign !== null && !USER_IGN_RE.test(ign)) return { ok: false, error: "IGN: letters only, 1..32, exactly as it shows in the game" };
  db.transaction(() => {
    if (ign === null) {
      const main = ignOf(db, userId);
      if (main) removeCharacter(db, userId, main);
      return;
    }
    db.prepare("INSERT INTO characters (user_id, ign, proven_at, added_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING").run(userId, ign, now);
    const stored = db.prepare("SELECT ign FROM characters WHERE user_id = ? AND lower(ign) = lower(?)").get(userId, ign) as { ign: string };
    db.prepare("UPDATE users SET ign = ? WHERE id = ?").run(stored.ign, userId);
  })();
  return { ok: true };
}

/** Add a typed character (a name only, not proven) without changing the main one, unless there is none yet. */
export function addTypedCharacter(db: Db, userId: number, ign: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (!USER_IGN_RE.test(ign)) return { ok: false, error: "IGN: letters only, 1..32, exactly as it shows in the game" };
  db.transaction(() => {
    db.prepare("INSERT INTO characters (user_id, ign, proven_at, added_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING").run(userId, ign, now);
    if (!ignOf(db, userId)) pickMain(db, userId);
  })();
  return { ok: true };
}

/** Make one of the person's characters their main one. False when it is not theirs. */
export function setMainIgn(db: Db, userId: number, ign: string): boolean {
  const stored = db.prepare("SELECT ign FROM characters WHERE user_id = ? AND lower(ign) = lower(?)").get(userId, ign) as { ign: string } | undefined;
  if (!stored) return false;
  db.prepare("UPDATE users SET ign = ? WHERE id = ?").run(stored.ign, userId);
  return true;
}

/** Take a character off the account; if it was the main one, the next takes its place. False when it was not theirs. */
export function removeCharacter(db: Db, userId: number, ign: string): boolean {
  const main = ignOf(db, userId);
  const gone = db.prepare("DELETE FROM characters WHERE user_id = ? AND lower(ign) = lower(?)").run(userId, ign).changes > 0;
  if (gone && main?.toLowerCase() === ign.toLowerCase()) pickMain(db, userId);
  return gone;
}

/**
 * A character proven by a whisper to the login node joins this account (or
 * is marked proven there). A character is proven on one account only: another
 * account that had it proven loses the proof (whoever whispered last controls
 * it now). It becomes the main character when the account has none that is
 * proven.
 */
export function setVerifiedIgn(db: Db, userId: number, ign: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare("UPDATE characters SET proven_at = NULL WHERE lower(ign) = lower(?) AND user_id != ? AND proven_at IS NOT NULL").run(ign, userId);
    const have = db.prepare("SELECT rowid FROM characters WHERE user_id = ? AND lower(ign) = lower(?)").get(userId, ign) as { rowid: number } | undefined;
    if (have) db.prepare("UPDATE characters SET ign = ?, proven_at = ? WHERE rowid = ?").run(ign, now, have.rowid);
    else db.prepare("INSERT INTO characters (user_id, ign, proven_at, added_at) VALUES (?, ?, ?, ?)").run(userId, ign, now, now);
    const main = charactersOf(db, userId).find((c) => c.main);
    if (!main || main.provenAt === null || main.ign.toLowerCase() === ign.toLowerCase()) db.prepare("UPDATE users SET ign = ? WHERE id = ?").run(ign, userId);
  })();
}

/**
 * Signing in with a Realm character (src/realmLogin.ts): the account that
 * has this character proven, else a new account for it, with no email and
 * a neutral display name (the character is only said to whoever meets it).
 */
/**
 * Why a whisper may not sign in as the account that has `ign` proven, or null. The login node only reports who
 * whispered, and nodes are not trusted with more than that: an account that signs in another way (an email, Google,
 * Discord), the operator's included, is reached only that way, never by a node's word.
 */
export function realmSignInRefusal(db: Db, ign: string): string | null {
  const u = db.prepare("SELECT u.email, u.google_sub, u.discord_id FROM characters ch JOIN users u ON u.id = ch.user_id WHERE lower(ch.ign) = lower(?) AND ch.proven_at IS NOT NULL").get(ign) as { email: string | null; google_sub: string | null; discord_id: string | null } | undefined;
  if (!u) return null;
  if (u.email || u.google_sub || u.discord_id) return `${ign} belongs to an account that signs in with ${u.google_sub ? "Google" : u.discord_id ? "Discord" : "its email"}; sign in that way instead`;
  return null;
}

export function signInWithRealm(db: Db, ign: string, now = Date.now()): User {
  const have = db.prepare("SELECT u.id, u.email, u.display_name FROM characters ch JOIN users u ON u.id = ch.user_id WHERE lower(ch.ign) = lower(?) AND ch.proven_at IS NOT NULL").get(ign) as { id: number; email: string | null; display_name: string } | undefined;
  if (have) {
    db.prepare("UPDATE characters SET ign = ?, proven_at = ? WHERE user_id = ? AND lower(ign) = lower(?)").run(ign, now, have.id, ign);
    return { id: have.id, email: have.email, displayName: have.display_name };
  }
  const displayName = neutralDisplayName(db);
  return db.transaction((): User => {
    const r = db.prepare("INSERT INTO users (email, display_name, created_at, ign) VALUES (NULL, ?, ?, ?)").run(displayName, now, ign);
    const id = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO characters (user_id, ign, proven_at, added_at) VALUES (?, ?, ?, ?)").run(id, ign, now, now);
    return { id, email: null, displayName };
  })();
}

export function isAdmin(user: User | null): boolean {
  if (!user || !user.email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(user.email);
}
