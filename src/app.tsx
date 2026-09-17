// The hub: API for nodes (docs/hub-protocol.md in the node repo) and a small
// website for people. No bots, no items, no game credentials anywhere here.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AcceptOfferRequest, CreateGrantRequest, CreateOfferRequest, HeartbeatRequest, LinkRequest, PublishVaultsRequest, UpdateGrantRequest, VersionInfo, WantLineWire } from "rotmgtrade/shared/hubWire";
import { authenticate, createSession, deleteSession, isAdmin, register, userFromSession, type User } from "./auth";
import { getSettings, setSettings, type Db } from "./db";
import { linkNode, nodesOf, parseJson, recordHeartbeat, signedByNode, unlinkNode } from "./nodes";
import { abortRendezvous, acceptOffer, cancelOffer, createOffer, listMine, listOpen, operatorView, rendezvousFor, submitReceipt, unfreezeNode } from "./offers";
import { createGrant, createGuestRequest, deleteGrant, guestVaultOf, guestVaultsFor, listGrants, publishVaults, recentRequestsFor, submitResult, takePendingRequests, updateGrant, type GuestRequestInput } from "./grants";
import { nodeById } from "./nodes";
import { acceptReports, summarize } from "./telemetry";
import { Layout, Home, Me, Admin, Vaults, Vault } from "./pages";
import { rateLimit } from "./ratelimit";

const COOKIE = "hub_session";

/** The website's want box: one line per want, `itemId qty [minEnch] [exactEnch]`. Anything odd is left for createGuestRequest to refuse. */
export function parseWantText(text: string): WantLineWire[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [itemId, qty, min, exact] = line.split(/\s+/);
    const num = (s: string | undefined): number | null => (s === undefined ? null : /^\d+$/.test(s) ? Number(s) : NaN);
    return { itemId, qty: num(qty) ?? 1, slotsMin: num(min) ?? 0, slotsExact: num(exact), enchants: [] };
  });
}

export function createApp(db: Db): Hono {
  const app = new Hono();

  // ---- API for nodes -------------------------------------------------------
  app.get("/api/v1/version", (c) => {
    const s = getSettings(db);
    const v: VersionInfo = { minNodeVersion: s.minNodeVersion, latestNodeVersion: s.latestNodeVersion, downloadUrl: s.downloadUrl, build: { gameVersion: s.gameVersion, knownBuilds: s.knownBuilds, updatedAt: s.buildUpdatedAt } };
    return c.json(v, 200, { "cache-control": "public, max-age=60" });
  });

  // Password-bearing routes: a handful of tries per IP, then wait.
  app.use("/api/v1/nodes/link", rateLimit("link", 10, 15 * 60_000));
  app.use("/login", rateLimit("login", 10, 15 * 60_000));
  app.use("/register", rateLimit("register", 5, 60 * 60_000));

  app.post("/api/v1/nodes/link", async (c) => {
    const body = (await c.req.json().catch(() => null)) as LinkRequest | null;
    if (!body || typeof body !== "object") return c.json({ error: "bad json" }, 400);
    const r = linkNode(db, body);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ nodeId: r.nodeId, userId: r.userId, displayName: r.displayName });
  });

  const signed = new Hono<{ Variables: { node: import("./nodes").NodeRow; body: string } }>();
  signed.use("*", signedByNode(db));
  signed.post("/nodes/heartbeat", (c) => {
    const hb = parseJson<HeartbeatRequest>(c);
    if (!hb) return c.json({ error: "bad json" }, 400);
    recordHeartbeat(db, c.get("node"), hb);
    return c.json({ ok: true, serverTime: Date.now(), minNodeVersion: getSettings(db).minNodeVersion });
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
  // Phase 3: the offer board and rendezvous (docs/hub-protocol.md).
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
  // Phase 4b: grants, published guest vaults, and the guest request queue (docs/hub-protocol.md).
  signed.get("/grants", (c) => c.json({ grants: listGrants(db, c.get("node")) }));
  signed.post("/grants", (c) => {
    const body = parseJson<CreateGrantRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = createGrant(db, c.get("node"), body);
    return r.ok ? c.json({ grant: r.grant }) : c.json({ error: r.error }, r.status);
  });
  signed.put("/grants/:id", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<UpdateGrantRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = updateGrant(db, c.get("node"), id, body);
    return r.ok ? c.json({ grant: r.grant }) : c.json({ error: r.error }, r.status);
  });
  signed.delete("/grants/:id", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const r = deleteGrant(db, c.get("node"), id);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
  signed.post("/vaults/publish", (c) => {
    const body = parseJson<PublishVaultsRequest>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = publishVaults(db, c.get("node"), body);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
  signed.get("/guest-requests", (c) => c.json({ requests: takePendingRequests(db, c.get("node")) }));
  signed.post("/guest-requests/:id/result", (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ error: "bad id" }, 400);
    const body = parseJson<unknown>(c);
    if (!body) return c.json({ error: "bad json" }, 400);
    const r = submitResult(db, c.get("node"), id, body);
    return r.ok ? c.json({ ok: true, state: r.state }) : c.json({ error: r.error }, r.status);
  });
  app.route("/api/v1", signed);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---- website ---------------------------------------------------------------
  const me = (c: { req: { raw: Request } }): User | null => userFromSession(db, getCookie(c as never, COOKIE));

  app.get("/", (c) => {
    const user = me(c);
    if (user) return c.redirect("/me");
    return c.html(<Layout title="rotmgtradehub"><Home error={c.req.query("error")} /></Layout>);
  });
  app.post("/register", async (c) => {
    const f = await c.req.parseBody();
    const r = register(db, String(f.email ?? ""), String(f.password ?? ""), String(f.name ?? ""));
    if (!r.ok) return c.redirect(`/?error=${encodeURIComponent(r.error)}`);
    setCookie(c, COOKIE, createSession(db, r.user.id), { httpOnly: true, sameSite: "Lax", path: "/", secure: c.req.url.startsWith("https") });
    return c.redirect("/me");
  });
  app.post("/login", async (c) => {
    const f = await c.req.parseBody();
    const user = authenticate(db, String(f.email ?? ""), String(f.password ?? ""));
    if (!user) return c.redirect(`/?error=${encodeURIComponent("wrong email or password")}`);
    setCookie(c, COOKIE, createSession(db, user.id), { httpOnly: true, sameSite: "Lax", path: "/", secure: c.req.url.startsWith("https") });
    return c.redirect("/me");
  });
  app.post("/logout", (c) => {
    deleteSession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/");
  });
  app.get("/me", (c) => {
    const user = me(c);
    if (!user) return c.redirect("/");
    return c.html(<Layout title="my nodes"><Me user={user} nodes={nodesOf(db, user.id)} admin={isAdmin(user)} /></Layout>);
  });
  app.post("/me/nodes/:id/unlink", (c) => {
    const user = me(c);
    if (!user) return c.redirect("/");
    unlinkNode(db, c.req.param("id"), user.id);
    return c.redirect("/me");
  });
  // Phase 4b: a guest's vaults on other people's nodes.
  app.get("/vaults", (c) => {
    const user = me(c);
    if (!user) return c.redirect("/");
    return c.html(<Layout title="my vaults"><Vaults user={user} vaults={guestVaultsFor(db, user.id)} /></Layout>);
  });
  app.get("/vaults/:nodeId", (c) => {
    const user = me(c);
    if (!user) return c.redirect("/");
    const nodeId = c.req.param("nodeId");
    const vault = guestVaultOf(db, user.id, nodeId);
    if (!vault) return c.text("no vault there", 404);
    const node = nodeById(db, nodeId);
    const board = node ? listOpen(db, node).offers : [];
    return c.html(
      <Layout title={`vault at ${vault.nodeName}`}>
        <Vault user={user} vault={vault} requests={recentRequestsFor(db, user.id, nodeId)} board={board} error={c.req.query("error")} queued={c.req.query("queued")} />
      </Layout>,
    );
  });
  app.post("/vaults/:nodeId/requests", async (c) => {
    const user = me(c);
    if (!user) return c.redirect("/");
    const nodeId = c.req.param("nodeId");
    const f = await c.req.parseBody({ all: true });
    const one = (k: string): string => {
      const v = f[k];
      return typeof v === "string" ? v.trim() : Array.isArray(v) && typeof v[v.length - 1] === "string" ? String(v[v.length - 1]).trim() : "";
    };
    const many = (k: string): string[] => {
      const v = f[k];
      return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
    };
    const kind = one("kind");
    const input: GuestRequestInput = { kind };
    if (kind === "deposit" || kind === "withdraw" || kind === "offer-create") {
      input.seasonal = one("seasonal") === "1";
      input.server = one("server");
    }
    if (kind === "deposit") input.count = Number(one("count"));
    if (kind === "withdraw" || kind === "offer-create") input.refs = many("refs");
    if (kind === "offer-create") input.want = parseWantText(one("want"));
    if (kind === "offer-accept" || kind === "offer-cancel") input.offerId = Number(one("offerId"));
    const r = createGuestRequest(db, user, nodeId, input);
    if (!r.ok) return c.redirect(`/vaults/${encodeURIComponent(nodeId)}?error=${encodeURIComponent(r.error)}`);
    return c.redirect(`/vaults/${encodeURIComponent(nodeId)}?queued=${r.request.id}`);
  });
  app.get("/admin", (c) => {
    const user = me(c);
    if (!isAdmin(user)) return c.text("not for you", 403);
    return c.html(<Layout title="admin"><Admin settings={getSettings(db)} bans={summarize(db)} nodes={(db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n} board={operatorView(db)} /></Layout>);
  });
  app.post("/admin/nodes/:id/unfreeze", (c) => {
    const user = me(c);
    if (!isAdmin(user)) return c.text("not for you", 403);
    unfreezeNode(db, c.req.param("id"));
    return c.redirect("/admin");
  });
  app.post("/admin/settings", async (c) => {
    const user = me(c);
    if (!isAdmin(user)) return c.text("not for you", 403);
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
  return app;
}
