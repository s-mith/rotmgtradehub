// Server-rendered pages. Plain forms, no client script: the hub website is
// for accounts and nodes; the node's own UI does the heavy lifting.
import type { FC, PropsWithChildren } from "hono/jsx";
import type { User } from "./auth";
import type { HubSettings } from "./db";
import type { NodeRow } from "./nodes";
import type { BanSummary } from "./telemetry";

const CSS = `
:root{--bg:#0e0f13;--panel:#181a22;--border:#2a2e3a;--text:#e8e6df;--muted:#9aa0ad;--accent:#d4a13b;--bad:#e06c6c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 80px}a{color:var(--accent)}h1{font-size:22px}h2{font-size:16px;margin-top:28px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0}
input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:#111;color:var(--text)}
button{background:var(--accent);color:#000;border:0;font-weight:600;cursor:pointer}button.quiet{background:transparent;color:var(--muted);border:1px solid var(--border)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.muted{color:var(--muted)}.bad{color:var(--bad)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}code{color:var(--muted)}
`;

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{CSS}</style>
    </head>
    <body>
      <main>
        <h1>rotmgtradehub</h1>
        {children}
      </main>
    </body>
  </html>
);

export const Home: FC<{ error?: string }> = ({ error }) => (
  <>
    <p class="muted">Accounts for rotmgtrade nodes. Your vault runs on your own computer; this site only lets nodes find each other.</p>
    {error && <p class="bad">{error}</p>}
    <div class="panel">
      <h2 style="margin-top:0">Log in</h2>
      <form method="post" action="/login" class="row">
        <input name="email" type="email" placeholder="email" required />
        <input name="password" type="password" placeholder="password" required />
        <button type="submit">Log in</button>
      </form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Create an account</h2>
      <form method="post" action="/register" class="row">
        <input name="name" placeholder="display name" required />
        <input name="email" type="email" placeholder="email" required />
        <input name="password" type="password" placeholder="password (10+ chars)" required minlength={10} />
        <button type="submit">Create</button>
      </form>
    </div>
    <p class="muted">Then, in your node's console (Fleet → Node), log in with this account to link the node.</p>
  </>
);

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "never");

export const Me: FC<{ user: User; nodes: (NodeRow & { bots: number; online: number })[]; admin: boolean }> = ({ user, nodes, admin }) => (
  <>
    <div class="row">
      <span>Signed in as <b>{user.displayName}</b> <span class="muted">({user.email})</span></span>
      <form method="post" action="/logout" style="margin-left:auto"><button class="quiet" type="submit">log out</button></form>
      {admin && <a href="/admin">admin</a>}
    </div>
    <h2>My nodes</h2>
    {nodes.length === 0 ? (
      <p class="muted">No node linked yet. In rotmgtrade, open the node console → Fleet → Node and log in with this account.</p>
    ) : (
      <table>
        <thead><tr><th>name</th><th>node id</th><th>version</th><th>Realm build</th><th>bots</th><th>last seen</th><th></th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr>
              <td>{n.name}</td><td><code>{n.id}</code></td><td>{n.version}</td><td>{n.build ?? "—"}</td>
              <td>{n.online}/{n.bots} online</td><td>{when(n.last_seen_at)}</td>
              <td><form method="post" action={`/me/nodes/${n.id}/unlink`}><button class="quiet" type="submit">unlink</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
);

export const Admin: FC<{ settings: HubSettings; bans: BanSummary; nodes: number }> = ({ settings, bans, nodes }) => (
  <>
    <p><a href="/me">← my nodes</a></p>
    <h2>Version feed</h2>
    <p class="muted">What every node reads at <code>/api/v1/version</code>. List a Realm build under known builds only after confirming the latest node's codecs on it; nodes then open their login gate for it without a canary.</p>
    <form method="post" action="/admin/settings" class="panel">
      <div class="row"><label>min node version <input name="minNodeVersion" value={settings.minNodeVersion} /></label>
        <label>latest node version <input name="latestNodeVersion" value={settings.latestNodeVersion} /></label></div>
      <div class="row"><label>download URL <input name="downloadUrl" value={settings.downloadUrl} style="width:360px" /></label></div>
      <div class="row"><label>current Realm build <input name="gameVersion" value={settings.gameVersion} /></label>
        <label>known builds <input name="knownBuilds" value={settings.knownBuilds.join(" ")} style="width:300px" /></label></div>
      <div class="row"><button type="submit">Publish</button><span class="muted">last published {when(settings.buildUpdatedAt || null)}</span></div>
    </form>
    <h2>Ban telemetry</h2>
    <p class="muted">{nodes} nodes linked · {bans.nodesReporting} have reported · {bans.total} reports, {bans.last24h} in 24h, {bans.last7d} in 7d</p>
    <div class="panel">
      <b>By lane</b>
      <table><tbody>{bans.byLane.map((r) => <tr><td>{r.lane}</td><td>{r.n}</td></tr>)}</tbody></table>
      <b>By Realm build</b>
      <table><tbody>{bans.byBuild.map((r) => <tr><td>{r.build || "?"}</td><td>{r.n}</td></tr>)}</tbody></table>
      <b>By day (30d)</b>
      <table><tbody>{bans.byDay.map((r) => <tr><td>{r.day}</td><td>{r.n}</td></tr>)}</tbody></table>
    </div>
  </>
);
