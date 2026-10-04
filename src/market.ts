// Which pool half a page shows. Offers themselves are posted and browsed on the
// nodes; the hub shows one offer at a time, by its link (site/offers.tsx).

export type Half = "seasonal" | "nonseasonal" | "all";

export function inHalf(o: { seasonal: boolean }, half: Half): boolean {
  return half === "all" || (half === "seasonal") === o.seasonal;
}

export function parseHalf(raw: string | undefined, fallback: Half): Half {
  return raw === "seasonal" || raw === "nonseasonal" || raw === "all" ? raw : fallback;
}
