// One offer, by its link (/offers/:id): what it gives and wants, and what the
// person looking at it can do with it. There is no board of offers here
// (offers are posted and browsed on the nodes); a node's owner shares the link
// of an offer from "My nodes", and whoever opens it may:
//  - take it with their own character: "Trade in game" (players.ts), when
//    the poster's node takes trades with players;
//  - take it with a node of their own: an `offer-accept` request the node
//    runs within a minute (requests.ts);
//  - cancel it, from the node that posted it: an `offer-cancel` request.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import type { OfferItemWire, WantLineWire } from "rotmgtradenode/shared/hubWire";
import { wantLineWords } from "rotmgtradenode/shared/wantWords";
import { type User } from "../auth";
import { itemName } from "../catalog";
import { nodesOf } from "../nodes";
import { offerHeldBy, posterOf, sweepRendezvous, type OfferRow } from "../offers";
import { playerTradesOf, startPlayerMeeting } from "../players";
import { createGuestRequest } from "../requests";
import { Badge, Flash, ItemTile, Layout, Sprite, When, halfName } from "./layout";
import { fields, type Site } from "./context";

interface OfferPage {
  o: OfferRow;
  poster: string;
  give: OfferItemWire[];
  want: WantLineWire[];
  held: boolean;
  /** Whether the poster's node takes trades with players now, and the servers it meets on. */
  players: { ok: true; servers: string[] } | { ok: false; why: string };
}

const OfferView: FC<{ p: OfferPage; me: User | null; mine: boolean; myNodes: { id: string; name: string }[]; error?: string; ok?: string }> = ({ p, me, mine, myNodes, error, ok }) => {
  const { o } = p;
  const open = o.status === "open" && !p.held;
  const servers = p.players.ok && p.players.servers.length ? p.players.servers : [o.server];
  return (
    <>
      <div class="row" style="margin-top:0">
        <h1 style="margin:0">Offer #{o.id}</h1>
        <Badge tone={open ? "good" : "muted"}>{p.held ? "in another trade" : o.status}</Badge>
      </div>
      <p class="muted">From {p.poster} · {halfName(!!o.seasonal)} · meets on {o.server} · posted <When at={o.created_at} /></p>
      <Flash error={error} ok={ok} />
      <div class="split">
        <div class="panel">
          <h3>Gives</h3>
          <div class="tiles">{p.give.map((g) => <ItemTile itemId={g.itemId} enchants={g.enchants} count={g.count} />)}</div>
        </div>
        <div class="panel">
          <h3>Wants</h3>
          <ul class="plain">
            {p.want.map((w) => (
              <li class="row" style="margin:4px 0"><Sprite name={itemName(w.itemId)} size={28} /><span>{wantLineWords(w, itemName)}</span></li>
            ))}
          </ul>
        </div>
      </div>
      {!me ? (
        <p class="muted"><a href={`/?next=${encodeURIComponent(`/offers/${o.id}`)}`}>Sign in</a> to take this offer.</p>
      ) : mine ? (
        open || o.status === "open" ? (
          <form method="post" action={`/offers/${o.id}/cancel`} class="row panel"><button class="quiet" type="submit">Cancel this offer</button><span class="muted small">your node withdraws it within a minute</span></form>
        ) : null
      ) : open ? (
        <>
          <div class="panel">
            <h3>Trade in game</h3>
            {p.players.ok ? (
              <form method="post" action={`/offers/${o.id}/trade`} class="row">
                <select name="server">{servers.map((s) => <option value={s} selected={s === o.server}>{s}</option>)}</select>
                <button type="submit">Trade in game</button>
                <span class="muted small">with your own {halfName(!!o.seasonal)} character; the node's bot meets you in the nexus</span>
              </form>
            ) : <p class="muted" style="margin:0">Not with this node right now: {p.players.why}.</p>}
          </div>
          {myNodes.length > 0 && (
            <form method="post" action={`/offers/${o.id}/accept`} class="row panel">
              <select name="node">{myNodes.map((n) => <option value={n.id}>{n.name}</option>)}</select>
              <button class="quiet" type="submit">Take it with my node</button>
              <span class="muted small">your node picks the items that fit and meets the poster's bot</span>
            </form>
          )}
        </>
      ) : null}
    </>
  );
};

export function registerOffers(app: Hono, site: Site): void {
  const { db } = site;
  const load = (id: number): OfferPage | null => {
    sweepRendezvous(db);
    const o = Number.isInteger(id) && id > 0 ? (db.prepare("SELECT * FROM offers WHERE id = ?").get(id) as OfferRow | undefined) : undefined;
    if (!o) return null;
    const players = playerTradesOf(db, o.node_id);
    return {
      o,
      poster: posterOf(db, o.node_id),
      give: JSON.parse(o.give_json) as OfferItemWire[],
      want: JSON.parse(o.want_json) as WantLineWire[],
      held: o.status === "open" && offerHeldBy(db, o) !== null,
      players: players.ok ? { ok: true, servers: players.players.servers } : { ok: false, why: players.why },
    };
  };
  const ownerOf = (nodeId: string): number | null => (db.prepare("SELECT user_id FROM nodes WHERE id = ?").get(nodeId) as { user_id: number } | undefined)?.user_id ?? null;
  app.get("/offers/:id", (c) => {
    const p = load(Number(c.req.param("id")));
    if (!p) return c.text("no such offer", 404);
    const me = site.me(c);
    const mine = !!me && ownerOf(p.o.node_id) === me.id;
    const myNodes = me && !mine ? nodesOf(db, me.id).map((n) => ({ id: n.id, name: n.name })) : [];
    return c.html(
      <Layout title={`offer #${p.o.id}`} frame={site.frame(me)}>
        <OfferView p={p} me={me} mine={mine} myNodes={myNodes} error={c.req.query("error")} ok={c.req.query("ok")} />
      </Layout>,
    );
  });
  const back = (id: number, msg: { ok?: string; error?: string }) => `/offers/${id}?${msg.ok ? `ok=${encodeURIComponent(msg.ok)}` : `error=${encodeURIComponent(msg.error ?? "")}`}`;
  app.post("/offers/:id/trade", async (c) => {
    const user = site.me(c);
    const id = Number(c.req.param("id"));
    if (!user) return c.redirect(`/?next=${encodeURIComponent(`/offers/${id}`)}`);
    const { one } = fields(await c.req.parseBody({ all: true }));
    const r = startPlayerMeeting(db, user, id, { server: one("server") || undefined });
    return r.ok ? c.redirect(`/meetings/${r.id}`) : c.redirect(back(id, { error: r.error }));
  });
  app.post("/offers/:id/accept", async (c) => {
    const user = site.me(c);
    const id = Number(c.req.param("id"));
    if (!user) return c.redirect(`/?next=${encodeURIComponent(`/offers/${id}`)}`);
    const { one } = fields(await c.req.parseBody({ all: true }));
    const r = createGuestRequest(db, user, one("node"), { kind: "offer-accept", offerId: id });
    return r.ok ? c.redirect(`/me?ok=${encodeURIComponent(`Request #${r.request.id} queued: your node takes offer #${id} within a minute; the meeting then shows here.`)}#request-${r.request.id}`) : c.redirect(back(id, { error: r.error }));
  });
  app.post("/offers/:id/cancel", (c) => {
    const user = site.me(c);
    const id = Number(c.req.param("id"));
    if (!user) return c.redirect("/");
    const o = db.prepare("SELECT node_id FROM offers WHERE id = ?").get(id) as { node_id: string } | undefined;
    if (!o) return c.text("no such offer", 404);
    const r = createGuestRequest(db, user, o.node_id, { kind: "offer-cancel", offerId: id });
    return r.ok ? c.redirect(back(id, { ok: "Your node withdraws the offer within a minute." })) : c.redirect(back(id, { error: r.error }));
  });
}
