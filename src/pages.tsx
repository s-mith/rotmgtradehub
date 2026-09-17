// Server-rendered pages. Plain forms, no client script: the hub website is
// for accounts and nodes; the node's own UI does the heavy lifting.
import type { FC, PropsWithChildren } from "hono/jsx";
import type { GuestRequestWire, OfferWire } from "rotmgtradenode/shared/hubWire";
import type { User } from "./auth";
import type { CommonsBoardItem, commonsOperatorView } from "./commons";
import type { HubSettings } from "./db";
import type { GuestVaultView, HalfView } from "./grants";
import type { NodeRow } from "./nodes";
import type { operatorView } from "./offers";
import type { BanSummary } from "./telemetry";

const CSS = `
:root{--bg:#0e0f13;--panel:#181a22;--border:#2a2e3a;--text:#e8e6df;--muted:#9aa0ad;--accent:#d4a13b;--bad:#e06c6c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 80px}a{color:var(--accent)}h1{font-size:22px}h2{font-size:16px;margin-top:28px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0}
input,button,select,textarea{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:#111;color:var(--text)}textarea{width:100%;min-height:72px}
button{background:var(--accent);color:#000;border:0;font-weight:600;cursor:pointer}button.quiet{background:transparent;color:var(--muted);border:1px solid var(--border)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.muted{color:var(--muted)}.bad{color:var(--bad)}.good{color:#7cc46c}
.pick{display:block;padding:4px 0}.pick input{margin-right:8px}
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
    <p class="muted">Accounts for rotmgtradenode nodes. Your vault runs on your own computer; this site only lets nodes find each other.</p>
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
    <p><a href="/vaults">my vaults on other people's nodes →</a> · <a href="/commons">the commons →</a></p>
    <h2>My nodes</h2>
    {nodes.length === 0 ? (
      <p class="muted">No node linked yet. In rotmgtradenode, open the node console → Fleet → Node and log in with this account.</p>
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

export const Admin: FC<{ settings: HubSettings; bans: BanSummary; nodes: number; board: ReturnType<typeof operatorView>; commons: ReturnType<typeof commonsOperatorView> }> = ({ settings, bans, nodes, board, commons }) => (
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
      <div class="row"><label>commons daily cap <input name="commonsDailyCap" type="number" min={0} max={100} value={String(settings.commonsDailyCap)} style="width:80px" /></label>
        <span class="muted">hand-overs one node may take per rolling 24 h (0 closes the commons to takers)</span></div>
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
    <h2>Swaps</h2>
    <p class="muted">{board.swaps} completed swap{board.swaps === 1 ? "" : "s"} (rendezvous whose two receipts matched).</p>
    <h2>Commons</h2>
    <p class="muted">{commons.listed} item{commons.listed === 1 ? "" : "s"} listed by {commons.contributors} node{commons.contributors === 1 ? "" : "s"} · {commons.handovers} hand-over{commons.handovers === 1 ? "" : "s"} completed. Items stay on the contributors' bots; the cap above is the only limit.</p>
    <h2>Disputes</h2>
    <p class="muted">A rendezvous whose receipts disagree freezes both nodes: no new offers or accepts until you unfreeze them here. Look at both receipts before you do.</p>
    <div class="panel">
      <b>Disputed rendezvous</b>
      {board.disputed.length === 0 ? <p class="muted">none</p> : (
        <table>
          <thead><tr><th>#</th><th>offer</th><th>server</th><th>giver</th><th>taker</th><th>reason</th><th>when</th></tr></thead>
          <tbody>
            {board.disputed.map((r) => (
              <tr>
                <td>{r.id}</td><td>{r.offer_id ?? "commons"}</td><td>{r.server}</td>
                <td>{r.giver_name} <code>{r.giver_bot_ign}</code></td><td>{r.taker_name} <code>{r.taker_bot_ign}</code></td>
                <td>{r.reason ?? "—"}</td><td>{when(r.closed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <b>Frozen nodes</b>
      {board.frozen.length === 0 ? <p class="muted">none</p> : (
        <table>
          <thead><tr><th>node</th><th>owner</th><th>why</th><th></th></tr></thead>
          <tbody>
            {board.frozen.map((n) => (
              <tr>
                <td>{n.name} <code>{n.id}</code></td><td>{n.owner}</td><td>{n.frozen_reason ?? "—"}</td>
                <td><form method="post" action={`/admin/nodes/${n.id}/unfreeze`}><button class="quiet" type="submit">unfreeze</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </>
);

// --- phase 4b: a guest's vaults ---------------------------------------------

const slots = (h: HalfView) => `${h.used}/${h.granted}`;

export const Vaults: FC<{ user: User; vaults: GuestVaultView[] }> = ({ user, vaults }) => (
  <>
    <p><a href="/me">← my nodes</a></p>
    <h2>My vaults</h2>
    <p class="muted">Vaults other players' nodes keep for <b>{user.displayName}</b>. Items stay on their computer; this page only queues what you would like their bot to do.</p>
    {vaults.length === 0 ? (
      <p class="muted">Nobody has granted you a vault yet. The owner adds your email in their node's console.</p>
    ) : (
      <table>
        <thead><tr><th>owner</th><th>node</th><th>online</th><th>as</th><th>seasonal</th><th>non-seasonal</th><th>role</th><th>trade</th><th></th></tr></thead>
        <tbody>
          {vaults.map((v) => (
            <tr>
              <td>{v.owner}</td><td>{v.nodeName}</td>
              <td>{v.online ? <span class="good">online</span> : <span class="muted">last seen {when(v.lastSeenAt)}</span>}</td>
              <td><code>{v.ign}</code></td><td>{slots(v.seasonal)}</td><td>{slots(v.nonseasonal)}</td>
              <td>{v.role}{v.paused && <span class="bad"> (paused)</span>}</td><td>{v.trade ? "yes" : "no"}</td>
              <td><a href={`/vaults/${v.nodeId}`}>open</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
);

const Half: FC<{ vault: GuestVaultView; seasonal: boolean; nodeId: string }> = ({ vault, seasonal, nodeId }) => {
  const h = seasonal ? vault.seasonal : vault.nonseasonal;
  const label = seasonal ? "Seasonal" : "Non-seasonal";
  const canWithdraw = vault.role !== "deposit";
  const free = Math.max(0, h.slots - h.used);
  const action = `/vaults/${nodeId}/requests`;
  return (
    <div class="panel">
      <h2 style="margin-top:0">{label} <span class="muted">{h.used} of {h.granted} slots used{h.publishedAt ? ` · published ${when(h.publishedAt)}` : " · not published yet"}</span></h2>
      <form method="post" action={action} class="row">
        <input type="hidden" name="kind" value="deposit" />
        <input type="hidden" name="seasonal" value={seasonal ? "1" : "0"} />
        <label>deposit <input name="count" type="number" min={1} max={Math.min(24, free)} value="1" style="width:70px" /> item(s)</label>
        <label>on <input name="server" placeholder="server e.g. USEast" required style="width:150px" /></label>
        <button type="submit" disabled={free === 0 || vault.paused}>queue deposit</button>
        <span class="muted">{free} free</span>
      </form>
      <form method="post" action={action}>
        <input type="hidden" name="seasonal" value={seasonal ? "1" : "0"} />
        {h.items.length === 0 ? <p class="muted">nothing here</p> : (
          <div>
            {h.items.map((it) => (
              <label class="pick">
                <input type="checkbox" name="refs" value={it.ref} />
                {it.name || it.itemId} <span class="muted">· {it.count} enchant{it.count === 1 ? "" : "s"}{it.enchants ? ` (${it.enchants.join(", ")})` : ""} · {it.online ? "online" : "offline"}</span>
              </label>
            ))}
          </div>
        )}
        <div class="row">
          <label>meet on <input name="server" placeholder="server" style="width:150px" /></label>
          {canWithdraw ? <button type="submit" name="kind" value="withdraw" disabled={vault.paused || h.items.length === 0}>withdraw picked</button> : <span class="muted">your grant allows deposits only</span>}
        </div>
        {vault.trade && (
          <>
            <p class="muted" style="margin-bottom:4px">Offer the picked items for, one per line: <code>itemId qty [minEnchants] [exactEnchants]</code></p>
            <textarea name="want" placeholder="Ring 2&#10;Cloak 1 3"></textarea>
            <div class="row"><button type="submit" name="kind" value="offer-create" disabled={vault.paused || h.items.length === 0}>post offer with picked</button></div>
          </>
        )}
      </form>
    </div>
  );
};

const describe = (r: GuestRequestWire): string => {
  switch (r.kind) {
    case "deposit": return `deposit ${r.count} on ${r.server}`;
    case "withdraw": return `withdraw ${r.refs?.length ?? 0} on ${r.server}`;
    case "offer-create": return `offer ${r.refs?.length ?? 0} item(s) for ${(r.want ?? []).map((w) => `${w.qty}× ${w.itemId}`).join(", ")} on ${r.server}`;
    case "offer-accept": return `accept offer #${r.offerId}`;
    case "offer-cancel": return `cancel offer #${r.offerId}`;
  }
};

export const Vault: FC<{ user: User; vault: GuestVaultView; requests: GuestRequestWire[]; board: OfferWire[]; error?: string; queued?: string }> = ({ user, vault, requests, board, error, queued }) => {
  const action = `/vaults/${vault.nodeId}/requests`;
  const mine = board.filter((o) => o.mine && o.onBehalfOf === user.id);
  const theirs = board.filter((o) => !o.mine);
  return (
    <>
      <p><a href="/vaults">← my vaults</a></p>
      <h2>{vault.owner}'s node <span class="muted">{vault.nodeName}</span> {vault.online ? <span class="good">online</span> : <span class="muted">last seen {when(vault.lastSeenAt)}</span>}</h2>
      <p class="muted">You trade there as <code>{vault.ign}</code>: their bot only trades with that name. Role <b>{vault.role}</b>{vault.trade ? ", may trade" : ""}.{vault.paused && <span class="bad"> The owner paused your access.</span>}</p>
      {error && <p class="bad">{error}</p>}
      {queued && <p class="good">Request #{queued} queued. The node picks it up on its next poll; meet its bot on the server you named.</p>}
      <Half vault={vault} seasonal nodeId={vault.nodeId} />
      <Half vault={vault} seasonal={false} nodeId={vault.nodeId} />
      {vault.trade && (
        <div class="panel">
          <h2 style="margin-top:0">Offers</h2>
          <b>Mine</b>
          {mine.length === 0 ? <p class="muted">none open</p> : (
            <table>
              <thead><tr><th>#</th><th>gives</th><th>wants</th><th>server</th><th></th></tr></thead>
              <tbody>
                {mine.map((o) => (
                  <tr>
                    <td>{o.id}</td><td>{o.give.map((g) => g.itemId).join(", ")}</td><td>{o.want.map((w) => `${w.qty}× ${w.itemId}`).join(", ")}</td><td>{o.server}</td>
                    <td><form method="post" action={action}><input type="hidden" name="kind" value="offer-cancel" /><input type="hidden" name="offerId" value={String(o.id)} /><button class="quiet" type="submit">cancel</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <b>Open on the board</b>
          {theirs.length === 0 ? <p class="muted">none</p> : (
            <table>
              <thead><tr><th>#</th><th>poster</th><th>gives</th><th>wants</th><th>half</th><th>server</th><th></th></tr></thead>
              <tbody>
                {theirs.map((o) => (
                  <tr>
                    <td>{o.id}</td><td>{o.poster}</td><td>{o.give.map((g) => g.itemId).join(", ")}</td><td>{o.want.map((w) => `${w.qty}× ${w.itemId}`).join(", ")}</td>
                    <td>{o.seasonal ? "seasonal" : "non-seasonal"}</td><td>{o.server}</td>
                    <td><form method="post" action={action}><input type="hidden" name="kind" value="offer-accept" /><input type="hidden" name="offerId" value={String(o.id)} /><button class="quiet" type="submit" disabled={vault.paused}>accept</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <h2>Recent requests</h2>
      {requests.length === 0 ? <p class="muted">none yet</p> : (
        <table>
          <thead><tr><th>#</th><th>what</th><th>half</th><th>state</th><th>result</th><th>when</th></tr></thead>
          <tbody>
            {requests.map((r) => (
              <tr>
                <td>{r.id}</td><td>{describe(r)}</td><td>{r.seasonal ? "seasonal" : "non-seasonal"}</td>
                <td class={r.state === "failed" || r.state === "expired" ? "bad" : r.state === "done" ? "good" : ""}>{r.state}</td>
                <td>{r.result ? (r.result.ok ? r.result.detail ?? "ok" : r.result.error ?? "failed") : <span class="muted">—</span>}</td>
                <td>{when(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

// --- phase 4: the commons ---------------------------------------------------

const ago = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)} min ago`;
};

export const Commons: FC<{ items: CommonsBoardItem[]; dailyCap: number; now: number }> = ({ items, dailyCap, now }) => (
  <>
    <p><a href="/me">← my nodes</a></p>
    <h2>The commons</h2>
    <p class="muted">Items other players' nodes give away, free: no points, nothing owed. They stay on the contributor's bots until taken. A node may take up to <b>{dailyCap}</b> per 24 hours, from its own console; only contributors seen in the last few minutes are shown.</p>
    {items.length === 0 ? <p class="muted">Nothing is listed right now.</p> : (
      <table>
        <thead><tr><th>item</th><th>enchants</th><th>half</th><th>contributor</th><th>node</th></tr></thead>
        <tbody>
          {items.map((it) => (
            <tr>
              <td>{it.name || it.itemId}</td><td>{it.count}</td><td>{it.seasonal ? "seasonal" : "non-seasonal"}</td>
              <td>{it.contributor}</td><td><span class="good">online</span> <span class="muted">seen {ago(it.lastSeenAt, now)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </>
);
