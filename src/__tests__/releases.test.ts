import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, openDb, setSettings, storedSettings, type Db } from "../db";
import { createApp } from "../app";
import { checkRelease, looksLinux, parseRelease } from "../releases";
import { resetRateLimits } from "../ratelimit";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  resetRateLimits();
  db = openDb(":memory:");
  app = createApp(db, { google: null, discord: null });
});
afterEach(() => vi.unstubAllEnvs());

const BASE = "https://github.com/s-mith/rotmgtradenode/releases";
/** A GitHub "latest release" reply as the release workflow publishes it. */
const ghRelease = (over: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  html_url: `${BASE}/tag/v0.2.0`,
  published_at: "2026-10-05T12:00:00Z",
  draft: false,
  prerelease: false,
  assets: [
    { name: "rotmgtradenode-Setup-0.2.0.exe.blockmap", browser_download_url: `${BASE}/download/v0.2.0/rotmgtradenode-Setup-0.2.0.exe.blockmap` },
    { name: "rotmgtradenode-Setup-0.2.0.exe", browser_download_url: `${BASE}/download/v0.2.0/rotmgtradenode-Setup-0.2.0.exe` },
    { name: "latest.yml", browser_download_url: `${BASE}/download/v0.2.0/latest.yml` },
    { name: "rotmgtradenode-0.2.0-linux-x86_64.AppImage", browser_download_url: `${BASE}/download/v0.2.0/rotmgtradenode-0.2.0-linux-x86_64.AppImage` },
  ],
  ...over,
});
/** A fetch that answers once with `status` and `body`, keeping the request it saw. */
function answer(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, seen };
}
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const download = (path: string, ua = WINDOWS_UA) => app.request(path, { headers: { "user-agent": ua }, redirect: "manual" });

describe("reading a release", () => {
  it("takes the version from the tag, and the installer and AppImage from the assets", () => {
    expect(parseRelease(ghRelease())).toEqual({
      version: "0.2.0",
      page: `${BASE}/tag/v0.2.0`,
      windows: `${BASE}/download/v0.2.0/rotmgtradenode-Setup-0.2.0.exe`,
      linux: `${BASE}/download/v0.2.0/rotmgtradenode-0.2.0-linux-x86_64.AppImage`,
      publishedAt: Date.parse("2026-10-05T12:00:00Z"),
    });
  });
  it("hands out no draft, prerelease, odd tag or link off GitHub", () => {
    expect(parseRelease(ghRelease({ draft: true }))).toBeNull();
    expect(parseRelease(ghRelease({ prerelease: true }))).toBeNull();
    expect(parseRelease(ghRelease({ tag_name: "nightly" }))).toBeNull();
    expect(parseRelease(ghRelease({ html_url: "https://evil.test/x" }))).toBeNull();
    expect(parseRelease(ghRelease({ assets: [{ name: "x.exe", browser_download_url: "https://evil.test/x.exe" }] }))!.windows).toBeNull();
  });
  it("tells Linux browsers from Android and ChromeOS", () => {
    expect(looksLinux(LINUX_UA)).toBe(true);
    expect(looksLinux(WINDOWS_UA)).toBe(false);
    expect(looksLinux("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(false);
    expect(looksLinux("Mozilla/5.0 (X11; CrOS x86_64 16000.0.0)")).toBe(false);
  });
});

describe("checking GitHub", () => {
  it("stores the latest release, which then is the latest version and the download", async () => {
    const gh = answer(200, ghRelease(), { etag: '"abc"' });
    expect(await checkRelease(db, "s-mith/rotmgtradenode", gh.fn, 1_000)).toBe("");
    expect(gh.seen[0].url).toBe("https://api.github.com/repos/s-mith/rotmgtradenode/releases/latest");
    expect(storedSettings(db).nodeRelease!.version).toBe("0.2.0");
    expect(storedSettings(db).releaseCheckedAt).toBe(1_000);
    // What the site and the nodes go by; the admin page keeps the stored values.
    expect(getSettings(db).latestNodeVersion).toBe("0.2.0");
    expect(getSettings(db).downloadUrl).toBe("/download");
    expect(storedSettings(db).latestNodeVersion).toBe("0.1.0");
    // The next check asks with GitHub's tag, and "not modified" keeps the release.
    const again = answer(304);
    await checkRelease(db, "s-mith/rotmgtradenode", again.fn, 2_000);
    expect(again.seen[0].headers["if-none-match"]).toBe('"abc"');
    expect(storedSettings(db).nodeRelease!.version).toBe("0.2.0");
  });
  it("forgets the release when GitHub has none to show, and keeps it through an outage", async () => {
    await checkRelease(db, "s-mith/rotmgtradenode", answer(200, ghRelease()).fn);
    expect(await checkRelease(db, "s-mith/rotmgtradenode", answer(503).fn)).toBe("GitHub answered 503");
    expect(storedSettings(db).nodeRelease).not.toBeNull();
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkRelease(db, "s-mith/rotmgtradenode", down)).toContain("could not reach GitHub");
    expect(storedSettings(db).nodeRelease).not.toBeNull();
    expect(await checkRelease(db, "s-mith/rotmgtradenode", answer(404, { message: "Not Found" }).fn)).toContain("no published release");
    expect(storedSettings(db).nodeRelease).toBeNull();
    expect(getSettings(db).downloadUrl).toBe("");
  });
});

describe("/download", () => {
  it("sends Windows to the installer and Linux to the AppImage, or the one asked for", async () => {
    setSettings(db, { nodeRelease: parseRelease(ghRelease()) });
    expect((await download("/download")).headers.get("location")).toMatch(/Setup-0\.2\.0\.exe$/);
    expect((await download("/download", LINUX_UA)).headers.get("location")).toMatch(/\.AppImage$/);
    expect((await download("/download/linux")).headers.get("location")).toMatch(/\.AppImage$/);
    expect((await download("/download/windows", LINUX_UA)).headers.get("location")).toMatch(/\.exe$/);
    expect((await download("/download/mac")).status).toBe(404);
    expect((await download("/download")).headers.get("cache-control")).toBe("no-store");
  });
  it("falls back to the release page, then to the stored download URL, then says there is none", async () => {
    setSettings(db, { nodeRelease: parseRelease(ghRelease({ assets: [] })) });
    expect((await download("/download")).headers.get("location")).toBe(`${BASE}/tag/v0.2.0`);
    setSettings(db, { nodeRelease: null, downloadUrl: "https://example.test/node.exe" });
    expect((await download("/download")).headers.get("location")).toBe("https://example.test/node.exe");
    expect(getSettings(db).downloadUrl).toBe("/download");
    setSettings(db, { downloadUrl: "" });
    const none = await download("/download");
    expect(none.headers.get("location")).toMatch(/^\/\?error=/);
    expect(getSettings(db).downloadUrl).toBe("");
  });
  it("shows on the front page as coming soon until there is something to download", async () => {
    const page = await (await app.request("/")).text();
    expect(page).toContain("Download — coming soon");
    expect(page).not.toContain('href="/download"');
  });
  it("is what the front page links to, and what the version feed gives nodes, whole", async () => {
    vi.stubEnv("BASE_URL", "https://rotmg.trade");
    setSettings(db, { nodeRelease: parseRelease(ghRelease()) });
    expect(await (await app.request("/")).text()).toContain('href="/download"');
    const feed = (await (await app.request("/api/v1/version")).json()) as { latestNodeVersion: string; downloadUrl: string };
    expect(feed).toMatchObject({ latestNodeVersion: "0.2.0", downloadUrl: "https://rotmg.trade/download" });
  });
});
