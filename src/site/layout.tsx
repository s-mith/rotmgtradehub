// The website's frame and the pieces every page shares: the header over a
// row of section tabs (laid out like the node's control panel), item tiles
// painted from the sprite sheet, badges, and the words the site uses for the
// protocol's things (a rendezvous is a "meeting" to a person, a half is the
// seasonal or non-seasonal part of a pool).
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { RendezvousState, GuestRequestState, OfferStatusWire } from "rotmgtradenode/shared/hubWire";
import type { User } from "../auth";
import { enchantName, itemName, spriteStyle } from "../catalog";
import { staticUrl } from "../static";

export type NavKey = "home" | "me" | "communism" | "admin" | "activity";

export interface Frame {
  /** The signed-in person, or null. */
  user: User | null;
  admin?: boolean;
  active?: NavKey;
}

const NAV: { key: NavKey; href: string; label: string; needsUser: boolean }[] = [
  { key: "me", href: "/me", label: "My nodes", needsUser: true },
  { key: "communism", href: "/communism", label: "Communism", needsUser: true },
  { key: "activity", href: "/activity", label: "Activity", needsUser: true },
];

/** `refresh`: seconds between reloads, for a page waiting on a node (a request open). */
export const Layout: FC<PropsWithChildren<{ title: string; frame?: Frame; refresh?: number }>> = ({ title, frame, refresh, children }) => {
  const user = frame?.user ?? null;
  const tabs = [...NAV.filter((n) => !n.needsUser || user), ...(frame?.admin ? [{ key: "admin" as const, href: "/admin", label: "Admin" }] : [])];
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        {refresh ? <meta http-equiv="refresh" content={String(refresh)} /> : null}
        <title>{title === "rotmg trade" ? title : `${title} · rotmg trade`}</title>
        <link rel="icon" href={staticUrl("logo.png")} />
        <link rel="stylesheet" href={staticUrl("hub.css")} />
      </head>
      <body>
        <div class="frame">
          <header class="site">
            {/* The logo and name lead back to the front page. */}
            <a class="brand" href="/" title="rotmg trade home">
              <img src={staticUrl("logo.png")} alt="" width={48} height={48} />
              <span class="wordmark">
                rotmg trade
                {/* The beta sash across the wordmark's corner, as on the node. */}
                <span class="beta">beta</span>
              </span>
            </a>
            <div class="who">
              {user ? (
                <>
                  <span class="name" title={user.email ?? undefined}>{user.displayName}</span>
                  <form method="post" action="/logout"><button class="quiet small" type="submit">sign out</button></form>
                </>
              ) : (
                <a class="button small" href="/">Sign in</a>
              )}
            </div>
          </header>
          {tabs.length > 0 && (
            <nav class="section-tabs" aria-label="Sections">
              {tabs.map((n) => (
                <a href={n.href} class={frame?.active === n.key ? "active" : undefined} aria-current={frame?.active === n.key ? "page" : undefined}>{n.label}</a>
              ))}
            </nav>
          )}
        </div>
        <main>{children}</main>
        <footer class="site">
          <span>rotmg trade holds accounts, node keys and receipts. Items, credentials and Realm traffic stay on players' own computers.</span>
          <span class="muted"><a href="/privacy">privacy</a> · open source · MIT</span>
        </footer>
        <script src={staticUrl("hub.js")} defer></script>
      </body>
    </html>
  );
};

// --- small pieces -----------------------------------------------------------

export const Flash: FC<{ error?: string; ok?: string }> = ({ error, ok }) => (
  <>
    {error && <p class="flash bad" role="alert">{error}</p>}
    {ok && <p class="flash good" role="status">{ok}</p>}
  </>
);

/** A moment, rendered once server-side and kept relative by hub.js. */
export const When: FC<{ at: number | null | undefined; never?: string }> = ({ at, never = "never" }) =>
  at ? <time datetime={new Date(at).toISOString()} data-ago title={new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z"}>{ago(at)}</time> : <span class="muted">{never}</span>;

export function ago(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 0) return `in ${fmtSpan(-s)}`;
  if (s < 45) return "just now";
  return `${fmtSpan(s)} ago`;
}
function fmtSpan(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export const Badge: FC<PropsWithChildren<{ tone?: "good" | "bad" | "warn" | "muted" | "accent" }>> = ({ tone = "muted", children }) => <span class={`badge ${tone}`}>{children}</span>;

export const Online: FC<{ online: boolean; lastSeenAt: number | null }> = ({ online, lastSeenAt }) =>
  online ? <Badge tone="good">online</Badge> : <span class="muted">offline · last seen <When at={lastSeenAt} /></span>;

/** One catalog item's sprite from the sheet, or its initials when the sheet has none. */
export const Sprite: FC<{ name: string; size?: number }> = ({ name, size = 40 }) => {
  const style = spriteStyle(name);
  const box = `width:${size}px;height:${size}px`;
  return style ? <span class="spr" aria-hidden="true" style={`${box};${style}`} /> : <span class="spr fallback" aria-hidden="true" style={box}>{name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}</span>;
};

/** An item as a tile: sprite, name, and the facts a person weighs (enchantments, which half, whether its bot is online). */
export const ItemTile: FC<PropsWithChildren<{ itemId: string; name?: string; enchants?: number[] | null; count?: number; seasonal?: boolean; online?: boolean; sub?: string | Child; selectable?: { name: string; value: string; disabled?: boolean } }>> = ({ itemId, name, enchants, count, seasonal, online, sub, selectable, children }) => {
  const label = name || itemName(itemId);
  const ench = enchants && enchants.length ? enchants.map((e) => enchantName(e)) : null;
  const n = count ?? (enchants?.length ?? 0);
  const body = (
    <>
      <Sprite name={label} />
      <span class="tile-body">
        <span class="tile-name">{label}</span>
        <span class="tile-meta">
          {n > 0 ? <span title={ench ? ench.join(", ") : undefined}>{n} enchant{n === 1 ? "" : "s"}{ench ? `: ${ench.join(", ")}` : ""}</span> : <span class="muted">no enchants</span>}
          {seasonal !== undefined && <span class="muted"> · {halfName(seasonal)}</span>}
          {online !== undefined && (online ? <span class="good"> · bot online</span> : <span class="muted"> · bot offline</span>)}
          {sub && <span class="muted"> · {sub}</span>}
        </span>
        {children}
      </span>
    </>
  );
  return selectable ? (
    <label class={`tile pick${selectable.disabled ? " disabled" : ""}`} data-name={label.toLowerCase()} data-item={itemId}>
      <input type="checkbox" name={selectable.name} value={selectable.value} disabled={selectable.disabled} data-item={itemId} />
      {body}
    </label>
  ) : (
    <div class="tile" data-name={label.toLowerCase()} data-item={itemId}>{body}</div>
  );
};

/** A catalog quantity ("2× Ring of Decades") with its sprite; want lines and receipts use it. */
export const Qty: FC<{ itemId: string; qty: number; min?: number }> = ({ itemId, qty, min }) => (
  <span class="qty">
    <Sprite name={itemName(itemId)} size={22} />
    {qty > 1 && <b>{qty}× </b>}
    {itemName(itemId)}
    {min ? <span class="muted"> ({min}+ enchants)</span> : null}
  </span>
);

/** `<select name=server>` with the live server list; hub.js remembers the last pick per browser. */
export const ServerSelect: FC<{ servers: readonly string[]; name?: string; suggested?: string | null; required?: boolean; form?: string; id?: string }> = ({ servers, name = "server", suggested, required, form, id }) => (
  <select name={name} data-remember="server" required={required} form={form} id={id}>
    {servers.map((s) => <option value={s} selected={s === suggested}>{s}{s === suggested ? " (this node's bot waits here)" : ""}</option>)}
  </select>
);

// --- words ------------------------------------------------------------------

export const halfName = (seasonal: boolean): string => (seasonal ? "seasonal" : "non-seasonal");

export function meetingWords(state: RendezvousState): { text: string; tone: "good" | "bad" | "warn" | "muted" | "accent" } {
  switch (state) {
    case "meet": return { text: "meeting now", tone: "accent" };
    case "done": return { text: "done", tone: "good" };
    case "failed": return { text: "did not happen", tone: "muted" };
    case "aborted": return { text: "called off", tone: "muted" };
    case "disputed": return { text: "disputed", tone: "bad" };
  }
}

export function offerWords(status: OfferStatusWire): { text: string; tone: "good" | "bad" | "warn" | "muted" | "accent" } {
  switch (status) {
    case "open": return { text: "open", tone: "good" };
    case "accepted": return { text: "meeting under way", tone: "accent" };
    case "done": return { text: "swapped", tone: "good" };
    case "cancelled": return { text: "cancelled", tone: "muted" };
    case "expired": return { text: "expired", tone: "muted" };
    case "void": return { text: "void (disputed)", tone: "bad" };
  }
}

export function requestWords(state: GuestRequestState): { text: string; tone: "good" | "bad" | "warn" | "muted" | "accent" } {
  switch (state) {
    case "pending": return { text: "waiting for the node", tone: "warn" };
    case "taken": return { text: "the node is on it", tone: "accent" };
    case "done": return { text: "done", tone: "good" };
    case "failed": return { text: "failed", tone: "bad" };
    case "expired": return { text: "expired unanswered", tone: "muted" };
  }
}
