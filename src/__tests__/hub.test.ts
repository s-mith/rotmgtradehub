import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNodeKeypair, signRequest } from "rotmgtrade/shared/hubWire";
import { openDb, setSettings, type Db } from "../db";
import { createApp } from "../app";
import { register } from "../auth";
import { summarize } from "../telemetry";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db);
  vi.stubEnv("ADMIN_EMAILS", "boss@x.test");
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function linked() {
  register(db, "me@x.test", "correct horse battery", "Me");
  const kp = generateNodeKeypair();
  const r = await json(await post("/api/v1/nodes/link", { email: "me@x.test", password: "correct horse battery", publicKey: kp.publicKeyPem, name: "desk", version: "0.1.0" }));
  expect(r.status).toBe(200);
  const nodeId = r.body.nodeId as string;
  const signed = (path: string, body: unknown) => post(path, body, { ...signRequest(kp.privateKeyPem, nodeId, "POST", path, JSON.stringify(body)) });
  return { kp, nodeId, signed };
}

describe("hub API", () => {
  it("serves the version feed with the operator's settings", async () => {
    setSettings(db, { minNodeVersion: "0.2.0", knownBuilds: ["7.0.0.2.0"], gameVersion: "7.0.0.2.0" });
    const r = await json(await app.request("/api/v1/version"));
    expect(r.body).toMatchObject({ minNodeVersion: "0.2.0", build: { gameVersion: "7.0.0.2.0", knownBuilds: ["7.0.0.2.0"] } });
  });

  it("links with the password, then only a correctly signed node may heartbeat, report, or unlink", async () => {
    const { nodeId, signed, kp } = await linked();
    expect((await json(await post("/api/v1/nodes/link", { email: "me@x.test", password: "nope", publicKey: kp.publicKeyPem, name: "x", version: "0" }))).status).toBe(401);
    const hb = await json(await signed("/api/v1/nodes/heartbeat", { version: "0.1.1", build: "7.0.0.2.0", bots: [{ ign: "BotA", seasonal: true, online: true }, { ign: "bad name!", seasonal: false, online: false }] }));
    expect(hb.body).toMatchObject({ ok: true, minNodeVersion: "0.1.0" });
    const row = db.prepare("SELECT version, build, last_seen_at FROM nodes WHERE id = ?").get(nodeId) as { version: string; build: string; last_seen_at: number };
    expect(row).toMatchObject({ version: "0.1.1", build: "7.0.0.2.0" });
    expect(db.prepare("SELECT ign, online FROM node_bots WHERE node_id = ?").all(nodeId)).toEqual([{ ign: "BotA", online: 1 }]);
    // Unsigned, wrong node, and a signature over a different body are all refused.
    expect((await json(await post("/api/v1/nodes/heartbeat", { version: "0" }))).status).toBe(401);
    const other = generateNodeKeypair();
    const forged = signRequest(other.privateKeyPem, nodeId, "POST", "/api/v1/nodes/heartbeat", "{}");
    expect((await json(await post("/api/v1/nodes/heartbeat", {}, { ...forged }))).status).toBe(401);
    const good = signRequest(kp.privateKeyPem, nodeId, "POST", "/api/v1/nodes/heartbeat", JSON.stringify({ version: "1" }));
    expect((await json(await post("/api/v1/nodes/heartbeat", { version: "2" }, { ...good }))).status).toBe(401);
    // Telemetry lands once per (node, account, time) and is summarised.
    const reports = [
      { account: "abcdefghijklmnopqrstuvwxyz012345", suspendedAt: Date.now() - 1000, lastSeenAt: null, lastLane: "owner-trade", heldItems: 3, seasonal: true, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
      { account: "abcdefghijklmnopqrstuvwxyz012345", suspendedAt: Date.now() - 1000, lastSeenAt: null, lastLane: "owner-trade", heldItems: 3, seasonal: true, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
      { account: "short", suspendedAt: Date.now(), lastLane: "idle", heldItems: 0, seasonal: null, nodeVersion: "0.1.1", build: "7.0.0.2.0" },
    ];
    expect((await json(await signed("/api/v1/telemetry/bans", { reports }))).body).toEqual({ ok: true, accepted: 1 });
    expect(summarize(db)).toMatchObject({ total: 1, last24h: 1, nodesReporting: 1, byLane: [{ lane: "owner-trade", n: 1 }] });
    expect((await json(await signed("/api/v1/nodes/unlink", {}))).body).toEqual({ ok: true });
    expect((await json(await signed("/api/v1/nodes/heartbeat", { version: "0" }))).status).toBe(401);
  });

  it("caps nodes per account at five", async () => {
    register(db, "me@x.test", "correct horse battery", "Me");
    for (let i = 0; i < 6; i++) {
      const r = await post("/api/v1/nodes/link", { email: "me@x.test", password: "correct horse battery", publicKey: generateNodeKeypair().publicKeyPem, name: `n${i}`, version: "0.1.0" });
      expect(r.status).toBe(i < 5 ? 200 : 409);
    }
  });
});

describe("hub website", () => {
  it("registers, logs in with a cookie, lists nodes, and gates admin", async () => {
    const form = (path: string, fields: Record<string, string>, cookie?: string) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    const reg = await form("/register", { name: "Boss", email: "boss@x.test", password: "correct horse battery" });
    expect(reg.status).toBe(302);
    expect(reg.headers.get("location")).toBe("/me");
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const me = await app.request("/me", { headers: { cookie } });
    expect(await me.text()).toContain("No node linked yet");
    const bad = await form("/register", { name: "Bo", email: "boss@x.test", password: "correct horse battery" });
    expect(bad.headers.get("location")).toContain("already");
    const admin = await app.request("/admin", { headers: { cookie } });
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain("Version feed");
    const other = await form("/register", { name: "Pleb", email: "pleb@x.test", password: "correct horse battery" });
    expect((await app.request("/admin", { headers: { cookie: other.headers.get("set-cookie")!.split(";")[0] } })).status).toBe(403);
    expect((await app.request("/me")).status).toBe(302);
  });
});

describe("rate limits", () => {
  it("stops a password-guessing burst on link and login", async () => {
    register(db, "me@x.test", "correct horse battery", "Me");
    const kp = generateNodeKeypair();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post("/api/v1/nodes/link", { email: "me@x.test", password: "wrong", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "x-forwarded-for": "9.9.9.9" })).status;
    expect(last).toBe(429);
    // Another address is unaffected.
    expect((await post("/api/v1/nodes/link", { email: "me@x.test", password: "wrong", publicKey: kp.publicKeyPem, name: "x", version: "0" }, { "x-forwarded-for": "8.8.8.8" })).status).toBe(401);
  });
});
