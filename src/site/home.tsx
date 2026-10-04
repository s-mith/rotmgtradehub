// The front page: what this is, how it works, proof it runs, and the way in.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { getSettings, type HubSettings } from "../db";
import { hubStats, type HubStats } from "../stats";
import { loginNodeState } from "../realmLogin";
import { Flash, Layout } from "./layout";
import type { Site } from "./context";

const Home: FC<{ error?: string; google: boolean; discord: boolean; realm: boolean; signedIn: boolean; settings: HubSettings; stats: HubStats }> = ({ error, google, discord, realm, signedIn, settings, stats }) => {
  const supported = settings.gameVersion && settings.knownBuilds.includes(settings.gameVersion);
  return (
    <>
      <section class="hero">
        <h1>Your Realm storage, on your own computer.</h1>
        <p class="lead">
          rotmgtradenode keeps your items on your own alt accounts and trades them to you in the Nexus. rotmg trade is where nodes find each
          other: swap items with other players, and put items into communism, where anyone can take them and anyone can add more.
          It never holds an item, a password or a game login.
        </p>
        <Flash error={error} />
        <div class="row">
          {signedIn ? <a class="button" href="/me">Go to my nodes</a> : (
            <>
              {google && <a class="button" href="/auth/google">Sign in with Google</a>}
              {discord && <a class="button" href="/auth/discord">Sign in with Discord</a>}
              {realm && <a class="button" href="/auth/realm" title="Whisper a code to the login bot from your character in game: no email, no password">Sign in with your Realm character</a>}
              {!google && !discord && !realm && <span class="bad">Sign-in is not configured on this site yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or the Discord pair, are unset, and no login node is set).</span>}
            </>
          )}
          {settings.downloadUrl ? <a class="button quiet" href={settings.downloadUrl}>Download rotmgtradenode{settings.latestNodeVersion ? ` ${settings.latestNodeVersion}` : ""}</a> : null}
        </div>
      </section>

      <div class="stats">
        <div class="stat"><b>{stats.nodesOnline}</b><span>node{stats.nodesOnline === 1 ? "" : "s"} online now</span></div>
        <div class="stat"><b>{stats.communismItems}</b><span>item{stats.communismItems === 1 ? "" : "s"} free in communism</span></div>
        <div class="stat"><b>{stats.communismFree}</b><span>communism slot{stats.communismFree === 1 ? "" : "s"} open</span></div>
        <div class="stat"><b>{stats.swapsDone}</b><span>swap{stats.swapsDone === 1 ? "" : "s"} completed</span></div>
        <div class="stat"><b>{stats.handoversDone}</b><span>hand-over{stats.handoversDone === 1 ? "" : "s"} completed</span></div>
        <div class="stat">
          <b>{settings.gameVersion || "—"}</b>
          <span>{settings.gameVersion ? (supported ? <span class="good">Realm build, works with the latest node</span> : <span class="warn">Realm build, latest node not yet confirmed on it</span>) : "Realm build not published yet"}</span>
        </div>
      </div>

      <h2>How it works</h2>
      <ol class="steps">
        <li><b>Sign in and download the node.</b><span class="muted">The node is a small app for your PC. It runs your alt accounts through your own proxies; nothing central can be banned.</span></li>
        <li><b>Link the node to your account.</b><span class="muted">One code from this site, pasted into the node. From then on the node signs everything with its own key.</span></li>
        <li><b>Use your storage in the game.</b><span class="muted">Log in to your node with a /tell and your bots meet you in the Nexus to deposit and withdraw.</span></li>
        <li><b>Trade across nodes.</b><span class="muted">Post an offer here, accept someone else's, or take something free from communism and add what you do not need. Two bots meet on a server and swap in the trade window; rotmg trade records it only when both sides' receipts agree.</span></li>
      </ol>

      <div class="split">
        <div class="panel">
          <h3>What rotmg trade keeps</h3>
          <p class="muted">Accounts (an email and a name), each node's public key and what it reports about itself, open offers by catalog id, what each node lists in communism, meeting receipts, and opt-in ban telemetry as salted hashes.</p>
        </div>
        <div class="panel">
          <h3>What it never sees</h3>
          <p class="muted">Game credentials, item instances, proxies, or any Realm traffic. Every trade happens between two players' own bots. rotmg trade cannot move an item; it can only refuse to arrange a meeting.</p>
        </div>
      </div>

    </>
  );
};

export function registerHome(app: Hono, site: Site): void {
  app.get("/", (c) => {
    const user = site.me(c);
    return c.html(
      <Layout title="rotmg trade" frame={site.frame(user, "home")}>
        <Home error={c.req.query("error")} google={site.google !== null} discord={site.discord !== null} realm={((ln) => !!ln.node && ln.online)(loginNodeState(site.db))} signedIn={user !== null} settings={getSettings(site.db)} stats={hubStats(site.db)} />
      </Layout>,
    );
  });
}
