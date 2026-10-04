// A trade in game (players.ts): the page the person follows while a node's
// bot comes to meet their character, and the node's owner can look at too.
// It says where to go, what to put up, how many free slots to have, which bot
// to /trade once it is there, and what the node says is happening; while the
// meeting is under way hub.js polls its state and redraws the page on change.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { wantLineWords } from "rotmgtradenode/shared/wantWords";
import { isAdmin, type User } from "../auth";
import { itemName } from "../catalog";
import { cancelPlayerMeeting, confirmPlayerMeeting, playerMeetingFor, playerMeetingRev, reportPlayerMeeting, type PlayerMeetingView } from "../players";
import { Badge, Flash, ItemTile, Layout, Sprite, When, halfName, meetingWords } from "./layout";
import { fields, type Site } from "./context";

/** Stages at which the person should be typing /trade. */
const TRADE_NOW = new Set(["ready", "trading", "holding", "retry"]);

const Wanted: FC<{ v: PlayerMeetingView }> = ({ v }) => (
  <ul class="plain">
    {v.player.wants.map((w) => (
      <li class="row" style="margin:4px 0">
        <Sprite name={itemName(w.itemId)} size={28} />
        <span>{wantLineWords(w, itemName)}</span>
      </li>
    ))}
  </ul>
);

const Meeting: FC<{ v: PlayerMeetingView; me: User; admin: boolean; error?: string; ok?: string }> = ({ v, me, admin, error, ok }) => {
  const mine = v.player.userId === me.id;
  const w = meetingWords(v.state);
  const bot = v.progress?.botIgn ?? v.node.botIgn;
  const server = v.progress?.server ?? v.server;
  const wantsTotal = v.player.wants.reduce((n, l) => n + l.qty, 0);
  const room = Math.max(0, v.node.gives.length - wantsTotal);
  const tradeNow = v.state === "meet" && !!v.progress && TRADE_NOW.has(v.progress.stage);
  return (
    <>
      <p><a href="/me">← my nodes</a></p>
      <div class="row" style="margin-top:0">
        <h1 style="margin:0">Trade in game #{v.id}</h1>
        <Badge tone={w.tone}>{w.text}</Badge>
      </div>
      <p class="muted">
        {mine ? <>You, as <code>{v.player.ign}</code>, with {v.node.owner}'s bot <code>{v.node.botIgn}</code></> : <><b>{v.player.name}</b> as <code>{v.player.ign}</code>, with your node {v.node.name}'s bot <code>{v.node.botIgn}</code></>}
        {" "}on {v.server} · {halfName(v.seasonal)} · offer #{v.offerId ?? "?"} · started <When at={v.createdAt} />
      </p>
      <Flash error={error} ok={ok} />
      <div data-poll={v.state === "meet" ? `/meetings/${v.id}/state.json` : undefined} data-rev={playerMeetingRev(v)}>
        <div class="panel">
          {v.state === "meet" ? (
            <>
              <p style="margin-top:0;font-size:1.15em"><b>{v.progress?.detail ?? `Waiting for ${v.node.owner}'s node to pick the meeting up (it checks every few seconds).`}</b></p>
              {tradeNow ? (
                <p class="row"><span class="code" id="tradeline">/trade {bot}</span><button type="button" class="quiet small" data-copy={`/trade ${bot}`}>copy</button><span class="muted">on {server}, in the nexus</span></p>
              ) : null}
              <p class="muted small" style="margin-bottom:0">The meeting lasts until <When at={v.deadlineAt} />. This page follows the node as it goes.</p>
            </>
          ) : v.state === "done" ? (
            <p style="margin:0"><b>Done.</b> {mine ? "You got" : `${v.player.name} got`} {v.node.gives.length} item{v.node.gives.length === 1 ? "" : "s"}{v.player.gave.length ? <> for {v.player.gave.length}</> : null}. {v.reason ? <span class="muted">({v.reason})</span> : null}</p>
          ) : (
            <p style="margin:0">{v.state === "aborted" ? "Called off" : "It did not happen"}{v.reason ? `: ${v.reason}` : ""}.{v.noShow ? " Counted as not coming." : ""} {v.offerId ? "The offer is open again." : null}</p>
          )}
        </div>

        <div class="split">
          <div class="panel">
            <h3>{mine ? "You put up" : "They put up"}</h3>
            {v.state === "done" && v.player.gave.length ? (
              <div class="tiles">{v.player.gave.map((g) => <ItemTile itemId={g.itemId} enchants={g.enchants} count={g.count} />)}</div>
            ) : <Wanted v={v} />}
            {v.state === "meet" && <p class="muted small">Exactly this, nothing else. The bot checks each item, enchantments included, and holds off (saying why here) until it fits.</p>}
          </div>
          <div class="panel">
            <h3>{mine ? "You get" : "They get"}</h3>
            <div class="tiles">{v.node.gives.map((g) => <ItemTile itemId={g.itemId} enchants={g.enchants} count={g.count} />)}</div>
          </div>
        </div>

        {mine && v.state === "meet" && (
          <div class="panel">
            <h3>How it goes</h3>
            <ol class="steps">
              <li><b>Log in to <code>{v.player.ign}</code></b><span class="muted">A {halfName(v.seasonal)} character: the trade window only opens between two of the same kind.</span></li>
              <li><b>Go to {v.server} and stay in the nexus</b><span class="muted">{room ? `Have ${room} free inventory slot${room === 1 ? "" : "s"}: you get ${v.node.gives.length} and give ${wantsTotal}.` : "Your items make room for what you get."}</span></li>
              <li><b>When the bot is there, type /trade {bot}</b><span class="muted">It also invites you once when it sees you. It puts its items up first.</span></li>
              <li><b>Put up what is listed and accept</b><span class="muted">The bot accepts after you, never first; the trade is all or nothing. A closed window is fine: /trade again.</span></li>
            </ol>
            <form method="post" action={`/meetings/${v.id}/cancel`} class="row"><button class="quiet small" type="submit">Call this trade off</button><span class="muted small">the offer opens again; it does not count against you</span></form>
          </div>
        )}
        {mine && v.state === "done" && (
          <div class="panel">
            {v.confirmedAt ? <p class="good" style="margin:0">You confirmed you got your items. Thanks.</p> : (
              <form method="post" action={`/meetings/${v.id}/confirm`} class="row" style="margin:0"><button type="submit">I got my items</button><span class="muted small">a thank-you the node's owner sees</span></form>
            )}
          </div>
        )}
        {mine && v.state !== "meet" && (
          <details class="panel" open={!!v.report}>
            <summary><b>Something went wrong?</b></summary>
            {v.report ? <p class="muted">You reported: “{v.report}”. The hub's operator and the node's owner have it.</p> : (
              <form method="post" action={`/meetings/${v.id}/report`} class="stack">
                <textarea name="text" rows={3} placeholder="What happened, in your words" maxlength={500} required />
                <div class="row"><button type="submit" class="quiet">Report it</button><span class="muted small">goes to the operator and the node's owner; it does not freeze anyone</span></div>
              </form>
            )}
          </details>
        )}
        {!mine && (
          <p class="muted small">{admin && v.node.ownerId !== me.id ? "You see this as the operator." : "This is your node's offer. Your node runs the meeting by itself; the Control panel's trade list shows its timeline."}{v.report ? <> The player reported: “{v.report}”.</> : null}{v.confirmedAt ? " The player confirmed they got their items." : ""}</p>
        )}
      </div>
    </>
  );
};

export function registerMeetings(app: Hono, site: Site): void {
  const { db } = site;
  const load = (c: import("hono").Context): { user: User; v: PlayerMeetingView } | Response => {
    const user = site.me(c);
    if (!user) return c.redirect(`/?next=${encodeURIComponent(c.req.path)}`);
    const id = Number(c.req.param("id"));
    const v = Number.isInteger(id) && id > 0 ? playerMeetingFor(db, id, { id: user.id, admin: isAdmin(user) }) : null;
    if (!v) return c.text("no such trade", 404);
    return { user, v };
  };
  app.get("/meetings/:id", (c) => {
    const got = load(c);
    if (got instanceof Response) return got;
    return c.html(
      <Layout title={`trade #${got.v.id}`} frame={site.frame(got.user, "me")}>
        <Meeting v={got.v} me={got.user} admin={isAdmin(got.user)} error={c.req.query("error")} ok={c.req.query("ok")} />
      </Layout>,
    );
  });
  // hub.js asks this every few seconds while the meeting is under way, and redraws the page when it changes.
  app.get("/meetings/:id/state.json", (c) => {
    const got = load(c);
    if (got instanceof Response) return c.json({ error: "not found" }, 404);
    return c.json({ rev: playerMeetingRev(got.v), state: got.v.state }, 200, { "cache-control": "no-store" });
  });
  const act = (name: "cancel" | "confirm" | "report") => async (c: import("hono").Context) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const id = Number(c.req.param("id"));
    const { one } = fields(await c.req.parseBody({ all: true }));
    const r = name === "cancel" ? cancelPlayerMeeting(db, user, id) : name === "confirm" ? confirmPlayerMeeting(db, user, id) : reportPlayerMeeting(db, user, id, one("text"));
    const msg = r.ok ? `ok=${encodeURIComponent(name === "cancel" ? "Called off. The offer is open again." : name === "confirm" ? "Thanks: noted." : "Reported. The operator and the node's owner have it.")}` : `error=${encodeURIComponent(r.error)}`;
    return c.redirect(`/meetings/${id}?${msg}`);
  };
  app.post("/meetings/:id/cancel", act("cancel"));
  app.post("/meetings/:id/confirm", act("confirm"));
  app.post("/meetings/:id/report", act("report"));
}
