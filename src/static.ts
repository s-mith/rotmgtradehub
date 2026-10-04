// The few files the website serves besides pages: its stylesheet and script,
// the logo, the item sprite sheet from the node package, and the catalog
// bundle the item picker fetches. No user data passes through here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { NODE_PACKAGE_DIR, catalogBundle, enchantIcon, spriteSheetPath, tooltipBundle } from "./catalog";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function serveFile(file: string, cacheControl: string): Response {
  const ext = path.extname(file);
  const type = TYPES[ext];
  if (!type || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  const body = fs.readFileSync(file);
  return new Response(body, { status: 200, headers: { "content-type": type, "content-length": String(body.length), "cache-control": cacheControl } });
}

const versions = new Map<string, { mtimeMs: number; v: string }>();

/** A short hash of a public file's contents, worked out again whenever the file changes; null when it is missing. */
function versionOf(name: string): string | null {
  const file = path.join(PUBLIC_DIR, name);
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const hit = versions.get(name);
    if (hit?.mtimeMs === mtimeMs) return hit.v;
    const v = createHash("sha256").update(fs.readFileSync(file)).digest("base64url").slice(0, 10);
    versions.set(name, { mtimeMs, v });
    return v;
  } catch {
    return null;
  }
}

/** `/static/<name>?v=<its hash>`: a page asks for exactly the stylesheet and script it was made with, never a stale cached copy. */
export function staticUrl(name: string): string {
  const v = versionOf(name);
  return v ? `/static/${name}?v=${v}` : `/static/${name}`;
}

export function registerStatic(app: Hono): void {
  app.get("/static/:file", (c) => {
    const name = c.req.param("file");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return c.text("not found", 404);
    // Asked for by its current hash (staticUrl), the file can be kept for good: new contents get a new address. Any other way, not for long.
    const current = c.req.query("v") !== undefined && c.req.query("v") === versionOf(name);
    return serveFile(path.join(PUBLIC_DIR, name), current ? "public, max-age=31536000, immutable" : "public, max-age=300");
  });
  app.get("/logo.png", () => serveFile(path.join(PUBLIC_DIR, "logo.png"), "public, max-age=86400"));
  app.get("/favicon.ico", () => serveFile(path.join(PUBLIC_DIR, "logo.png"), "public, max-age=86400"));
  // The sprite sheet's name carries a content hash, so it can be cached for good.
  app.get("/sprites/:file", (c) => {
    const sheet = spriteSheetPath();
    if (!sheet || `/sprites/${c.req.param("file")}` !== sheet.url) return c.text("not found", 404);
    return serveFile(sheet.file, "public, max-age=31536000, immutable");
  });
  // The forge material icons beside communism page's dismantle sliders, from the node package.
  app.get("/forge/:file", (c) => {
    const name = c.req.param("file");
    if (!/^(common|rare|legendary|mythical)\.png$/.test(name)) return c.text("not found", 404);
    return serveFile(path.join(NODE_PACKAGE_DIR, "public", "forge", name), "public, max-age=86400");
  });
  // The enchantment-slot badges in a tile's corner (one enchantment, two), from the node package, as rotmgcommunism draws them.
  app.get("/rarity/:file", (c) => {
    const name = c.req.param("file");
    if (!/^(uncommon|rare)\.png$/.test(name)) return c.text("not found", 404);
    return serveFile(path.join(NODE_PACKAGE_DIR, "public", name), "public, max-age=86400");
  });
  // One enchantment's icon for the hover card; an id's icon never changes.
  app.get("/enchant-icon/:file", (c) => {
    const m = /^(\d{1,6})\.png$/.exec(c.req.param("file"));
    const png = m ? enchantIcon(Number(m[1])) : null;
    if (!png) return c.text("not found", 404);
    return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length), "cache-control": "public, max-age=604800" } });
  });
  app.get("/tooltips.json", (c) => {
    const { etag, body, gzip } = tooltipBundle();
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    const headers = { "content-type": "application/json; charset=utf-8", etag, "cache-control": "public, max-age=3600", vary: "accept-encoding" };
    if (/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) return new Response(new Uint8Array(gzip), { status: 200, headers: { ...headers, "content-encoding": "gzip", "content-length": String(gzip.length) } });
    return new Response(body, { status: 200, headers });
  });
  app.get("/catalog.json", (c) => {
    const { etag, body } = catalogBundle();
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "public, max-age=3600" } });
  });
}
