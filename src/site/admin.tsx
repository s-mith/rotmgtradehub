// The operator's page: the version feed, the numbers, the nodes (freeze and
// unfreeze are the operator's alone), limits lifted for one person, and
// meetings whose two sides disagreed.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { isAdmin } from "../auth";
import { communismOperatorView } from "../communism";
import { getSettings, setSettings, type HubSettings } from "../db";
import { NODE_ONLINE_MS, allNodes, type NodeView } from "../nodes";
import { freezeNode, operatorView, unfreezeNode } from "../offers";
import { loginNodeState } from "../realmLogin";
import { DEFAULT_NODES_PER_ACCOUNT, DEFAULT_PLAYER_STARTS_PER_HOUR, findPeople, parseLimitField, setPersonLimits, type PersonRow } from "../personLimits";
import type { Db } from "../db";
import { hubStats, type HubStats } from "../stats";
import { summarize, type BanSummary } from "../telemetry";
import { Badge, Layout, Online, When } from "./layout";
import type { Site } from "./context";

type LoginView = { node: ReturnType<typeof loginNodeState>; lastDay: { made: number; proven: number; failed: number } };

/** Realm sign-ins in the last day: codes handed out, whispers that landed, codes the login node could not take. */
function loginView(db: Db, now = Date.now()): LoginView {
  const n = (sql: string) => (db.prepare(sql).get(now - 24 * 3600 * 1000) as { n: number }).n;
  return {
    node: loginNodeState(db, now),
    lastDay: {
      made: n("SELECT COUNT(*) AS n FROM realm_logins WHERE created_at >= ?"),
      proven: n("SELECT COUNT(*) AS n FROM realm_logins WHERE created_at >= ? AND state IN ('verified', 'used')"),
      failed: n("SELECT COUNT(*) AS n FROM realm_logins WHERE created_at >= ? AND state = 'failed'"),
    },
  };
}

const Admin: FC<{ settings: HubSettings; bans: BanSummary; stats: HubStats; nodes: (NodeView & { owner: string })[]; board: ReturnType<typeof operatorView>; communism: ReturnType<typeof communismOperatorView>; login: LoginView; people: PersonRow[] | null; personQuery: string; now: number }> = ({ settings, bans, stats, nodes, board, communism, login, people, personQuery, now }) => (
  <>
    <h1>Admin</h1>
    <div class="stats">
      <div class="stat"><b>{stats.users}</b><span>accounts</span></div>
      <div class="stat"><b>{stats.nodesOnline}/{stats.nodes}</b><span>nodes online</span></div>
      <div class="stat"><b>{stats.openOffers}</b><span>open offers</span></div>
      <div class="stat"><b>{stats.swapsDone}</b><span>swaps done</span></div>
      <div class="stat"><b>{board.playerTrades}</b><span>of them with players</span></div>
      <div class="stat"><b>{stats.handoversDone}</b><span>hand-overs done</span></div>
    </div>

    <h2>Version feed</h2>
    <p class="muted">What every node reads at <code>/api/v1/version</code>. List a Realm build under known builds only after confirming the latest node's codecs on it; nodes then open their login gate for it without a canary. The download URL is what the front page and new accounts link to.</p>
    <form method="post" action="/admin/settings" class="panel">
      <div class="row">
        <label class="field">min node version<input name="minNodeVersion" value={settings.minNodeVersion} /></label>
        <label class="field">latest node version<input name="latestNodeVersion" value={settings.latestNodeVersion} /></label>
      </div>
      <div class="row"><label class="field" style="flex:1">download URL<input name="downloadUrl" value={settings.downloadUrl} style="width:100%" /></label></div>
      <div class="row">
        <label class="field">current Realm build<input name="gameVersion" value={settings.gameVersion} /></label>
        <label class="field">known builds<input name="knownBuilds" value={settings.knownBuilds.join(" ")} style="width:300px" /></label>
      </div>
      <div class="row"><button type="submit">Publish</button><span class="muted">last published <When at={settings.buildUpdatedAt || null} /></span></div>
    </form>

    <h2>Sign-in with Realm</h2>
    <p class="muted">One node can be the login node: people sign in here, or prove the character they trade with, by whispering a code to its login desk bot in game. Only a character's own session can /tell as it; no Realm password comes near the hub or the node. Pick a node you trust with that (your own): whoever runs it could claim anyone whispered. With a login node set, communism and trades in game go by proven names only.</p>
    <form method="post" action="/admin/login-node" class="panel">
      <div class="row">
        <label class="field">login node
          <select name="nodeId">
            <option value="" selected={!settings.loginNodeId}>none (typed names, no Realm sign-in)</option>
            {nodes.map((n) => <option value={n.id} selected={n.id === settings.loginNodeId}>{n.name} · {n.owner}{n.last_seen_at !== null && now - n.last_seen_at <= NODE_ONLINE_MS ? " · online" : " · offline"}</option>)}
          </select>
        </label>
        <button type="submit">Save</button>
      </div>
      {login.node.node ? (
        <p class="muted small" style="margin-bottom:0">
          {login.node.online ? <Badge tone="good">online</Badge> : <Badge tone="warn">offline: nobody can sign in with Realm right now</Badge>}{" "}
          login desk: {login.node.desk?.botIgn ? <><code>{login.node.desk.botIgn}</code>{login.node.desk.server ? ` on ${login.node.desk.server}` : ""}</> : login.node.desk?.alwaysOn === false ? "no bot in game now; the node logs one in when someone signs in" : "not reported yet (the node says on its next heartbeat)"} · last 24 h: {login.lastDay.made} code{login.lastDay.made === 1 ? "" : "s"}, {login.lastDay.proven} whispered, {login.lastDay.failed} the node could not take
        </p>
      ) : null}
    </form>

    <h2>Nodes</h2>
    {nodes.length === 0 ? <p class="muted">none linked</p> : (
      <table class="responsive">
        <thead><tr><th>owner</th><th>name</th><th>version</th><th>Realm build</th><th>bots</th><th>proxies</th><th>swaps</th><th>disputes</th><th>players</th><th>seen</th><th></th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr>
              <td data-th="owner">{n.owner}</td>
              <td data-th="name">{n.name} {n.frozen ? <Badge tone="bad">frozen</Badge> : null}</td>
              <td data-th="version">{n.version}</td>
              <td data-th="build">{n.build ?? "—"}{n.status?.gate.held ? <Badge tone="warn"> held</Badge> : null}</td>
              <td data-th="bots">{n.online}/{n.bots}</td>
              <td data-th="proxies">{n.status ? n.status.proxies : "?"}</td>
              <td data-th="swaps">{n.completed_swaps}</td>
              <td data-th="disputes">{board.disputesByNode.get(n.id) ? <span class="bad">{board.disputesByNode.get(n.id)}</span> : <span class="muted">0</span>}</td>
              <td data-th="players">{n.status?.players ? (n.status.players.enabled ? `on (${n.status.players.maxMeetings} at once)` : "off") : "—"}{n.completed_player_trades ? ` · ${n.completed_player_trades} done` : ""}{n.id === settings.loginNodeId ? <Badge tone="accent"> login node</Badge> : null}</td>
              <td data-th="seen"><Online online={n.last_seen_at !== null && now - n.last_seen_at <= NODE_ONLINE_MS} lastSeenAt={n.last_seen_at} /></td>
              <td>
                {n.frozen ? (
                  <form method="post" action={`/admin/nodes/${n.id}/unfreeze`}><button class="quiet small" type="submit">unfreeze</button></form>
                ) : (
                  <form method="post" action={`/admin/nodes/${n.id}/freeze`} class="row" style="margin:0;gap:4px;flex-wrap:nowrap"><input name="reason" placeholder="why" style="width:120px;padding:4px 6px" /><button class="quiet small" type="submit">freeze</button></form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    <h2 id="people">People</h2>
    <p class="muted">Lift a limit for one person. Blank uses the default ({DEFAULT_NODES_PER_ACCOUNT} nodes, {DEFAULT_PLAYER_STARTS_PER_HOUR} trades in game started an hour); 0 means no limit.</p>
    <form method="get" action="/admin#people" class="row">
      <input name="person" value={personQuery} placeholder="display name, email or IGN" aria-label="Find a person" />
      <button class="quiet small" type="submit">Find</button>
    </form>
    {people && (people.length === 0 ? <p class="muted">Nobody matches "{personQuery}".</p> : (
      <table class="responsive">
        <thead><tr><th>person</th><th>email</th><th>characters</th><th>nodes</th><th>limits</th></tr></thead>
        <tbody>
          {people.map((p) => (
            <tr>
              <td data-th="person">{p.display_name}</td>
              <td data-th="email">{p.email ?? "—"}</td>
              <td data-th="characters">{p.igns ?? "—"}</td>
              <td data-th="nodes">{p.nodes}</td>
              <td data-th="limits">
                <form method="post" action={`/admin/people/${p.id}/limits`} class="row" style="margin:0;gap:8px;align-items:flex-end">
                  <input type="hidden" name="q" value={personQuery} />
                  <label class="field">nodes<input name="maxNodes" value={p.max_nodes === null ? "" : String(p.max_nodes)} placeholder={String(DEFAULT_NODES_PER_ACCOUNT)} inputmode="numeric" style="width:90px" /></label>
                  <label class="field">trades in game an hour<input name="playerStartsPerHour" value={p.player_starts_per_hour === null ? "" : String(p.player_starts_per_hour)} placeholder={String(DEFAULT_PLAYER_STARTS_PER_HOUR)} inputmode="numeric" style="width:90px" /></label>
                  <button class="quiet small" type="submit">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ))}

    <h2>Ban telemetry</h2>
    <p class="muted">{stats.nodes} nodes linked · {bans.nodesReporting} have reported · {bans.total} reports, {bans.last24h} in 24h, {bans.last7d} in 7d</p>
    <div class="split">
      <div class="panel">
        <h3>By lane</h3>
        <table><tbody>{bans.byLane.map((r) => <tr><td>{r.lane}</td><td>{r.n}</td></tr>)}</tbody></table>
        <h3>By Realm build</h3>
        <table><tbody>{bans.byBuild.map((r) => <tr><td>{r.build || "?"}</td><td>{r.n}</td></tr>)}</tbody></table>
      </div>
      <div class="panel">
        <h3>By day (30d)</h3>
        <table><tbody>{bans.byDay.map((r) => <tr><td>{r.day}</td><td>{r.n}</td></tr>)}</tbody></table>
      </div>
    </div>

    <h2>Swaps and communism</h2>
    <p class="muted">{board.swaps} completed swap{board.swaps === 1 ? "" : "s"} (meetings whose two receipts matched). {communism.listed} item{communism.listed === 1 ? "" : "s"} listed by {communism.contributors} node{communism.contributors === 1 ? "" : "s"} · {communism.handovers} hand-over{communism.handovers === 1 ? "" : "s"} completed. Items stay on the nodes' communism accounts; nothing here caps it.</p>
    <div class="stats">
      <div class="stat"><b>{communism.accounts}</b><span>communism accounts</span></div>
      <div class="stat"><b>{communism.slots}</b><span>slots</span></div>
      <div class="stat"><b>{communism.free}</b><span>free</span></div>
      <div class="stat"><b>{communism.listed}</b><span>items listed</span></div>
    </div>

    <h2>Disputes</h2>
    <p class="muted">A meeting is disputed when its two sides contradict each other: one node says the trade happened and the other that it did not, or both say it happened but not the same way. That freezes nobody: each side's own report settled its own offer, and neither swap count moved. A node that keeps disagreeing with different partners is worth a look (the disputes column above); freezing it stops its new offers and accepts and hides its offers until you unfreeze it.</p>
    <div class="panel">
      <h3>Disputed meetings</h3>
      {board.disputed.length === 0 ? <p class="muted">none</p> : (
        <table class="responsive">
          <thead><tr><th>#</th><th>offer</th><th>server</th><th>giver</th><th>taker</th><th>reason</th><th>when</th></tr></thead>
          <tbody>
            {board.disputed.map((r) => (
              <tr>
                <td data-th="#">{r.id}</td><td data-th="offer">{r.offer_id ?? "communism"}</td><td data-th="server">{r.server}</td>
                <td data-th="giver">{r.giver_name} <code>{r.giver_bot_ign}</code></td><td data-th="taker">{r.taker_name} <code>{r.taker_bot_ign}</code></td>
                <td data-th="reason">{r.reason ?? "—"}</td><td data-th="when"><When at={r.closed_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>What players reported</h3>
      <p class="muted small">A player's word about a trade in game, after the node's receipt closed it. It freezes nobody; the node's owner was told too.</p>
      {board.reports.length === 0 ? <p class="muted">none</p> : (
        <table class="responsive">
          <thead><tr><th>#</th><th>state</th><th>node</th><th>player</th><th>they said</th><th>when</th></tr></thead>
          <tbody>
            {board.reports.map((r) => (
              <tr>
                <td data-th="#"><a href={`/meetings/${r.id}`}>{r.id}</a></td><td data-th="state">{r.state}</td>
                <td data-th="node">{r.giver_name} <code>{r.giver_bot_ign}</code></td><td data-th="player">{r.taker_name} <code>{r.taker_bot_ign}</code></td>
                <td data-th="they said">{r.player_report}</td><td data-th="when"><When at={r.player_report_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Frozen nodes</h3>
      {board.frozen.length === 0 ? <p class="muted">none</p> : (
        <table class="responsive">
          <thead><tr><th>node</th><th>owner</th><th>why</th><th></th></tr></thead>
          <tbody>
            {board.frozen.map((n) => (
              <tr>
                <td data-th="node">{n.name} <code>{n.id}</code></td><td data-th="owner">{n.owner}</td><td data-th="why">{n.frozen_reason ?? "—"}</td>
                <td><form method="post" action={`/admin/nodes/${n.id}/unfreeze`}><button class="quiet small" type="submit">unfreeze</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </>
);

export function registerAdmin(app: Hono, site: Site): void {
  const { db } = site;
  app.get("/admin", (c) => {
    const user = site.me(c);
    if (!isAdmin(user)) return c.text("not for you", 403);
    const personQuery = (c.req.query("person") ?? "").trim().slice(0, 64);
    return c.html(
      <Layout title="admin" frame={site.frame(user, "admin")}>
        <Admin settings={getSettings(db)} bans={summarize(db)} stats={hubStats(db)} nodes={allNodes(db)} board={operatorView(db)} communism={communismOperatorView(db)} login={loginView(db)} people={personQuery ? findPeople(db, personQuery) : null} personQuery={personQuery} now={Date.now()} />
      </Layout>,
    );
  });
  app.post("/admin/people/:id/limits", async (c) => {
    if (!isAdmin(site.me(c))) return c.text("not for you", 403);
    const f = await c.req.parseBody();
    const maxNodes = parseLimitField(f.maxNodes);
    const playerStartsPerHour = parseLimitField(f.playerStartsPerHour);
    if (maxNodes === undefined || playerStartsPerHour === undefined) return c.text("a limit is a whole number, 0 for no limit, or blank for the default", 400);
    if (!setPersonLimits(db, Number(c.req.param("id")), { maxNodes, playerStartsPerHour })) return c.text("no such person", 404);
    const q = String(f.q ?? "").trim();
    return c.redirect(`/admin${q ? `?person=${encodeURIComponent(q)}` : ""}#people`);
  });
  app.post("/admin/nodes/:id/freeze", async (c) => {
    if (!isAdmin(site.me(c))) return c.text("not for you", 403);
    const f = await c.req.parseBody();
    freezeNode(db, c.req.param("id"), String(f.reason ?? ""));
    return c.redirect("/admin");
  });
  app.post("/admin/nodes/:id/unfreeze", (c) => {
    if (!isAdmin(site.me(c))) return c.text("not for you", 403);
    unfreezeNode(db, c.req.param("id"));
    return c.redirect("/admin");
  });
  // The login node: whose login desk takes the Realm sign-in codes (src/realmLogin.ts). It hears so on its next heartbeat.
  app.post("/admin/login-node", async (c) => {
    if (!isAdmin(site.me(c))) return c.text("not for you", 403);
    const f = await c.req.parseBody();
    const id = String(f.nodeId ?? "").trim();
    if (id && !allNodes(db).some((n) => n.id === id)) return c.text("no such node", 404);
    setSettings(db, { loginNodeId: id });
    return c.redirect("/admin");
  });
  app.post("/admin/settings", async (c) => {
    if (!isAdmin(site.me(c))) return c.text("not for you", 403);
    const f = await c.req.parseBody();
    setSettings(db, {
      minNodeVersion: String(f.minNodeVersion ?? "").trim() || undefined,
      latestNodeVersion: String(f.latestNodeVersion ?? "").trim() || undefined,
      downloadUrl: String(f.downloadUrl ?? "").trim(),
      gameVersion: String(f.gameVersion ?? "").trim(),
      knownBuilds: String(f.knownBuilds ?? "").split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d+(\.\d+)+$/.test(s)),
      buildUpdatedAt: Date.now(),
    });
    return c.redirect("/admin");
  });
}
