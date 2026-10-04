// The hub: API for nodes (docs/hub-protocol.md in the node repo) and a
// website for people (src/site). No bots, no items, no game credentials
// anywhere here.
import { Hono } from "hono";
import type { AcceptOfferRequest, CommunismGiveRequest, CommunismWithdrawRequest, CreateOfferRequest, HeartbeatRequest, LinkRequest, PublishCommunismRequest, VersionInfo } from "rotmgtradenode/shared/hubWire";
import { getSettings, type Db } from "./db";
import { googleFromEnv, type GoogleOptions } from "./google";
import { discordFromEnv, type DiscordOptions } from "./discord";
import { linkNode, parseJson, recordHeartbeat, signedByNode, unlinkNode } from "./nodes";
import { abortRendezvous, acceptOffer, cancelOffer, createOffer, extendRendezvous, listMine, listOpen, rendezvousFor, renewOffer, submitReceipt } from "./offers";
import { MAX_REQUEST_WAIT_S, submitResult, takePendingRequests, waitForRequest } from "./requests";
import { recordProgress } from "./players";
import { isLoginNode, markLoginReady, markLoginVerified, MAX_LOGIN_WAIT_S, takePendingLogins, waitForLogin } from "./realmLogin";
import { compress } from "hono/compress";
import { watchNodes } from "./communismLive";
import { communismNodes, communismStatus, giveCommunism, listCommunism, listMine as listMyCommunism, publishCommunism, withdrawCommunism } from "./communism";
import { acceptReports } from "./telemetry";
import { rateLimit } from "./ratelimit";
import { registerStatic } from "./static";
import { Site } from "./site/context";
import { registerAuth } from "./site/auth";
import { registerHome } from "./site/home";
import { registerMe } from "./site/me";
import { registerActivity } from "./site/activity";
import { registerSettings } from "./site/settings";
import { registerCommunism } from "./site/communism";
import { registerAdmin } from "./site/admin";
import { registerDiscordAuth } from "./site/discordAuth";
import { registerMeetings } from "./site/meetings";
import { registerRealmAuth } from "./site/realm";
import { registerOffers } from "./site/offers";

export interface AppOptions {
  /** Google sign-in; undefined reads GOOGLE_CLIENT_ID/SECRET from the environment, null turns it off. */
  google?: GoogleOptions | null;
  /** Discord sign-in; undefined reads DISCORD_CLIENT_ID/SECRET from the environment, null turns it off. */
  discord?: DiscordOptions | null;
}

export function createApp(db: Db, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const google = opts.google === undefined ? googleFromEnv() : opts.google;
  const discord = opts.discord === undefined ? discordFromEnv() : opts.discord;

  // ---- API for nodes -------------------------------------------------------
  app.get("/api/v1/version", (c) => {
    const s = getSettings(db);
    const v: VersionInfo = { minNodeVersion: s.minNodeVersion, latestNodeVersion: s.latestNodeVersion, downloadUrl: s.downloadUrl, build: { gameVersion: s.gameVersion, knownBuilds: s.knownBuilds, updatedAt: s.buildUpdatedAt } };
    return c.json(v, 200, { "cache-control": "public, max-age=60" });
  });

  // Secret-bearing routes: a handful of tries per IP, then wait.
  // Pages, the catalog and the API answers shrink several-fold on the wire; event streams are left alone.
  app.use("*", compress());
  watchNodes(db);
  app.use("/api/v1/nodes/link", rateLimit("link", 10, 15 * 60_000));
  app.use("/auth/google/callback", rateLimit("google", 30, 15 * 60_000));
  app.use("/auth/discord/callback", rateLimit("discord", 30, 15 * 60_000));

  app.post("/api/v1/nodes/link", async (c) => {
    const body = (await c.req.json().catch(() => null)) as LinkRequest | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const r = linkNode(db, body);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ nodeId: r.nodeId, userId: r.userId, displayName: r.displayName, email: r.email });
  });

  const signed = new Hono<{ Variables: { node: import("./nodes").NodeRow; body: string } }>();
  signed.use("*", signedByNode(db));
  signed.post("/nodes/heartbeat", (c) => {
    const hb = parseJson<HeartbeatRequest>(c);
    if (!hb) return c.json({ error: "bad json" }, 400);
    recordHeartbeat(db, c.get("node"), hb);
    const settings = getSettings(db);
    // The login node learns it is one here, and starts taking sign-in codes.
    return c.json({ ok: true, serverTime: Date.now(), minNodeVersion: settings.minNodeVersion, loginNode: settings.loginNodeId === c.get("node").id });
  });
  signed.post("/nodes/unlink", (c) => {
    unlinkNode(db, c.get("node").id);
    return c.json({ ok: true });
  });
  signed.post("/telemetry/bans", (c) => {
    const body = parseJson<{ reports?: unknown }>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    return c.json({ ok: true, accepted: acceptReports(db, c.get("node").id, body.reports) });
  });
  // Offers and rendezvous (docs/hub-protocol.md).
  const idParam = (c: { req: { param(k: "id"): string } }): number | null => {
    const n = Number(c.req.param("id"));
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  signed.get("/offers", (c) => c.json(listOpen(db, c.get("node"))));
  signed.get("/offers/mine", (c) => c.json(listMine(db, c.get("node"))));
  signed.post("/offers", (c) => {
    const body = parseJson<CreateOfferRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = createOffer(db, c.get("node"), body);
    return r.ok ? c.json({ offer: r.offer }) : c.json({ error: r.error }, r.status);
  });
  signed.delete("/offers/:id", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const r = cancelOffer(db, c.get("node"), id);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/offers/:id/renew", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const r = renewOffer(db, c.get("node"), id);
    return r.ok ? c.json({ offer: r.offer }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/offers/:id/accept", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<AcceptOfferRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = acceptOffer(db, c.get("node"), id, body);
    return r.ok ? c.json({ rendezvous: r.rendezvous }) : c.json({ error: r.error }, r.status);
  });
  signed.get("/rendezvous/mine", (c) => c.json({ rendezvous: rendezvousFor(db, c.get("node")) }));
  signed.post("/rendezvous/:id/receipt", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<unknown>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = submitReceipt(db, c.get("node"), id, body);
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/rendezvous/:id/abort", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<{ reason?: unknown }>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = abortRendezvous(db, c.get("node"), id, body.reason);
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  // A player meeting's progress, from its node: what the person waiting on the website sees (docs/hub-protocol.md, "Player meetings").
  signed.post("/rendezvous/:id/progress", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<unknown>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = recordProgress(db, c.get("node"), id, body);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/rendezvous/:id/extend", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<{ reason?: unknown }>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = extendRendezvous(db, c.get("node"), id, body.reason);
    return r.ok ? c.json({ ok: true, deadlineAt: r.deadlineAt }) : c.json({ error: r.error }, r.status);
  });
  // The request queue: what hub users asked this node to do, and what came of it (docs/hub-protocol.md).
  // `?wait=N` holds the reply up to N seconds (at most MAX_REQUEST_WAIT_S) until a request lands, so a node
  // learns of one at once without asking every few seconds.
  signed.get("/guest-requests", async (c) => {
    const node = c.get("node");
    let requests = takePendingRequests(db, node);
    const wait = Math.min(MAX_REQUEST_WAIT_S, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    if (!requests.length && wait > 0) {
      await waitForRequest(node.id, wait * 1000);
      requests = takePendingRequests(db, node);
    }
    return c.json({ requests });
  });
  signed.post("/guest-requests/:id/result", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<unknown>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = submitResult(db, c.get("node"), id, body);
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  // Realm logins (docs/hub-protocol.md, "Realm logins"): the login node takes sign-in codes to its desk and says who whispered them.
  signed.get("/realm-logins/pending", async (c) => {
    const node = c.get("node");
    if (!isLoginNode(db, node.id)) return c.json({ error: "this node is not the hub's login node" }, 403);
    let logins = takePendingLogins(db, node);
    const wait = Math.min(MAX_LOGIN_WAIT_S, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    if (!logins.length && wait > 0) {
      await waitForLogin(node.id, wait * 1000);
      logins = takePendingLogins(db, node);
    }
    return c.json({ logins });
  });
  signed.post("/realm-logins/:id/ready", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const r = markLoginReady(db, c.get("node"), id, parseJson<unknown>(c));
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/realm-logins/:id/verified", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const r = markLoginVerified(db, c.get("node"), id, parseJson<unknown>(c));
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  // Communism (docs/hub-protocol.md): accounts and items each node sets aside, free to take, no caps.
  signed.post("/communism/publish", (c) => {
    const body = parseJson<PublishCommunismRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = publishCommunism(db, c.get("node"), body);
    return r.ok ? c.json({ ok: true, listed: r.listed, accounts: r.accounts, hash: r.hash }) : c.json({ error: r.error }, r.status);
  });
  signed.get("/communism", (c) => {
    const q = c.req.query("seasonal");
    const node = c.get("node");
    return c.json({ items: listCommunism(db, node, q === "1" ? true : q === "0" ? false : undefined), nodes: communismNodes(db), status: communismStatus(db, node) });
  });
  signed.get("/communism/mine", (c) => {
    const node = c.get("node");
    return c.json({ ...listMyCommunism(db, node), status: communismStatus(db, node) });
  });
  signed.post("/communism/withdraw", (c) => {
    const body = parseJson<CommunismWithdrawRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = withdrawCommunism(db, c.get("node"), body);
    return r.ok ? c.json({ rendezvous: r.rendezvous }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/communism/give", (c) => {
    const body = parseJson<CommunismGiveRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = giveCommunism(db, c.get("node"), body);
    // A surplus pass (body.pass) learns which node's communism the hub chose.
    return r.ok ? c.json({ rendezvous: r.rendezvous, ...(body.pass ? { nodeId: r.nodeId } : {}) }) : c.json({ error: r.error }, r.status);
  });
  app.route("/api/v1", signed);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---- website ---------------------------------------------------------------
  const site = new Site(db, google, discord);
  registerStatic(app);
  registerAuth(app, site);
  registerHome(app, site);
  registerMe(app, site);
  registerSettings(app, site);
  registerActivity(app, site);
  registerCommunism(app, site);
  registerAdmin(app, site);
  registerDiscordAuth(app, site);
  registerRealmAuth(app, site);
  registerMeetings(app, site);
  registerOffers(app, site);
  return app;
}
