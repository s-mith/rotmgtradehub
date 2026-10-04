// The public game data the website renders items with: the trade catalog
// (ids, names, categories), enchantment names and what each enchantment
// does, the sprite sheet, and the server list. All of it is shipped by the
// node package; the hub only reads it. Nothing here is an item anyone owns.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { CATALOG, CATEGORIES, ITEM_BY_ID, type CatalogItem } from "rotmgtradenode/catalog";
import { effectLabel, effectsOfEnchant } from "rotmgtradenode/enchant-effects";
import { SERVERS } from "rotmgtradenode/servers";
import atlas from "rotmgtradenode/sprite-atlas";
import itemIndex from "rotmgtradenode/item-index";
import itemTooltips from "rotmgtradenode/item-tooltips";
import enchantMods from "rotmgtradenode/enchant-mods";

export { CATALOG, CATEGORIES, ITEM_BY_ID, SERVERS, effectLabel, effectsOfEnchant };
export type { CatalogItem };

const require = createRequire(import.meta.url);
/** Where the node package lives on disk: the sprite sheet and enchant names are files there, not exports. */
export const NODE_PACKAGE_DIR = path.dirname(require.resolve("rotmgtradenode/package.json"));

// --- names ------------------------------------------------------------------

export function itemName(id: string): string {
  return ITEM_BY_ID.get(id)?.name ?? id;
}

let enchantNames: Map<number, string> | null = null;
let enchantSprites: Map<number, string> | null = null;
function loadEnchantNames(): Map<number, string> {
  if (enchantNames) return enchantNames;
  enchantNames = new Map();
  enchantSprites = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(NODE_PACKAGE_DIR, "realm-enchants.json"), "utf8")) as { realmId: string; name: string; sprite?: string }[];
    for (const e of raw) {
      const id = Number(e.realmId);
      if (!Number.isFinite(id)) continue;
      if (e.name && !enchantNames.has(id)) enchantNames.set(id, e.name);
      if (e.sprite && !enchantSprites.has(id)) enchantSprites.set(id, e.sprite);
    }
  } catch {
    // No names: the website shows ids.
  }
  return enchantNames;
}

/** An enchantment's icon (PNG bytes) from realm-enchants.json, or null when it has none. */
export function enchantIcon(id: number): Buffer | null {
  loadEnchantNames();
  const b64 = enchantSprites?.get(id);
  return b64 ? Buffer.from(b64, "base64") : null;
}

export function enchantName(id: number): string {
  return loadEnchantNames().get(id) ?? `enchant #${id}`;
}

// --- sprites ----------------------------------------------------------------

const ATLAS = atlas as { file: string; tile: number; cols: number; rows: number; count: number; index: Record<string, number> };
const norm = (n: string) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

/** Inline style that paints one catalog item's sprite from the sheet (the same maths as the node's ItemSprite), or null when it has none. */
export function spriteStyle(name: string): string | null {
  const i = ATLAS.index[norm(name)];
  if (i === undefined) return null;
  const col = i % ATLAS.cols;
  const row = Math.floor(i / ATLAS.cols);
  const x = ATLAS.cols > 1 ? (col / (ATLAS.cols - 1)) * 100 : 0;
  const y = ATLAS.rows > 1 ? (row / (ATLAS.rows - 1)) * 100 : 0;
  return `background-image:url(${ATLAS.file});background-position:${x}% ${y}%;background-size:${ATLAS.cols * 100}% ${ATLAS.rows * 100}%`;
}

/** The sheet's file on disk, for the static route; null when the package has no sheet. */
export function spriteSheetPath(): { url: string; file: string } | null {
  const file = path.join(NODE_PACKAGE_DIR, "public", ATLAS.file.replace(/^\//, ""));
  return fs.existsSync(file) ? { url: ATLAS.file, file } : null;
}

// --- item facts communism page filters and sorts by ------------------------
// The same three files the node's pool page reads: who can use an item and
// in which slot, what the forge gives for dismantling it, its pet feed power,
// and the stats it adds on equip (with enchantment bonuses).

export type MatKey = "common" | "rare" | "legendary" | "mythical";
export const MAT_KEYS: MatKey[] = ["common", "rare", "legendary", "mythical"];
export type Dismantle = Record<MatKey, number | null>;
export interface ItemMeta {
  classes: string[] | null;
  slot: string | null;
  dismantle: Dismantle | null;
  feedPower: number;
}
const ITEM_INDEX = itemIndex as unknown as Record<string, ItemMeta>;
const TOOLTIPS = itemTooltips as unknown as Record<string, { e?: { s: string; v: number; r?: boolean; pct?: boolean }[] }>;
const ENCHANT_MODS = enchantMods as unknown as Record<string, { e?: { s: string; v: number }[] }>;

export const STATS = ["ATT", "DEF", "SPD", "DEX", "VIT", "WIS", "HP", "MP"] as const;
export const STAT_LABELS: Record<(typeof STATS)[number], string> = { ATT: "Attack", DEF: "Defense", SPD: "Speed", DEX: "Dexterity", VIT: "Vitality", WIS: "Wisdom", HP: "HP", MP: "MP" };

export function itemMeta(name: string): ItemMeta | null {
  return ITEM_INDEX[norm(name)] ?? null;
}

/** Flat on-equip stat totals of an item with these enchantments, non-zero stats only. */
export function statTotals(name: string, enchantIds: number[]): Partial<Record<(typeof STATS)[number], number>> {
  const t = TOOLTIPS[norm(name)];
  if (!t) return {};
  const totals = new Map<string, number>();
  for (const e of t.e ?? []) if (!e.r && !e.pct) totals.set(e.s, (totals.get(e.s) ?? 0) + e.v);
  for (const id of enchantIds) for (const e of ENCHANT_MODS[String(id)]?.e ?? []) totals.set(e.s, (totals.get(e.s) ?? 0) + e.v);
  const out: Partial<Record<(typeof STATS)[number], number>> = {};
  for (const s of STATS) if (totals.get(s)) out[s] = totals.get(s)!;
  return out;
}

/** Every distinct forge yield in the catalog as a dense [common, rare, legendary, mythical] vector: the material sliders snap to these and keep each other feasible. */
export const DISMANTLE_VECTORS: number[][] = (() => {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const m of Object.values(ITEM_INDEX)) {
    if (!m.dismantle) continue;
    const v = MAT_KEYS.map((k) => m.dismantle![k] ?? 0);
    const key = v.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
})();

/** Snap steps per material: 0 plus every amount some item yields, ascending. */
export const MAT_STEPS: Record<MatKey, number[]> = Object.fromEntries(
  MAT_KEYS.map((k, i) => [k, [...new Set([0, ...DISMANTLE_VECTORS.map((v) => v[i]).filter((n) => n > 0)])].sort((a, b) => a - b)]),
) as Record<MatKey, number[]>;

// --- the bundle the browser fetches (item picker, client-side names) --------

export interface CatalogBundle {
  items: { id: string; name: string; cat: string; sub?: string }[];
  categories: string[];
  enchants: Record<string, string>;
  /** Effect keys per enchantment id ("+Attack", "-MP Cost"): the picker offers "adds Attack". */
  effects: Record<string, string[]>;
  effectLabels: Record<string, string>;
  atlas: { file: string; cols: number; rows: number; index: Record<string, number> };
  servers: string[];
}

let tipBundle: { etag: string; body: string; gzip: Buffer } | null = null;
/**
 * What the communism page's hover card reads, fetched on the first hover: the
 * game's item tooltips and the enchantments' stat changes (the node's
 * item-tooltips.json and enchant-mods.json, the same files rotmgcommunism's card
 * uses), and the enchantment names. Icons come one by one from /enchant-icon.
 */
export function tooltipBundle(): { etag: string; body: string; gzip: Buffer } {
  if (tipBundle) return tipBundle;
  const body = JSON.stringify({ items: itemTooltips, mods: enchantMods, enchants: Object.fromEntries([...loadEnchantNames()].map(([id, name]) => [String(id), name])) });
  // ~480 KB as JSON, under 100 KB gzipped: the tooltips are most of it.
  tipBundle = { etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`, body, gzip: gzipSync(body) };
  return tipBundle;
}

let bundle: { etag: string; body: string } | null = null;
export function catalogBundle(): { etag: string; body: string } {
  if (bundle) return bundle;
  const effects: Record<string, string[]> = {};
  const effectLabels: Record<string, string> = {};
  for (const id of loadEnchantNames().keys()) {
    const keys = effectsOfEnchant(id);
    if (keys.length) effects[String(id)] = keys;
    for (const k of keys) effectLabels[k] ??= effectLabel(k);
  }
  const b: CatalogBundle = {
    items: CATALOG.map((i) => ({ id: i.id, name: i.name, cat: i.category, ...(i.subtype ? { sub: i.subtype } : {}) })),
    categories: CATEGORIES,
    enchants: Object.fromEntries([...loadEnchantNames()].map(([id, name]) => [String(id), name])),
    effects,
    effectLabels,
    atlas: { file: ATLAS.file, cols: ATLAS.cols, rows: ATLAS.rows, index: ATLAS.index },
    servers: [...SERVERS],
  };
  const body = JSON.stringify(b);
  bundle = { etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`, body };
  return bundle;
}
