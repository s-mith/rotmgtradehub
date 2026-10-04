// The signed-in person's page: their nodes as a table (a healthy node is one
// row with nothing under "needs attention"), linking another, meetings under way,
// their requests to nodes (the bot to /trade shows here), and their settings
// (settings.tsx). Offers themselves are posted on the nodes; each open one
// has a page here (/offers/:id, offers.tsx) whose link its owner can share.
import type { Child, FC } from "hono/jsx";
import type { Hono } from "hono";
import { compareVersions } from "rotmgtradenode/shared/hubWire";
import { createLinkCode, type User } from "../auth";
import { itemName } from "../catalog";
import { playerMeetingsOf, type PlayerMeetingView } from "../players";
import { getSettings, type HubSettings } from "../db";
import { collapse, meetingsFor, type MeetingView } from "../offers";
import { NODE_ONLINE_MS, nodesOf, unlinkNode, type NodeView } from "../nodes";
import { recentRequestsFor, type RequestView } from "../requests";
import { Badge, Flash, Layout, Qty, When, halfName, meetingWords, requestWords } from "./layout";
import type { Site } from "./context";
import { Settings, settingsView, type SettingsView } from "./settings";

type LinkCode = { code: string; expiresAt: number };

const LinkPanel: FC<{ linkCode?: LinkCode; nodeCount: number }> = ({ linkCode, nodeCount }) => {
  if (!linkCode) {
    return (
      <form method="post" action="/me/link-code" class="row">
        <button type="submit" class={nodeCount ? "quiet small" : ""}>{nodeCount ? "Link another node" : "Link my node"}</button>
      </form>
    );
  }
  const code = `${linkCode.code.slice(0, 4)}-${linkCode.code.slice(4)}`;
  return (
    <div class="panel" data-poll-nodes={String(nodeCount)}>
      <p style="margin-top:0">Paste this code into your node, under <b>Control panel → Overview</b>:</p>
      <p class="row"><span class="code" id="linkcode">{code}</span><button type="button" class="quiet small" data-copy={code}>copy</button></p>
      <p class="muted small" style="margin-bottom:0">It works once, for 15 minutes. This page notices when the node connects.</p>
    </div>
  );
};

const GetStarted: FC<{ settings: HubSettings; linkCode?: LinkCode }> = ({ settings, linkCode }) => (
  <div class="panel">
    <p class="muted" style="margin-top:0">No node linked yet. <a href="/communism">Communism</a> works without one; a node adds trading and a communism of your own.</p>
    <ol class="steps">
      <li>
        <b>Download the node</b>
        <span class="muted">
          {settings.downloadUrl ? (
            <>
              <a href={settings.downloadUrl}>rotmgtradenode{settings.latestNodeVersion ? ` ${settings.latestNodeVersion}` : ""}</a>. The app is not signed yet: if Windows says
              "Windows protected your PC", click More info, then Run anyway.
            </>
          ) : "Ask the site operator where to get it."}
        </span>
      </li>
      <li>
        <b>Link it to this account</b>
        <LinkPanel linkCode={linkCode} nodeCount={0} />
      </li>
      <li>
        <b>Add accounts and proxies</b>
        <span class="muted">In the node, under Control panel → Accounts and Proxies.</span>
      </li>
    </ol>
  </div>
);

/** What about a node needs its owner, worst first; nothing when it is healthy. */
function nodeProblems(node: NodeView, settings: HubSettings): { tone: "bad" | "warn"; text: Child }[] {
  const s = node.status;
  const tooOld = !!settings.minNodeVersion && compareVersions(node.version, settings.minNodeVersion) < 0;
  const behind = !tooOld && !!settings.latestNodeVersion && compareVersions(node.version, settings.latestNodeVersion) < 0;
  const update = (text: string) => (settings.downloadUrl ? <a href={settings.downloadUrl}>{text}</a> : text);
  const problems: { tone: "bad" | "warn"; text: Child }[] = [];
  if (node.frozen) problems.push({ tone: "bad", text: `Frozen by the hub operator${node.frozen_reason ? ` (${node.frozen_reason})` : ""}: no new offers or accepts until they unfreeze it.` });
  if (tooOld) problems.push({ tone: "bad", text: <>Too old for the hub: {update(`update to ${settings.latestNodeVersion ?? settings.minNodeVersion}`)}.</> });
  else if (behind) problems.push({ tone: "warn", text: <>{update(`Update to ${settings.latestNodeVersion}`)} available.</> });
  if (s?.suspended) problems.push({ tone: "bad", text: `${s.suspended} of ${s.accounts} account${s.accounts === 1 ? "" : "s"} suspended.` });
  if (s?.gate.held) problems.push({ tone: "warn", text: `Logins held: ${s.gate.reason ?? "unknown Realm build"}.` });
  if (s && s.proxies === 0) problems.push({ tone: "warn", text: "No proxies: nothing can log in." });
  return problems;
}

/** The person's nodes, one row each: whether it is up, its bots, proxies and swaps, and what needs its owner. */
const Nodes: FC<{ nodes: NodeView[]; settings: HubSettings; now: number }> = ({ nodes, settings, now }) => (
  <table class="responsive">
    <thead><tr><th>node</th><th>status</th><th>bots online</th><th>proxies</th><th>swaps</th><th>needs attention</th><th></th></tr></thead>
    <tbody>
      {nodes.map((node) => {
        const online = node.last_seen_at !== null && now - node.last_seen_at <= NODE_ONLINE_MS;
        const problems = nodeProblems(node, settings);
        return (
          <tr>
            <td data-th="node"><b>{node.name}</b></td>
            <td data-th="status" class="nowrap">{online ? <Badge tone="good">online</Badge> : <div><Badge>offline</Badge><div class="muted small">seen <When at={node.last_seen_at} /></div></div>}</td>
            <td data-th="bots online">{online ? node.online : 0}/{node.bots}</td>
            <td data-th="proxies">{node.status ? node.status.proxies : <span class="muted">—</span>}</td>
            <td data-th="swaps">{node.completed_swaps}</td>
            <td data-th="needs attention">{problems.length ? <div>{problems.map((p) => <div class={`${p.tone} small`}>{p.text}</div>)}</div> : <span class="muted">—</span>}</td>
            <td><form method="post" action={`/me/nodes/${node.id}/unlink`}><button class="quiet small" type="submit" title="The node forgets rotmg trade and keeps working locally; link it again any time.">unlink</button></form></td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

/** Items and how many of each, or a dash for none. */
const Items: FC<{ qtys: { itemId: string; qty: number; min?: number }[] }> = ({ qtys }) =>
  qtys.length ? <span class="qtys">{qtys.map((q) => <Qty itemId={q.itemId} qty={q.qty} min={q.min} />)}</span> : <span class="muted">—</span>;

/** Swaps and communism hand-overs one of the person's nodes is in right now. */
const Meetings: FC<{ meetings: MeetingView[] }> = ({ meetings }) => (
  <table class="responsive">
    <thead><tr><th>meeting</th><th>you give</th><th>you get</th><th>ends</th></tr></thead>
    <tbody>
      {meetings.map((m) => {
        const me = m.giver.mine ? m.giver : m.taker;
        const them = m.giver.mine ? m.taker : m.giver;
        return (
          <tr>
            <td data-th="meeting"><div><b class="nowrap">{m.kind === "communism" ? "Hand-over" : "Swap"} on {m.server}</b><div class="muted small"><code>{me.botIgn}</code> meets {them.name}'s <code>{them.botIgn}</code></div></div></td>
            <td data-th="you give"><Items qtys={me.gives} /></td>
            <td data-th="you get"><Items qtys={them.gives} /></td>
            <td data-th="ends" class="nowrap"><div><When at={m.deadlineAt} />{m.reported.giver || m.reported.taker ? <div class="muted small">one receipt in</div> : null}</div></td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

/** The person's trades in game (player meetings); each has its own page. */
const Trades: FC<{ trades: PlayerMeetingView[] }> = ({ trades }) => (
  <table class="responsive">
    <thead><tr><th>trade</th><th>you get</th><th>you put up</th><th>state</th></tr></thead>
    <tbody>
      {trades.map((t) => {
        const w = meetingWords(t.state);
        return (
          <tr>
            <td data-th="trade"><div><a href={`/meetings/${t.id}`}>#{t.id} on {t.server}</a><div class="muted small">{t.node.owner}'s <code>{t.node.botIgn}</code></div></div></td>
            <td data-th="you get"><Items qtys={t.node.gives.map((g) => ({ itemId: g.itemId, qty: 1 }))} /></td>
            <td data-th="you put up"><Items qtys={t.player.wants.map((l) => ({ itemId: l.itemId, qty: l.qty, min: l.slotsMin }))} /></td>
            <td data-th="state"><Badge tone={w.tone}>{w.text}</Badge></td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

const describe = (r: RequestView): string => {
  const n = r.refs?.length ?? 0;
  const items = (k: number) => `${k} item${k === 1 ? "" : "s"}`;
  switch (r.kind) {
    case "deposit": return `Deposit ${items(r.count ?? 0)} into ${r.nodeName}'s ${halfName(r.seasonal)} communism on ${r.server}`;
    case "withdraw": return n || !r.want?.length ? `Withdraw ${items(n)} from ${r.nodeName}'s communism on ${r.server}` : `Withdraw ${r.want.map((w) => `${w.qty}× ${itemName(w.itemId)}`).join(", ")} from ${r.nodeName}'s ${halfName(r.seasonal)} communism on ${r.server}`;
    case "offer-create": return `Post an offer from ${r.nodeName}: ${items(n)} for ${(r.want ?? []).map((w) => `${w.qty}× ${w.itemId}`).join(", ")} on ${r.server}`;
    case "offer-accept": return `Accept offer #${r.offerId} with ${r.nodeName}`;
    case "offer-cancel": return `Cancel offer #${r.offerId}`;
    case "communism-take": return `${r.nodeName} takes a communism item on ${r.server}`;
    case "communism-give": return `${r.nodeName} gives ${items(n)} to another communism on ${r.server}`;
  }
};

/** The person's requests, newest first: how each stands, the node's latest word, and the bot to /trade when it named one. */
const Requests: FC<{ requests: RequestView[] }> = ({ requests }) =>
  requests.length === 0 ? <p class="muted">None yet. Deposits and withdraws start on <a href="/communism">communism</a>.</p> : (
    <table class="responsive">
      <thead><tr><th>request</th><th>status</th><th>when</th></tr></thead>
      <tbody>
        {requests.map((r) => {
          // A request waiting its turn behind the person's previous trade on another node (a withdraw from several nodes).
          const waiting = r.state === "pending" && r.after !== null && requests.some((p) => p.id === r.after && (p.state === "pending" || p.state === "taken"));
          const w = waiting ? { text: `after #${r.after}`, tone: "muted" as const } : requestWords(r.state);
          const res = r.result;
          const said = !res ? null : res.ok ? res.detail ?? (res.pending ? "working on it" : null) : res.error ?? res.detail ?? "failed";
          return (
            <tr id={`request-${r.id}`}>
              <td data-th="request">{describe(r)}</td>
              <td data-th="status">
                <div>
                  <Badge tone={w.tone}>{w.text}</Badge>
                  {res?.botIgn && r.state === "taken" ? <div class="nowrap"><b>/trade {res.botIgn}</b>{r.server ? <span class="muted"> on {r.server}</span> : null}</div> : null}
                  {said ? <div class={res?.ok ? "small" : "bad small"}>{said}</div> : null}
                </div>
              </td>
              <td data-th="when" class="nowrap"><When at={r.createdAt} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

type OpenOffer = { id: number; nodeName: string; server: string; seasonal: number; give_json: string };

/** The open offers of the person's nodes, each with the link people take it by (Trade in game, or with their own node). */
const OpenOffers: FC<{ offers: OpenOffer[] }> = ({ offers }) => (
  <table class="responsive">
    <thead><tr><th>offer</th><th>gives</th><th>link</th></tr></thead>
    <tbody>
      {offers.map((o) => (
        <tr>
          <td data-th="offer">#{o.id} · {o.nodeName} · {o.server} · {halfName(!!o.seasonal)}</td>
          <td data-th="gives">{collapse(JSON.parse(o.give_json)).map((q) => <Qty itemId={q.itemId} qty={q.qty} />)}</td>
          <td data-th="link"><a href={`/offers/${o.id}`}>/offers/{o.id}</a></td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Me: FC<{ user: User; nodes: NodeView[]; meetings: MeetingView[]; requests: RequestView[]; trades: PlayerMeetingView[]; offers: OpenOffer[]; settings: HubSettings; mine: SettingsView; linkCode?: LinkCode; now: number; ok?: string; settingsMsg: { ok?: string; error?: string } }> = ({ user, nodes, meetings, requests, trades, offers, settings, mine, linkCode, now, ok, settingsMsg }) => (
  <>
    <h1>My nodes</h1>
    <Flash ok={ok} />
    {nodes.length === 0 ? (
      <GetStarted settings={settings} linkCode={linkCode} />
    ) : (
      <>
        <Nodes nodes={nodes} settings={settings} now={now} />
        <LinkPanel linkCode={linkCode} nodeCount={nodes.length} />
      </>
    )}
    <div data-live="/activity/stream">
      {meetings.length > 0 && (
        <>
          <h2>Meetings under way</h2>
          <Meetings meetings={meetings} />
        </>
      )}
      {trades.length > 0 && (
        <>
          <h2>Trades in game</h2>
          <Trades trades={trades} />
        </>
      )}
      {offers.length > 0 && (
        <>
          <h2>Open offers</h2>
          <p class="muted small">Share an offer's link: people take it there with their own character (Trade in game) or with a node of theirs.</p>
          <OpenOffers offers={offers} />
        </>
      )}
      <h2>Requests</h2>
      <Requests requests={requests} />
    </div>
    <Settings user={user} view={mine} {...settingsMsg} />
  </>
);

function openOffersOf(db: import("../db").Db, userId: number): OpenOffer[] {
  return db.prepare("SELECT o.id, n.name AS nodeName, o.server, o.seasonal, o.give_json FROM offers o JOIN nodes n ON n.id = o.node_id WHERE n.user_id = ? AND n.unlinked_at IS NULL AND o.status = 'open' ORDER BY o.created_at DESC LIMIT 100").all(userId) as OpenOffer[];
}

export function registerMe(app: Hono, site: Site): void {
  const page = (c: import("hono").Context, user: User, linkCode?: LinkCode) => {
    const requests = recentRequestsFor(site.db, user.id);
    return c.html(
      <Layout title="my nodes" frame={site.frame(user, "me")}>
        <Me user={user} nodes={nodesOf(site.db, user.id)} meetings={meetingsFor(site.db, user.id).filter((m) => m.state === "meet" && m.kind !== "player")} requests={requests} trades={playerMeetingsOf(site.db, user.id)} offers={openOffersOf(site.db, user.id)} settings={getSettings(site.db)} mine={settingsView(site.db, user.id)} linkCode={linkCode} now={Date.now()} ok={linkCode ? undefined : c.req.query("ok")} settingsMsg={linkCode ? {} : { ok: c.req.query("settings_ok"), error: c.req.query("settings_error") }} />
      </Layout>,
    );
  };
  app.get("/me", (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    return page(c, user);
  });
  // A link code for a node to join this account (docs/hub-protocol.md, "Identity"). Shown once, on this page.
  app.post("/me/link-code", (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    return page(c, user, createLinkCode(site.db, user.id));
  });
  // hub.js polls this while a link code is showing, to notice the node arriving.
  app.get("/me/nodes.json", (c) => {
    const user = site.me(c);
    if (!user) return c.json({ error: "sign in" }, 401);
    const nodes = nodesOf(site.db, user.id);
    return c.json({ count: nodes.length, nodes: nodes.map((n) => ({ id: n.id, name: n.name, lastSeenAt: n.last_seen_at })) }, 200, { "cache-control": "no-store" });
  });
  app.post("/me/nodes/:id/unlink", (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    unlinkNode(site.db, c.req.param("id"), user.id);
    return c.redirect("/me");
  });
}

export { Flash };
