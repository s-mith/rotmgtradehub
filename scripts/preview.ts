// A throwaway hub on port 4001 with a temp database full of made-up data, so
// the website can be looked at in a browser without touching the real hub.
// Run:  npm run preview   (then open http://127.0.0.1:4001/preview/as/boss@x.test)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { generateNodeKeypair } from "rotmgtradenode/shared/hubWire";
import { createApp } from "../src/app";
import { createLinkCode, createSession, createUser, setIgn } from "../src/auth";
import { openDb, setSettings } from "../src/db";
import { linkNode, recordHeartbeat, nodeById } from "../src/nodes";
import { createOffer, acceptOffer, submitReceipt } from "../src/offers";
import { setWatch } from "../src/watch";
import { createGuestRequest, submitResult } from "../src/requests";
import { giveCommunism, publishCommunism, withdrawCommunism } from "../src/communism";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-preview-"));
const db = openDb(path.join(dir, "hub.db"));
process.env.ADMIN_EMAILS = "boss@x.test";
const boss = { user: createUser(db, "boss@x.test", "Boss") };
const alice = { user: createUser(db, "alice@x.test", "Alice") };
const bob = { user: createUser(db, "bob@x.test", "Bob") };
const byEmail = (email: string) => (db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number }).id;
setSettings(db, { minNodeVersion: "0.1.0", latestNodeVersion: "0.2.0", downloadUrl: "https://example.test/rotmgtradenode-0.2.0-win-x64.exe", gameVersion: "7.0.0.2.0", knownBuilds: ["7.0.0.2.0"], buildUpdatedAt: Date.now() });

function link(email: string, name: string, version = "0.1.0") {
  const kp = generateNodeKeypair();
  const r = linkNode(db, { code: createLinkCode(db, byEmail(email)).code, publicKey: kp.publicKeyPem, name, version });
  if (!r.ok) throw new Error(r.error);
  return nodeById(db, r.nodeId)!;
}
const bossNode = link("boss@x.test", "desk", "0.2.0");
const aliceNode = link("alice@x.test", "laptop", "0.1.0");
const bobNode = link("bob@x.test", "bob-desk", "0.1.0");
recordHeartbeat(db, bossNode, { version: "0.2.0", build: "7.0.0.2.0", bots: [{ ign: "Furrygay", seasonal: false, online: true }, { ign: "Puppygrrrl", seasonal: true, online: false }], status: { gate: { held: false, reason: null, known: true }, proxies: 2, accounts: 5, suspended: 3, deskServer: "USSouth3" } });
recordHeartbeat(db, aliceNode, { version: "0.1.0", build: "7.0.0.3.0", bots: [{ ign: "AliceBot", seasonal: false, online: true }], status: { gate: { held: true, reason: "build 7.0.0.3.0 not yet confirmed", known: false }, proxies: 0, accounts: 1, suspended: 0, deskServer: "USWest4" } });
recordHeartbeat(db, bobNode, { version: "0.1.0", build: "7.0.0.2.0", bots: [{ ign: "BobBot", seasonal: false, online: true }] }, Date.now() - 10 * 60_000);

const item = (ref: string, itemId: string, enchants: number[] | null = null) => ({ ref, itemId, enchants, count: enchants?.length ?? 0 });
// Seeded nodes have a few swaps behind them, so the offer limits allow more than one open offer each.
db.prepare("UPDATE nodes SET completed_swaps = 6").run();
const o1 = createOffer(db, aliceNode, { botIgn: "AliceBot", seasonal: false, server: "USWest4", give: [item("a1", "dbow", [283, 263]), item("a2", "patk"), item("a3", "patk")], want: [{ itemId: "rod", qty: 1, slotsMin: 2, slotsExact: null, enchants: [] }] });
const o2 = createOffer(db, bossNode, { botIgn: "Furrygay", seasonal: false, server: "USSouth3", give: [item("b1", "ubatk"), item("b2", "cgc", [107])], want: [{ itemId: "gplife", qty: 3, slotsMin: 0, slotsExact: null, enchants: [] }, { itemId: "sep", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }] });
const o3 = createOffer(db, bobNode, { botIgn: "BobBot", seasonal: false, server: "USEast", give: [item("c1", "plife"), item("c2", "plife")], want: [{ itemId: "pmana", qty: 2, slotsMin: 0, slotsExact: null, enchants: [] }] });
for (const o of [o1, o2, o3]) if (!o.ok) throw new Error(`offer: ${o.error}`);
// A swap that finished yesterday, so the history has something to say (first: Bob's node takes one offer at a time).
const past = createOffer(db, aliceNode, { botIgn: "AliceBot", seasonal: false, server: "USWest4", give: [item("h1", "dbow", [283])], want: [{ itemId: "plife", qty: 2, slotsMin: 0, slotsExact: null, enchants: [] }] }, Date.now() - 90_000_000);
if (!past.ok) throw new Error(past.error);
const pastRv = acceptOffer(db, bobNode, past.offer.id, { botIgn: "BobBot", items: [item("h2", "plife"), item("h3", "plife")] }, Date.now() - 89_000_000);
if (!pastRv.ok) throw new Error(pastRv.error);
const rc = (gave: { itemId: string; qty: number }[], got: { itemId: string; qty: number }[], partnerIgn: string) => ({ window: 0, ok: true, gave, gaveRefs: [], got, partnerIgn, at: Date.now() - 88_000_000 });
submitReceipt(db, aliceNode, pastRv.rendezvous.id, rc([{ itemId: "dbow", qty: 1 }], [{ itemId: "plife", qty: 2 }], "BobBot"), Date.now() - 88_000_000);
submitReceipt(db, bobNode, pastRv.rendezvous.id, rc([{ itemId: "plife", qty: 2 }], [{ itemId: "dbow", qty: 1 }], "AliceBot"), Date.now() - 88_000_000);
// Bob accepts Alice's: a meeting under way.
const acc = acceptOffer(db, bobNode, o1.offer.id, { botIgn: "BobBot", items: [item("c9", "rod", [23, 63])] });
if (!acc.ok) throw new Error(acc.error);
// More offers, for the nodes to browse.
for (const [node, ign, give, want] of [
  [bobNode, "BobBot", [item("m1", "gpdef"), item("m2", "gpdef")], [{ itemId: "gplife", qty: 1 }]],
  [aliceNode, "AliceBot", [item("m3", "cgc", [107])], [{ itemId: "pdef", qty: 4 }]],
  [aliceNode, "AliceBot", [item("m4", "regg_feline")], [{ itemId: "pmana", qty: 1 }]],
  // Boss holds one non-seasonal Potion of Life: this one is ready for them, the next is one short.
  [bobNode, "BobBot", [item("m5", "ubdef")], [{ itemId: "plife", qty: 1 }]],
  [aliceNode, "AliceBot", [item("m6", "sos_w", [263])], [{ itemId: "plife", qty: 2 }]],
] as const) {
  const r = createOffer(db, node, { botIgn: ign, seasonal: false, server: "USWest4", give: [...give], want: want.map((w) => ({ ...w, slotsMin: 0, slotsExact: null, enchants: [] })) });
  if (!r.ok) console.log("seed offer skipped:", r.error);
}
setWatch(db, boss.user.id, "dbow", "give", true);

// Communism: each node's accounts set aside for it, and what they hold.
publishCommunism(db, bossNode, { at: Date.now(), accounts: [
  { ign: "Furrygay", seasonal: false, slots: 16, free: 14, online: true },
  { ign: "Puppygrrrl", seasonal: true, slots: 8, free: 7, online: false },
], items: [
  { ref: "k1", itemId: "wcinc", name: "Wine Cellar Incantation", enchants: null, count: 0, seasonal: false, botIgn: "Furrygay" },
  { ref: "k2", itemId: "regg_feline", name: "Rare Feline Egg", enchants: null, count: 0, seasonal: false, botIgn: "Furrygay" },
  { ref: "k3", itemId: "acsl", name: "Acidic Slasher", enchants: [283], count: 1, seasonal: true, botIgn: "Puppygrrrl" },
] });
publishCommunism(db, aliceNode, { at: Date.now(), accounts: [{ ign: "AliceComm", seasonal: false, slots: 8, free: 6, online: true }], items: [
  { ref: "z1", itemId: "gpdef", name: "Greater Potion of Defense", enchants: null, count: 0, seasonal: false, botIgn: "AliceComm" },
  { ref: "z2", itemId: "sos_w", name: "Sword of Splendor", enchants: [263, 283], count: 2, seasonal: false, botIgn: "AliceComm" },
] });
withdrawCommunism(db, bobNode, { nodeId: aliceNode.id, ref: "z1", server: "USWest4", botIgn: "BobBot" });
giveCommunism(db, bobNode, { nodeId: bossNode.id, seasonal: false, items: [item("c3", "gplife")], server: "USSouth3", botIgn: "BobBot" });

// Boss plays as "Bossman" and has asked Alice's communism for things; Alice's node has answered one.
setIgn(db, boss.user.id, "Bossman");
const rq = createGuestRequest(db, boss.user, aliceNode.id, { kind: "deposit", seasonal: false, server: "USEast", count: 3 });
if (rq.ok) submitResult(db, aliceNode, rq.request.id, { ok: true, pending: true, detail: "AliceComm is logging in", botIgn: "AliceComm" });
else console.log("seed request skipped:", rq.error);
createGuestRequest(db, boss.user, aliceNode.id, { kind: "withdraw", server: "USEast", refs: ["z2"] });

const app = createApp(db, { google: null });
// Preview only: sign in as any seeded account without a password prompt.
app.get("/preview/as/:email", (c) => {
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(c.req.param("email")) as { id: number } | undefined;
  if (!u) return c.text("no such seeded user", 404);
  c.header("set-cookie", `hub_session=${createSession(db, u.id)}; Path=/; HttpOnly; SameSite=Lax`);
  return c.redirect("/me");
});
serve({ fetch: app.fetch, port: 4001, hostname: "127.0.0.1" }, () => console.log(`preview hub on http://127.0.0.1:4001  (sign in at /preview/as/boss@x.test, alice@x.test or bob@x.test)  db ${dir}`));
