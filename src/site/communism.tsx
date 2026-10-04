// Communism: one board of everything every online node set aside, free
// to take and open to deposits, laid out like the node's own pool page: the
// grid of tiles on the left (one per stack of identical items, click to
// pick), the transact panel on the right (a withdraw tray, or a deposit).
// Anyone signed in withdraws or deposits by meeting a node's communism account
// in game with their own IGN (a request the node runs); an owner can also
// move items between communism with their node. The filters and sorts are the
// node pool page's: a tag search over items, enchantments and effects, sort
// by feed power / quantity / enchant slots / a stat, the forge material and
// feed-power and enchant-slot sliders (each "X or more" or "exactly X"),
// collapse by rarity, and the class / slot / consumable rail. Every fact
// they work on is a data attribute on the tile, so public/hub.js filters
// and sorts without another request. Everything works without script (tiles
// are checkboxes); the script adds the tray and the filters, and keeps the
// board current: a stream (/communism/stream) says when the hub's revision
// moved, and the script fetches only the tiles that changed since the one it
// has (/communism/delta), so an open page costs a few hundred bytes per trade.
import { createHash } from "node:crypto";
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { changesSince, currentRev, subscribe } from "../communismLive";
import { holdStream } from "../streams";
import type { CommunismNodeWire } from "rotmgtradenode/shared/hubWire";
import { tradingIgnsOf, type User } from "../auth";
import { DISMANTLE_VECTORS, ITEM_BY_ID, MAT_KEYS, MAT_STEPS, SERVERS, STATS, STAT_LABELS, effectLabel, effectsOfEnchant, enchantName, itemMeta, spriteStyle, statTotals } from "../catalog";
import { communismBoard, communismNodes, type CommunismBoardItem } from "../communism";
import { inHalf, parseHalf } from "../market";

/** The board shows one pool half at a time, like the node's pool page: a character can only trade with bots of its own side. */
type Half = "seasonal" | "nonseasonal";
import { NODE_ONLINE_MS, nodesOf, type NodeView } from "../nodes";
import { MAX_WITHDRAW_ITEMS, MAX_WITHDRAW_NODES, createGuestRequest } from "../requests";
import { Badge, Flash, Layout, ServerSelect, halfName } from "./layout";
import { fields, type Site } from "./context";

/** Identical items on one account fold into one tile; a click picks one of them. */
interface Stack {
  /** node|bot|item|enchants: the live feed's key (communismLive's stackKey). Names a bot, so the page only ever sees publicKey() of it. */
  key: string;
  itemId: string;
  name: string;
  enchants: number[];
  cat: string;
  nodeId: string;
  node: string;
  seasonal: boolean;
  refs: string[];
  newest: number;
}

function stacks(items: CommunismBoardItem[]): Stack[] {
  const out = new Map<string, Stack>();
  for (const it of items) {
    const ench = [...(it.enchants ?? [])].sort((a, b) => a - b);
    const key = `${it.nodeId}|${it.botIgn}|${it.itemId}|${ench.join(",")}`;
    const cur = out.get(key);
    if (cur) {
      cur.refs.push(it.ref);
      cur.newest = Math.max(cur.newest, it.listedAt);
      continue;
    }
    const cat = ITEM_BY_ID.get(it.itemId);
    out.set(key, { key, itemId: it.itemId, name: it.name, enchants: ench, cat: cat?.category ?? "Other", nodeId: it.nodeId, node: it.node, seasonal: it.seasonal, refs: [it.ref], newest: it.listedAt });
  }
  // The default order is the pool page's: feed power, then name.
  return [...out.values()].sort((a, b) => (itemMeta(b.name)?.feedPower ?? 0) - (itemMeta(a.name)?.feedPower ?? 0) || a.name.localeCompare(b.name) || a.enchants.length - b.enchants.length || a.node.localeCompare(b.node));
}

const RARITY = ["common", "uncommon", "rare", "legendary", "divine"] as const;

/**
 * What the page calls a stack instead of its key: which bot holds an item is
 * nobody's business but the node's (2026-09-25), and the key names it. Stable,
 * so the live feed's updates still find their tile.
 */
const publicKey = (key: string): string => createHash("sha256").update(key).digest("base64url").slice(0, 16);

/** The corner badge rotmgcommunism draws: the game's enchantment-slot icon for one (uncommon) or two (rare, twice as wide) enchantments, a dot beyond that. */
const RarityBadge: FC<{ rarity: (typeof RARITY)[number] }> = ({ rarity }) =>
  rarity === "uncommon" || rarity === "rare"
    ? <img class={`rarity-icon${rarity === "rare" ? " rarity-icon-wide" : ""}`} src={`/rarity/${rarity}.png`} alt="" aria-hidden="true" />
    : <span class={`rarity-dot ${rarity}`} />;

const Tile: FC<{ s: Stack; online: boolean }> = ({ s, online }) => {
  const style = spriteStyle(s.name);
  const ench = s.enchants.map((e) => enchantName(e));
  const title = `${s.name}${ench.length ? ` · ${ench.join(", ")}` : ""} · ${s.node}${s.refs.length > 1 ? ` · ×${s.refs.length}` : ""}`;
  const rarity = RARITY[Math.min(s.enchants.length, 4)];
  const meta = itemMeta(s.name);
  const effects = [...new Set(s.enchants.flatMap((e) => effectsOfEnchant(e)))];
  const stats = statTotals(s.name, s.enchants);
  return (
    <label
      class={`pool-tile rarity-${rarity}${online ? "" : " unclickable"}`}
      title={title}
      data-key={publicKey(s.key)}
      data-name={`${s.name} ${ench.join(" ")} ${s.node}`.toLowerCase()}
      data-item={s.itemId}
      data-label={s.name}
      data-ench={String(s.enchants.length)}
      data-enchnames={ench.join("|")}
      data-enchids={s.enchants.join(",")}
      data-effects={effects.join("|")}
      data-node={s.nodeId}
      data-nodename={s.node}
      data-cat={s.cat}
      data-fp={String(meta?.feedPower ?? 0)}
      data-mat={meta?.dismantle ? MAT_KEYS.map((k) => meta.dismantle![k] ?? 0).join(",") : ""}
      data-classes={meta?.classes && meta.slot ? meta.classes.join(",") : ""}
      data-slot={meta?.slot ?? ""}
      data-stats={Object.entries(stats).map(([k, v]) => `${k}:${v}`).join(",")}
      data-at={String(s.newest)}
      data-refs={JSON.stringify(s.refs)}
      data-sprite={style ?? ""}
    >
      <input type="checkbox" name="refs" value={`${s.nodeId}~${s.refs[0]}`} form="withdraw-form" disabled={!online} data-node={s.nodeId} />
      {style ? <span class="spr tile-spr" aria-hidden="true" style={style} /> : <span class="tile-fallback" aria-hidden="true">{s.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}</span>}
      <span class="stack-count" hidden={s.refs.length <= 1}>×{s.refs.length}</span>
      <RarityBadge rarity={rarity} />
    </label>
  );
};

// --- the filters above and beside the grid (the node's FilterRail and sliders) ---

/** The 19 classes in canonical order, each shown as its tier-6 ability item. */
const CLASS_ABILITIES: { cls: string; ability: string }[] = [
  { cls: "Rogue", ability: "Cloak of Ghostly Concealment" },
  { cls: "Archer", ability: "Quiver of Elvish Mastery" },
  { cls: "Wizard", ability: "Elemental Detonation Spell" },
  { cls: "Priest", ability: "Tome of Holy Guidance" },
  { cls: "Warrior", ability: "Helm of the Great General" },
  { cls: "Knight", ability: "Colossus Shield" },
  { cls: "Paladin", ability: "Seal of the Blessed Champion" },
  { cls: "Assassin", ability: "Baneserpent Poison" },
  { cls: "Necromancer", ability: "Bloodsucker Skull" },
  { cls: "Huntress", ability: "Giantcatcher Trap" },
  { cls: "Mystic", ability: "Planefetter Orb" },
  { cls: "Trickster", ability: "Prism of Apparitions" },
  { cls: "Sorcerer", ability: "Scepter of Storms" },
  { cls: "Ninja", ability: "Doom Circle" },
  { cls: "Samurai", ability: "Royal Wakizashi" },
  { cls: "Bard", ability: "Skyward Lute" },
  { cls: "Summoner", ability: "Sovereign Mace" },
  { cls: "Kensei", ability: "Great Shinobi Sheath" },
  { cls: "Druid", ability: "Sigil of the Horse" },
];
const SLOT_ICONS: { slot: string; label: string; icon: string }[] = [
  { slot: "weapon", label: "Weapon", icon: "Sword of Splendor" },
  { slot: "ability", label: "Ability", icon: "Colossus Shield" },
  { slot: "armor", label: "Armor", icon: "Dominion Armor" },
  { slot: "ring", label: "Ring", icon: "Ring of Unbound Health" },
];
/** Consumable buttons, keyed to the catalog category they stand for. */
const CONSUMABLE_ICONS: { kind: string; cat: string; label: string; icon: string }[] = [
  { kind: "potion", cat: "Potion", label: "Potions", icon: "Potion of Life" },
  { kind: "egg", cat: "Egg", label: "Eggs", icon: "Rare ???? Egg" },
];
const FORGE_TIERS = [
  { key: "mythical", label: "Mythical Material" },
  { key: "legendary", label: "Legendary Material" },
  { key: "rare", label: "Rare Material" },
  { key: "common", label: "Common Material" },
] as const;

const RailButton: FC<{ group: string; value: string; label: string; icon: string }> = ({ group, value, label, icon }) => {
  const style = spriteStyle(icon);
  return (
    <button type="button" class="class-rail-btn" aria-pressed="false" title={label} aria-label={label} data-rail={group} data-value={value}>
      {style ? <span class="class-rail-icon spr" style={style} /> : <span class="class-rail-icon tile-fallback">{label.slice(0, 2)}</span>}
    </button>
  );
};

const FilterRail: FC = () => (
  <div class="class-rail" data-rail-box>
    <div class="class-rail-label">Class</div>
    <div class="class-rail-group" role="group" aria-label="Filter by class">
      {CLASS_ABILITIES.map((c) => <RailButton group="class" value={c.cls} label={c.cls} icon={c.ability} />)}
    </div>
    <div class="class-rail-label">Slot</div>
    <div class="class-rail-group" role="group" aria-label="Filter by slot">
      {SLOT_ICONS.map((s) => <RailButton group="slot" value={s.slot} label={s.label} icon={s.icon} />)}
    </div>
    <div class="class-rail-label">Consumables</div>
    <div class="class-rail-group" role="group" aria-label="Filter by consumable">
      {CONSUMABLE_ICONS.map((c) => <RailButton group="consumable" value={c.cat} label={c.label} icon={c.icon} />)}
    </div>
  </div>
);

/** The value beside a slider; clicking it flips "X or more" to "exactly X". Script owns it after load. */
const SliderValue: FC<{ cls: string; group: string }> = ({ cls, group }) => (
  <button type="button" class={`${cls} slider-val-toggle`} aria-pressed="false" data-exact={group} title="Click to match exactly this amount">0 or more</button>
);

const Sliders: FC<{ feedSteps: number[] }> = ({ feedSteps }) => (
  <div class="mat-filters">
    <div class="mat-sliders" role="group" aria-label="Filter by dismantle value">
      {FORGE_TIERS.map((t) => (
        <label class="mat-slider">
          <img class="mat-slider-icon" src={`/forge/${t.key}.png`} alt="" aria-hidden="true" />
          <span class="mat-slider-label">{t.label}</span>
          <input type="range" min="0" max={String(MAT_STEPS[t.key].length - 1)} step="1" value="0" aria-label={`Minimum ${t.label} material`} data-slider="mat" data-mat={t.key} data-steps={MAT_STEPS[t.key].join(",")} />
          <SliderValue cls="mat-slider-val" group="mat" />
        </label>
      ))}
    </div>
    <div class="side-sliders">
      <div class="side-slider">
        <span class="side-slider-label">Feed Power</span>
        <input type="range" min="0" max={String(Math.max(1, feedSteps.length - 1))} step="1" value="0" aria-label="Minimum feed power" data-slider="feed" data-steps={feedSteps.join(",")} />
        <SliderValue cls="side-slider-val" group="feed" />
      </div>
      <div class="side-slider">
        <span class="side-slider-label">Enchant Slots</span>
        <input type="range" min="0" max="2" step="1" value="0" aria-label="Minimum enchant slots" data-slider="ench" />
        <SliderValue cls="side-slider-val" group="ench" />
      </div>
    </div>
  </div>
);

const Room: FC<{ n: CommunismNodeWire; half: Half }> = ({ n, half }) => {
  const r = n[half];
  return <span class="muted small">{halfName(half === "seasonal")}: <b class={r.free ? "good" : ""}>{r.free}</b>/{r.slots} free on {r.accounts} account{r.accounts === 1 ? "" : "s"}</span>;
};

/** Which of the person's characters meets the bot: a choice when they have several, their main one first. */
const CharacterField: FC<{ igns: string[]; form: string; id: string }> = ({ igns, form, id }) =>
  igns.length > 1 ? (
    <>
      <label class="lbl" for={id}>As</label>
      <select id={id} name="ign" form={form}>{igns.map((i) => <option value={i}>{i}</option>)}</select>
    </>
  ) : igns.length === 1 ? <input type="hidden" name="ign" value={igns[0]} form={form} /> : null;

/** Per node that picks copies itself (CommunismNodeWire.byCount): the potions it lists in this half, with how many plain copies are on the board. */
type Countable = Map<string, { itemId: string; name: string; n: number }[]>;

function countable(items: CommunismBoardItem[], nodes: CommunismNodeWire[], half: Half): Countable {
  const byCount = new Set(nodes.filter((n) => n.online && n.byCount).map((n) => n.nodeId));
  const counts = new Map<string, Map<string, number>>();
  for (const it of items) {
    if (!byCount.has(it.nodeId) || !inHalf(it, half) || it.count !== 0 || ITEM_BY_ID.get(it.itemId)?.category !== "Potion") continue;
    const m = counts.get(it.nodeId) ?? new Map<string, number>();
    m.set(it.itemId, (m.get(it.itemId) ?? 0) + 1);
    counts.set(it.nodeId, m);
  }
  const out: Countable = new Map();
  for (const [nodeId, m] of counts) out.set(nodeId, [...m].map(([itemId, n]) => ({ itemId, name: ITEM_BY_ID.get(itemId)!.name, n })).sort((a, b) => a.name.localeCompare(b.name)));
  return out;
}

/** "N of this item" from a node that picks the copies: which node and item, how many, where and as whom. */
const ByCount: FC<{ nodes: CommunismNodeWire[]; counts: Countable; igns: string[]; suggested: string | null; seasonal: boolean }> = ({ nodes, counts, igns, suggested, seasonal }) => {
  const offering = nodes.filter((n) => counts.get(n.nodeId)?.length);
  if (!offering.length) return null;
  return (
    <details class="by-count" data-by-count>
      <summary>Or ask for a number of one potion</summary>
      <p class="hint">{offering.length === 1 ? `${offering[0].name} picks` : "These nodes pick"} the copies for you: plain ones, from as few of their accounts as they can.</p>
      <label class="lbl" for="count-item">Item</label>
      <select id="count-item" name="pick" form="count-form" required>
        {offering.map((n) => (
          <optgroup label={n.name}>
            {counts.get(n.nodeId)!.map((c) => <option value={`${n.nodeId}~${c.itemId}`}>{c.name} · {c.n} there</option>)}
          </optgroup>
        ))}
      </select>
      <label class="lbl" for="count-qty">How many</label>
      <input id="count-qty" type="number" name="qty" min="1" max={String(MAX_WITHDRAW_ITEMS)} value="1" form="count-form" required />
      <label class="lbl" for="count-server">Server</label>
      <ServerSelect servers={SERVERS} suggested={suggested} required form="count-form" id="count-server" />
      <CharacterField igns={igns} form="count-form" id="count-ign" />
      <input type="hidden" name="seasonal" value={seasonal ? "1" : "0"} form="count-form" />
      <div class="submit-row"><button type="submit" class="submit" form="count-form">Ask for them</button></div>
    </details>
  );
};

const Transact: FC<{ nodes: CommunismNodeWire[]; half: Half; igns: string[]; mine: NodeView[]; now: number; counts: Countable }> = ({ nodes, half, igns, mine, now, counts }) => {
  const ign = igns[0] ?? null;
  const seasonal = half === "seasonal";
  const room = (n: CommunismNodeWire) => n[half].free;
  const roomWords = (n: CommunismNodeWire) => `${room(n)} free`;
  const halfWords = `${halfName(seasonal)} `;
  const HalfField: FC<{ form: string }> = ({ form }) => <input type="hidden" name="seasonal" value={seasonal ? "1" : "0"} form={form} />;
  const open = nodes.filter((n) => n.online && room(n) > 0);
  const onlineMine = mine.filter((m) => m.last_seen_at !== null && now - m.last_seen_at <= NODE_ONLINE_MS);
  const suggested = open[0]?.server ?? nodes.find((n) => n.server)?.server ?? null;
  return (
    <section class="panel transact" data-transact>
      <h2>Transact</h2>
      <div class="tabs" role="tablist">
        <button type="button" class="active" data-tab="withdraw">Withdraw</button>
        <button type="button" data-tab="deposit">Deposit</button>
      </div>

      <div data-pane="withdraw">
        {!ign && <p class="hint">Add <a href="/me#settings">your character</a> to take items yourself; the account holding them only trades with that name.</p>}
        <label class="lbl">Withdraw tray <span class="muted" data-tray-count data-tray-max={String(MAX_WITHDRAW_ITEMS)}>(0/{MAX_WITHDRAW_ITEMS})</span></label>
        <div class="tray" data-tray>
          {Array.from({ length: 8 }, () => <span class="tray-slot empty"><span class="tray-empty-mark">+</span></span>)}
        </div>
        <p class="hint" data-tray-hint>Click items in the pool to add them; click a slot to take it out. Up to {MAX_WITHDRAW_ITEMS} items per withdraw, from up to {MAX_WITHDRAW_NODES} nodes: each node's bot meets you in turn.</p>
        <label class="lbl" for="withdraw-server">Server</label>
        <ServerSelect servers={SERVERS} suggested={suggested} required form="withdraw-form" id="withdraw-server" />
        <CharacterField igns={igns} form="withdraw-form" id="withdraw-ign" />
        <div class="submit-row">
          {ign ? (
            <button type="submit" name="do" value="withdraw" class="submit" form="withdraw-form" data-submit-withdraw>Take <span data-tray-n>the picked</span> items{igns.length === 1 ? ` as ${ign}` : ""}</button>
          ) : (
            <button type="button" class="submit" disabled>Add your character to withdraw</button>
          )}
          {onlineMine.length > 0 && (
            <div class="row" style="margin:6px 0 0">
              {onlineMine.length === 1 ? <input type="hidden" name="taker" value={onlineMine[0].id} form="withdraw-form" /> : <select name="taker" form="withdraw-form">{onlineMine.map((t) => <option value={t.id}>{t.name}</option>)}</select>}
              <button type="submit" name="do" value="take" class="quiet small" form="withdraw-form" data-submit-take>…or take them with {onlineMine.length === 1 ? onlineMine[0].name : "my node"} instead</button>
            </div>
          )}
        </div>
        {ign && <ByCount nodes={nodes} counts={counts} igns={igns} suggested={suggested} seasonal={seasonal} />}
      </div>

      <div data-pane="deposit" hidden>
        {!ign ? (
          <p class="hint"><a href="/me#settings">Add your character</a> first: the bot only trades with that name.</p>
        ) : open.length === 0 ? (
          <p class="hint">No online node has a free {halfWords}slot in the pool right now.</p>
        ) : (
          <>
            <label class="lbl" for="deposit-node">Into</label>
            <select id="deposit-node" name="node" form="deposit-form" required>
              {open.map((n) => <option value={n.nodeId}>{n.name} · {roomWords(n)}</option>)}
            </select>
            <HalfField form="deposit-form" />
            <label class="lbl">Trade size</label>
            <div class="deposit-size" role="group">
              {[8, 16, 24].map((n, i) => (
                <label class={`size-btn${i === 0 ? " active" : ""}`}><input type="radio" name="count" value={String(n)} form="deposit-form" checked={i === 0} />{n} slots</label>
              ))}
              <span class="pool-option-hint">how many you bring; the account meeting you needs that much room</span>
            </div>
            <label class="lbl" for="deposit-server">Server</label>
            <ServerSelect servers={SERVERS} suggested={suggested} required form="deposit-form" id="deposit-server" />
            <CharacterField igns={igns} form="deposit-form" id="deposit-ign" />
            <p class="hint">Submit and one of that node's accounts in the pool meets {igns.length > 1 ? "your character" : ign} on the chosen server for one trade. Whatever you hand over is free for anyone on the hub to take. The bot to <code>/trade</code> shows on <a href="/me">your page</a> once the node has picked the request up.</p>
            <div class="submit-row"><button type="submit" class="submit" form="deposit-form">Deposit into the pool</button></div>
          </>
        )}
      </div>

    </section>
  );
};

const Nodes: FC<{ nodes: CommunismNodeWire[]; half: Half; mine: NodeView[] }> = ({ nodes, half, mine }) => (
  <section class="panel">
    <h2>Nodes</h2>
    {nodes.length === 0 ? <p class="hint" style="margin:0">Nobody has added an account to the pool yet. Owners tick "communism" on an account under their node's Control panel → Accounts.</p> : (
      <ul class="node-list">
        {nodes.map((n) => (
          <li>
            <div><b>{n.name}</b>{mine.some((m) => m.id === n.nodeId) ? <span class="muted"> (yours)</span> : null} {n.online ? <Badge tone="good">online</Badge> : <Badge>offline</Badge>}</div>
            <Room n={n} half={half} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

/** The board for one half as the page and the delta route see it. */
function boardFor(items: CommunismBoardItem[], nodes: CommunismNodeWire[], half: Half) {
  const inView = stacks(items.filter((it) => inHalf(it, half)));
  const online = new Set(nodes.filter((n) => n.online).map((n) => n.nodeId));
  const count = inView.reduce((n, s) => n + s.refs.length, 0);
  const totals = nodes.filter((n) => n.online).reduce((t, n) => ({ free: t.free + n[half].free, slots: t.slots + n[half].slots }), { free: 0, slots: 0 });
  const rest = ` · ${totals.free} of ${totals.slots} slot${totals.slots === 1 ? "" : "s"} free · ${online.size} node${online.size === 1 ? "" : "s"} online`;
  return { inView, online, count, totals, rest };
}

const CommunismPage: FC<{ user: User; igns: string[]; half: Half; items: CommunismBoardItem[]; nodes: CommunismNodeWire[]; mine: NodeView[]; now: number; error?: string; ok?: string }> = ({ igns, half, items, nodes, mine, now, error, ok }) => {
  const ign = igns[0] ?? null;
  const { inView, online, count, totals, rest } = boardFor(items, nodes, half);
  const counts = countable(items, nodes, half);
  const listing = nodes.filter((n) => n.online && inView.some((s) => s.nodeId === n.nodeId));
  // The feed-power slider snaps to values items on the board actually have.
  const feedSteps = [...new Set([0, ...inView.map((s) => itemMeta(s.name)?.feedPower ?? 0).filter((n) => n > 0)])].sort((a, b) => a - b);
  // Labels for the effect tags the search can offer, for the effects of enchantments on the board.
  const effectLabels = Object.fromEntries([...new Set(inView.flatMap((s) => s.enchants.flatMap((e) => effectsOfEnchant(e))))].map((k) => [k, effectLabel(k)]));
  return (
    <div class="pool-layout" data-communism data-half={half} data-communism-live="/communism/stream" data-rev={String(currentRev())}>
      {/* Facts the script filters with; "<" is escaped so no label can close the tag. */}
      <script type="application/json" data-communism-data dangerouslySetInnerHTML={{ __html: JSON.stringify({ effectLabels, dismantle: DISMANTLE_VECTORS, matSteps: MAT_STEPS }).replace(/</g, "\\u003c") }} />
      <Flash error={error} ok={ok} />
      <div class="pool-left">
        <section class="panel pool-panel">
          <div class="pool-head">
            <h2>The Pool</h2>
            <span class="pool-count" data-count-line data-rest={rest}>{count} item{count === 1 ? "" : "s"}{rest}</span>
          </div>
          <nav class="pool-tabs" aria-label="Which pool half">
            {(["seasonal", "nonseasonal"] as const).map((h) => <a href={`/communism?half=${h}`} class={"nav-link" + (h === half ? " active" : "")}>{h === "seasonal" ? "Seasonal" : "Non-seasonal"}</a>)}
          </nav>
          <div class="pool-controls">
            <div class="tag-search" data-tag-search>
              <div class="tag-search-box" data-tag-box>
                <input type="search" class="tag-search-input" placeholder="Search items, enchantments or effects…" aria-label="Search" autocomplete="off" spellcheck={false} role="combobox" aria-expanded="false" aria-autocomplete="list" data-search />
              </div>
              <ul class="tag-suggest" role="listbox" data-tag-suggest hidden></ul>
            </div>
            <label class="pool-sort">Sort
              <select data-sort>
                <option value="feed">Feed Power</option>
                <option value="qty">Quantity</option>
                <option value="rarity">Slots</option>
                <optgroup label="Stats">
                  {STATS.map((k) => <option value={`stat:${k}`}>{STAT_LABELS[k]}</option>)}
                </optgroup>
              </select>
            </label>
          </div>
          <Sliders feedSteps={feedSteps} />
          <div class="pool-options">
            <label class="pool-option">
              <input type="checkbox" data-collapse />
              <span>Collapse by rarity</span>
              <span class="pool-option-hint">one tile per item and rarity, enchants ignored</span>
            </label>
          </div>
          {listing.length > 1 && (
            <div class="chips" data-chips="node">
              <button type="button" class="chip active" data-value="">all nodes</button>
              {listing.map((n) => <button type="button" class="chip" data-value={n.nodeId}>{n.name} <span class="muted">· {n[half].free} free</span></button>)}
            </div>
          )}
          <div class="pool-body">
          <FilterRail />
          <div class="pool-grid-col">
          <p class="muted" data-board-empty hidden={inView.length > 0} style="margin:12px 0 4px">
            {nodes.some((n) => n.online) ? `The ${halfName(half === "seasonal")} pool is empty. Deposit something.` : "No node with accounts in the pool is online right now. Owners add them from their node's Control panel → Accounts."}
          </p>
          <div class="pool-grid" data-grid hidden={inView.length === 0}>
            {inView.map((s) => <Tile s={s} online={online.has(s.nodeId)} />)}
          </div>
          <p class="muted small" data-empty hidden style="margin:12px 0 4px">No items match your search.</p>
          </div>
          </div>
          {nodes.some((n) => !n.online) && <p class="muted small" style="margin:12px 0 0">Offline: {nodes.filter((n) => !n.online).map((n) => n.name).join(", ")}. Their items and room come back when they do.</p>}
        </section>
      </div>
      <aside class="pool-right">
        <Transact nodes={nodes} half={half} igns={igns} mine={mine} now={now} counts={counts} />
        <div data-nodes><Nodes nodes={nodes} half={half} mine={mine} /></div>
      </aside>
      <form id="withdraw-form" method="post" action="/communism/withdraw" data-withdraw-form></form>
      {ign && nodes.some((n) => n.online && n[half].free > 0) && <form id="deposit-form" method="post" action="/communism/deposit"></form>}
      {ign && counts.size > 0 && <form id="count-form" method="post" action="/communism/take-count"></form>}
    </div>
  );
};

export function registerCommunism(app: Hono, site: Site): void {
  const { db } = site;
  // The page's old address (before the rename on 2026-09-22) still gets people here.
  app.get("/" + "com" + "mons", (c) => c.redirect("/communism", 301));
  app.get("/communism", (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const raw = parseHalf(c.req.query("half"), "seasonal");
    const half: Half = raw === "nonseasonal" ? "nonseasonal" : "seasonal";
    return c.html(
      <Layout title="communism" frame={site.frame(user, "communism")}>
        <CommunismPage user={user} igns={tradingIgnsOf(db, user.id)} half={half} items={communismBoard(db)} nodes={communismNodes(db)} mine={nodesOf(db, user.id)} now={Date.now()} error={c.req.query("error")} ok={c.req.query("ok")} />
      </Layout>,
    );
  });
  // The board's revision, pushed as it moves; the page then asks /communism/delta for what changed.
  app.get("/communism/stream", (c) => {
    const user = site.me(c);
    if (!user) return c.text("sign in", 401);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (rev: number) => { void stream.writeSSE({ event: "message", data: String(rev), id: String(rev) }); };
      const off = subscribe(send);
      const end = () => { open = false; off(); };
      // Past the cap, this person's oldest stream here is closed: a page they left may still hold one.
      const release = holdStream(user.id, "communism", () => { end(); void stream.close(); });
      stream.onAbort(end);
      try {
        // Short sleeps so a close from outside ends the loop within a second; a comment every 25 s keeps proxies from closing it.
        for (let ticks = 0; open; ticks++) {
          await stream.sleep(1_000);
          if (open && ticks % 25 === 24) await stream.write(": keepalive\n\n");
        }
      } finally {
        release();
        off();
      }
    });
  });
  // What changed on one half since revision `since`: the tiles to swap in and the keys to drop, or the whole grid when the hub cannot say.
  app.get("/communism/delta", (c) => {
    const user = site.me(c);
    if (!user) return c.json({ error: "sign in" }, 401);
    const half: Half = parseHalf(c.req.query("half"), "seasonal") === "nonseasonal" ? "nonseasonal" : "seasonal";
    const since = Number(c.req.query("since"));
    const rev = currentRev();
    const nodes = communismNodes(db);
    const mine = nodesOf(db, user.id);
    const { inView, online, count, rest } = boardFor(communismBoard(db), nodes, half);
    const tile = (s: Stack) => String(<Tile s={s} online={online.has(s.nodeId)} />);
    const nodesHtml = String(<Nodes nodes={nodes} half={half} mine={mine} />);
    const change = Number.isInteger(since) ? changesSince(since, half === "seasonal") : { full: true as const };
    if (change.full) return c.json({ rev, full: inView.map(tile).join(""), count, rest, nodes: nodesHtml });
    const byKey = new Map(inView.map((s) => [s.key, s]));
    const tiles: { key: string; html: string }[] = [];
    const removed: string[] = [];
    for (const key of change.keys) {
      const s = byKey.get(key);
      if (s) tiles.push({ key: publicKey(key), html: tile(s) });
      else removed.push(publicKey(key));
    }
    return c.json({ rev, tiles, removed, count, rest, nodes: nodesHtml });
  });
  const back = (msg: { ok?: string; error?: string }) => `/communism?${msg.ok ? `ok=${encodeURIComponent(msg.ok)}` : `error=${encodeURIComponent(msg.error ?? "")}`}`;
  /**
   * A pick as the form sends it: "node~ref" (refs are unique per node only). A bare ref (an older page) names its node
   * with the form's `node`, or failing that is looked up, and only when exactly one node lists it.
   */
  const parsePick = (raw: string, node: string): { nodeId: string; ref: string } | null => {
    const at = raw.indexOf("~");
    if (at > 0) return { nodeId: raw.slice(0, at), ref: raw.slice(at + 1) };
    if (node) return { nodeId: node, ref: raw };
    const rows = db.prepare("SELECT node_id FROM communism_items WHERE ref = ? LIMIT 2").all(raw) as { node_id: string }[];
    return rows.length === 1 ? { nodeId: rows[0].node_id, ref: raw } : null;
  };
  // The picked items: withdrawn by the person, one request per node holding them, handed out one after another (a person has
  // one trade window, so each node's bot meets them in turn); or taken by one of their nodes (one request per item).
  app.post("/communism/withdraw", async (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const { one, many } = fields(await c.req.parseBody({ all: true }));
    const raw = [...new Set(many("refs"))];
    if (!raw.length) return c.redirect(back({ error: "pick at least one item" }));
    const byNode = new Map<string, string[]>();
    const picks: { nodeId: string; ref: string }[] = [];
    for (const r of raw) {
      const pick = parsePick(r, one("node"));
      if (!pick) return c.redirect(back({ error: "one of those items is not listed any more" }));
      picks.push(pick);
      byNode.set(pick.nodeId, [...(byNode.get(pick.nodeId) ?? []), pick.ref]);
    }
    if (byNode.size > MAX_WITHDRAW_NODES) return c.redirect(back({ error: `one withdraw takes from at most ${MAX_WITHDRAW_NODES} nodes` }));
    // One character takes them all, so one half of the pool: a seasonal character trades only seasonal items.
    const halves = new Set(picks.map((p) => (db.prepare("SELECT seasonal FROM communism_items WHERE node_id = ? AND ref = ?").get(p.nodeId, p.ref) as { seasonal: number } | undefined)?.seasonal));
    if (halves.size > 1) return c.redirect(back({ error: "one withdraw takes from one half of the pool: seasonal or non-seasonal items, not both" }));
    if (one("do") === "take") {
      let n = 0;
      for (const [nodeId, nodeRefs] of byNode) for (const ref of nodeRefs) {
        const r = createGuestRequest(db, user, one("taker"), { kind: "communism-take", server: one("server"), communism: { nodeId, ref } });
        if (!r.ok) return c.redirect(back({ error: n ? `${n} queued, then: ${r.error}` : r.error }));
        n++;
      }
      return c.redirect(back({ ok: `${n} take${n === 1 ? "" : "s"} queued. Your node asks for the item${n === 1 ? "" : "s"} within a minute; the meeting then shows on My nodes.` }));
    }
    // All or nothing: one node refusing (offline, an item gone) queues none of them.
    let made: { id: number; server: string | null }[] = [];
    let error: string | null = null;
    try {
      db.transaction(() => {
        for (const [nodeId, nodeRefs] of byNode) {
          const r = createGuestRequest(db, user, nodeId, { kind: "withdraw", server: one("server"), refs: nodeRefs, ign: one("ign") || undefined, ...(made.length ? { after: made[made.length - 1].id } : {}) });
          if (!r.ok) {
            error = byNode.size > 1 ? `nothing queued: ${r.error}` : r.error;
            throw new Error("refused");
          }
          made.push({ id: r.request.id, server: r.request.server });
        }
      })();
    } catch {
      made = [];
    }
    if (error || !made.length) return c.redirect(back({ error: error ?? "nothing queued" }));
    const first = made[0];
    const text = made.length === 1
      ? `Request #${first.id} queued. The node picks it up within a minute and names the bot to /trade on ${first.server}.`
      : `${made.length} requests queued, one per node (#${made.map((m) => m.id).join(", #")}). Their bots meet you on ${first.server} one after another: each names the bot to /trade when it is its turn.`;
    return c.redirect(`/me?ok=${encodeURIComponent(text)}#request-${first.id}`);
  });
  // "N of this item" from a node that picks the copies (docs/relay/ADVANCED.md): one request to that node.
  app.post("/communism/take-count", async (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const { one } = fields(await c.req.parseBody({ all: true }));
    const pick = one("pick");
    const at = pick.indexOf("~");
    if (at <= 0) return c.redirect(back({ error: "pick an item" }));
    const r = createGuestRequest(db, user, pick.slice(0, at), { kind: "withdraw", seasonal: one("seasonal") === "1", server: one("server"), want: [{ itemId: pick.slice(at + 1), qty: Number(one("qty")) }], ign: one("ign") || undefined });
    if (!r.ok) return c.redirect(back({ error: r.error }));
    return c.redirect(`/me?ok=${encodeURIComponent(`Request #${r.request.id} queued. The node picks the copies, takes the request up within a minute and names the bot to /trade on ${r.request.server}.`)}#request-${r.request.id}`);
  });
  app.post("/communism/deposit", async (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const { one } = fields(await c.req.parseBody({ all: true }));
    const r = createGuestRequest(db, user, one("node"), { kind: "deposit", seasonal: one("seasonal") === "1", server: one("server"), count: Number(one("count")), ign: one("ign") || undefined });
    if (!r.ok) return c.redirect(back({ error: r.error }));
    return c.redirect(`/me?ok=${encodeURIComponent(`Request #${r.request.id} queued. The node picks it up within a minute and names the bot to /trade on ${r.request.server}.`)}#request-${r.request.id}`);
  });
}
