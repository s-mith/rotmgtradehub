// The newest node release, read from GitHub (NODE_RELEASES_REPO, default
// s-mith/rotmgtradenode; empty turns it off). Once one is found it is the
// hub's latest node version, and /download hands out its installer, so
// publishing a release on GitHub is the only step. Checked at start and every
// RELEASE_CHECK_MINUTES (10); GitHub allows 60 checks an hour without a token,
// and one it answers "not modified" does not count. Drafts and prereleases
// are never the latest release. Until one is found (the repository is private,
// or nothing is published yet), the admin page's own latest version and
// download URL stand.
import type { Hono } from "hono";
import { setSettings, storedSettings, type Db, type NodeRelease } from "./db";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

export function releasesRepo(): string {
  const repo = (process.env.NODE_RELEASES_REPO ?? "s-mith/rotmgtradenode").trim();
  return REPO_RE.test(repo) ? repo : "";
}

/** The release in a GitHub "latest release" reply; null when it is not one the hub can hand out. */
export function parseRelease(json: unknown): NodeRelease | null {
  if (!json || typeof json !== "object") return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === "string" ? TAG_RE.exec(r.tag_name) : null;
  if (!tag || typeof r.html_url !== "string" || !r.html_url.startsWith("https://github.com/")) return null;
  const assets = (Array.isArray(r.assets) ? r.assets : []).filter(
    (a): a is { name: string; browser_download_url: string } => !!a && typeof a.name === "string" && typeof a.browser_download_url === "string" && a.browser_download_url.startsWith("https://github.com/"),
  );
  // The installer, not its .exe.blockmap; the AppImage, not latest-linux.yml.
  const pick = (re: RegExp) => assets.find((a) => re.test(a.name))?.browser_download_url ?? null;
  return { version: tag[1], page: r.html_url, windows: pick(/\.exe$/i), linux: pick(/\.AppImage$/i), publishedAt: Date.parse(String(r.published_at)) || 0 };
}

/** GitHub's tag for the last answer, so an unchanged release costs a 304. */
let etag: { repo: string; value: string } | null = null;

/** Ask GitHub once and store what it says; returns the note the admin page shows. */
export async function checkRelease(db: Db, repo = releasesRepo(), fetchFn: typeof fetch = fetch, now = Date.now()): Promise<string> {
  if (!repo) return note(db, now, "off: NODE_RELEASES_REPO is empty");
  let res: Response;
  try {
    res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "rotmgtradehub", ...(etag?.repo === repo ? { "if-none-match": etag.value } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Unreachable: the release found before still stands.
    return note(db, now, `could not reach GitHub (${(e as Error).message})`);
  }
  if (res.status === 304) return note(db, now, "");
  if (res.status === 404) {
    // Nothing published, or the repository is private: no link to a file nobody can download.
    etag = null;
    setSettings(db, { nodeRelease: null });
    return note(db, now, `no published release in ${repo} (or the repository is private)`);
  }
  if (!res.ok) return note(db, now, `GitHub answered ${res.status}`);
  const release = parseRelease(await res.json().catch(() => null));
  const tag = res.headers.get("etag");
  etag = tag ? { repo, value: tag } : null;
  setSettings(db, { nodeRelease: release });
  return note(db, now, release ? "" : "the latest release has no version tag like v1.2.3");
}

function note(db: Db, now: number, text: string): string {
  setSettings(db, { releaseCheckedAt: now, releaseNote: text });
  return text;
}

/** Start the checks; returns the function that stops them. */
export function startReleaseChecks(db: Db, everyMinutes = Number(process.env.RELEASE_CHECK_MINUTES ?? 10)): () => void {
  if (!releasesRepo() || !(everyMinutes > 0)) return () => {};
  let last = "";
  const run = () =>
    checkRelease(db)
      .then((text) => {
        if (text && text !== last) console.log(`[hub] node release: ${text}`);
        last = text;
      })
      .catch((e) => console.error(`[hub] node release check failed: ${(e as Error).message}`));
  void run();
  const timer = setInterval(run, everyMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Where /download sends someone: the installer for their system, else the release's page, else the stored download URL. */
export function downloadTarget(db: Db, os: "windows" | "linux"): string | null {
  const s = storedSettings(db);
  const r = s.nodeRelease;
  if (r) return (os === "linux" ? r.linux : r.windows) ?? r.page;
  return s.downloadUrl || null;
}

/** A browser on Linux, where the AppImage runs (not Android or ChromeOS). */
export function looksLinux(userAgent: string | undefined): boolean {
  return !!userAgent && /Linux/.test(userAgent) && !/Android|CrOS/.test(userAgent);
}

/**
 * /download: the one link to share. It always reaches the newest installer,
 * Windows unless the browser is on Linux; /download/windows and
 * /download/linux pick one.
 */
export function registerDownload(app: Hono, db: Db): void {
  app.get("/download/:os?", (c) => {
    const asked = c.req.param("os");
    if (asked !== undefined && asked !== "windows" && asked !== "linux") return c.notFound();
    const os = asked ?? (looksLinux(c.req.header("user-agent")) ? "linux" : "windows");
    const to = downloadTarget(db, os);
    c.header("cache-control", "no-store");
    if (!to) return c.redirect(`/?error=${encodeURIComponent("There is no download yet: the first release is not out.")}`);
    return c.redirect(to);
  });
}
