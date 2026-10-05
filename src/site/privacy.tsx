// The privacy page: what the hub keeps, who sees it and how to have it
// deleted, in plain words. The Google sign-in screen links here, so keep it
// true to what the code stores (src/db.ts).
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { Layout } from "./layout";
import type { Site } from "./context";

/** Where people ask for their account to be deleted, or anything else. */
export const DISCORD_INVITE = "https://discord.gg/xJ7TyTUSb3";
/** When the text below last changed. */
const UPDATED = "2026-10-05";

const Privacy: FC = () => (
  <article class="prose">
    <h1>Privacy</h1>
    <p class="lead">rotmg trade is a free project. It keeps what it needs to connect people's nodes and nothing to sell: no ads, no analytics, no tracking cookies.</p>

    <h2>What it keeps</h2>
    <ul>
      <li><b>Your account.</b> When you sign in with Google or Discord, the email address, name and account id that service sends. It asks for nothing else: no contacts, no files. Your email is never shown to anyone.</li>
      <li><b>What you set here.</b> Your display name, the characters you add or prove, and a Discord webhook if you set one for notifications.</li>
      <li><b>Sign-in.</b> A cookie that keeps you signed in for 30 days after your last visit, and short-lived cookies while a sign-in is under way.</li>
      <li><b>Your nodes.</b> Each node's name, version and public key, and what it reports: its bots' in-game names and whether they are online, how many proxies and accounts it has, its offers, communism items, meetings and the receipts of finished trades.</li>
      <li><b>What you do on the site.</b> Your requests, offers, item watches and notifications.</li>
      <li><b>Ban reports</b> from nodes, with each game account replaced by a salted hash, never its email.</li>
    </ul>

    <h2>What it never has</h2>
    <p>Game passwords or logins, your items, your proxies or any payment details. Bots and trades run on players' own computers; the hub only puts nodes in touch with each other.</p>

    <h2>Who sees what</h2>
    <p>People who are signed in see display names, node names, offers, the communism board and the meetings they take part in. The site operator can see everything above in order to run the site. Nothing is sold or shared with anyone else.</p>

    <h2>Where it is kept</h2>
    <p>In one database on the machine that runs rotmg trade, with hourly backup copies kept for up to thirty days. Visits pass through Cloudflare, which carries the site and sees visitors' IP addresses. The hub itself uses an address only in memory, to slow down repeated sign-in and link attempts, and does not store it.</p>

    <h2>Your choices</h2>
    <p>Unlink a node any time on <a href="/me">my nodes</a>: it stops sending anything. To have your account and everything tied to it deleted, or for any question about your data, ask on our <a href={DISCORD_INVITE}>Discord</a>.</p>

    <p class="muted small">Last updated {UPDATED}.</p>
  </article>
);

export function registerPrivacy(app: Hono, site: Site): void {
  app.get("/privacy", (c) =>
    c.html(
      <Layout title="privacy" frame={site.frame(site.me(c))}>
        <Privacy />
      </Layout>,
    ),
  );
}
