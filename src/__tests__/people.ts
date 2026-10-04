// Test helpers: an account with a session cookie, and a link code for it.
import { createLinkCode, createSession, createUser, type User } from "../auth";
import type { Db } from "../db";

/** The account with this email (made if missing) and a fresh session cookie for it. */
export function person(db: Db, email: string, name = "Someone"): User & { cookie: string } {
  const have = db.prepare("SELECT id, email, display_name AS displayName FROM users WHERE email = ?").get(email.toLowerCase()) as User | undefined;
  const user = have ?? createUser(db, email, name);
  return { ...user, cookie: `hub_session=${createSession(db, user.id)}` };
}

/** A one-time link code for the account with this email (made if missing). */
export function linkCodeFor(db: Db, email: string, name = "Someone"): string {
  return createLinkCode(db, person(db, email, name).id).code;
}
