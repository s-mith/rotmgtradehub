import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { createApp } from "../app";

const app = createApp(openDb(":memory:"), { google: null, discord: null });

describe("the privacy page", () => {
  it("says what the hub keeps, and every page links to it", async () => {
    const res = await app.request("/privacy");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Privacy</h1>");
    expect(page).toContain("Your email is never shown to anyone.");
    expect(page).toContain("https://discord.gg/xJ7TyTUSb3");
    expect(await (await app.request("/")).text()).toContain('href="/privacy"');
  });
});
