// Hub user accounts: scrypt password hashes, opaque session tokens in a
// cookie for the website. The node never gets a session: after linking, its
// key is its credential (docs/hub-protocol.md in the node repo).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";

const SESSION_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 32).toString("base64url")}`;
}
export function checkPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const got = scryptSync(password, Buffer.from(saltB64, "base64url"), 32);
  const want = Buffer.from(hashB64, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface User {
  id: number;
  email: string;
  displayName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function register(db: Db, email: string, password: string, displayName: string): { ok: true; user: User } | { ok: false; error: string } {
  email = email.trim().toLowerCase();
  displayName = displayName.trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "that email does not look right" };
  if (password.length < 10) return { ok: false, error: "password must be at least 10 characters" };
  if (!/^[A-Za-z0-9 _-]{2,24}$/.test(displayName)) return { ok: false, error: "display name: 2-24 letters, digits, spaces, _ or -" };
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return { ok: false, error: "that email already has an account" };
  const r = db.prepare("INSERT INTO users (email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)").run(email, displayName, hashPassword(password), Date.now());
  return { ok: true, user: { id: Number(r.lastInsertRowid), email, displayName } };
}

export function authenticate(db: Db, email: string, password: string): User | null {
  const row = db.prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?").get(email.trim().toLowerCase()) as { id: number; email: string; display_name: string; password_hash: string } | undefined;
  if (!row || !checkPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, userId, Date.now(), Date.now() + SESSION_MS);
  return token;
}

export function userFromSession(db: Db, token: string | undefined): User | null {
  if (!token) return null;
  const row = db.prepare("SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?").get(token, Date.now()) as { id: number; email: string; display_name: string } | undefined;
  return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function isAdmin(user: User | null): boolean {
  if (!user) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(user.email);
}
