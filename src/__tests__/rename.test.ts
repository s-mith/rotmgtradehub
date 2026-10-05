import { beforeEach, describe, expect, it } from "vitest";
import { generateNodeKeypair } from "rotmgtradenode/shared/hubWire";
import { openDb, type Db } from "../db";
import { createApp } from "../app";
import { nodeById } from "../nodes";
import { linkCodeFor, person } from "./people";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null, discord: null });
});

/** A node linked to the account with this email, named `name`: its id. */
async function linkedNode(email: string, name: string): Promise<string> {
  const kp = generateNodeKeypair();
  const res = await app.request("/api/v1/nodes/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: linkCodeFor(db, email), publicKey: kp.publicKeyPem, name, version: "0.1.0" }) });
  return ((await res.json()) as { nodeId: string }).nodeId;
}
const rename = (nodeId: string, name: string, cookie: string) =>
  app.request(`/me/nodes/${nodeId}/rename`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ name }).toString(), redirect: "manual" });
/** The page a form lands on. */
const landed = async (res: Response, cookie: string) => (await app.request(res.headers.get("location")!, { headers: { cookie } })).text();

describe("renaming a node", () => {
  it("lets the owner rename it from my nodes, and says so", async () => {
    const me = person(db, "owner@x.test");
    const id = await linkedNode("owner@x.test", "my node");
    expect(await (await app.request("/me", { headers: { cookie: me.cookie } })).text()).toContain(`action="/me/nodes/${id}/rename"`);
    const res = await rename(id, "  Basement   PC ", me.cookie);
    expect(res.status).toBe(302);
    expect(nodeById(db, id)!.name).toBe("Basement PC");
    const page = await landed(res, me.cookie);
    expect(page).toContain("Renamed the node to Basement PC.");
    expect(page).toContain("<b>Basement PC</b>");
  });

  it("refuses an empty name or one over 40 characters, and keeps the old one", async () => {
    const me = person(db, "owner@x.test");
    const id = await linkedNode("owner@x.test", "my node");
    expect(await landed(await rename(id, "   ", me.cookie), me.cookie)).toContain("1-40 characters");
    await rename(id, "x".repeat(41), me.cookie);
    expect(nodeById(db, id)!.name).toBe("my node");
    await rename(id, "x".repeat(40), me.cookie);
    expect(nodeById(db, id)!.name).toBe("x".repeat(40));
  });

  it("does not let anyone rename someone else's node", async () => {
    const id = await linkedNode("owner@x.test", "my node");
    const other = person(db, "other@x.test");
    expect(await landed(await rename(id, "mine now", other.cookie), other.cookie)).toContain("not one of yours");
    expect(nodeById(db, id)!.name).toBe("my node");
    // Signed out, the form only sends you to the front page.
    expect((await app.request(`/me/nodes/${id}/rename`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=x", redirect: "manual" })).headers.get("location")).toBe("/");
    expect(nodeById(db, id)!.name).toBe("my node");
  });
});
