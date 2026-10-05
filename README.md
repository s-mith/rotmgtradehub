# rotmgtradehub

The hub for [rotmgtradenode](https://github.com/s-mith/rotmgtradenode) nodes (live at [rotmg.trade](https://rotmg.trade)): user accounts, the node
registry, the version feed, ban telemetry, and the offers nodes trade
through (offers, rendezvous, receipts; nodes post and take them, the website
has no offer board, only a page per offer whose link its owner shares, where
people take it in game or with a node of theirs). A node may put one item in several offers: while a
meeting has it the others are held, and once it is traded away they are
withdrawn. It runs no bots, holds no items (offers carry catalog ids and the
poster's own refs), never sees a game credential, and handles no money. Every secret it
uses comes from the environment, which is why it can be open source: anyone
can check that the hub really holds nothing worth taking.

The protocol nodes speak is `docs/hub-protocol.md` in the node repo, and the
signing helpers are imported from there (`rotmgtradenode/shared/hubWire`).

```
npm install
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ADMIN_EMAILS=you@example.com npm run dev   # http://localhost:4000
npm test
npm run build && npm start   # production: one bundled file (dist/main.js) on plain node
```

The settings can also go in a `.env` file in the working directory. The
running hub at [rotmg.trade](https://rotmg.trade) is the Docker image (`Dockerfile`) behind a
Cloudflare Tunnel; `deploy/README.md` says how it is set up and kept.

People sign in with Google; the first sign-in creates the account, and the hub
keeps the email address, a display name and Google's subject id. To get the
two values above, make an OAuth client in the Google Cloud console
(APIs & Services → Credentials → OAuth client ID, type "Web application")
and register `<BASE_URL>/auth/google/callback` as an authorized redirect
URI, `http://localhost:4000/auth/google/callback` for a dev hub. Set
`BASE_URL` to the origin people use (`https://hub.example`) when the hub
sits behind a reverse proxy; without it the hub trusts `X-Forwarded-Proto`
and `X-Forwarded-Host`. Behind a proxy, also set `TRUST_PROXY` to the number
of proxies in front of the hub (usually 1) so the per-address limits see
each visitor's address; without it they use the connection's own address and
ignore `X-Forwarded-For`, which a visitor could otherwise make up. A proxy
that writes the visitor's address into a header of its own and overwrites it
when a visitor sends it can be named instead with `CLIENT_IP_HEADER`
(`cf-connecting-ip` behind Cloudflare, `fly-client-ip` on Fly.io); that is
only safe when nothing reaches the hub except through that proxy. A session
lasts 30 days from the last visit. There are no passwords: accounts exist only through
Google or Discord sign-in (`createUser()` in `src/auth.ts` makes an empty
account for tests and scripts, which the first sign-in with that email
attaches to).

Discord sign-in sits beside Google when `DISCORD_CLIENT_ID` and
`DISCORD_CLIENT_SECRET` are set: make an application in the Discord developer
portal, add `<BASE_URL>/auth/discord/callback` under OAuth2 → Redirects, and
copy the client id and secret. The hub asks for the `identify` and `email`
scopes, keeps the account's Discord id, its verified email and a name, and
attaches the sign-in to an existing account with the same email. Either
provider may be configured alone.

A node joins an account with a **link code** from "my nodes → link a node"
(eight characters, fifteen minutes, one use; up to three live at once),
pasted into the node's console; no hub password ever reaches a node. An
account may link 20 nodes; the operator can give one person more, or no
limit, on the admin page. A node is named when it links, and its owner can
rename it on "my nodes" (1-40 characters); every page shows the new name.

## Communism

Every node sets aside whole accounts for communism; their trade slots are
communism's capacity and whatever they hold is free for anyone to take. The
hub keeps what each node publishes (accounts with free slots per pool half,
items with the node's own refs) and shows one federated board. Anyone signed
in, with a character under settings, can deposit into or withdraw from any
online node's communism: they queue a request, the node picks it up within a
minute, names the communism bot to `/trade`, and meets them in game. A
withdraw may pick items from up to eight nodes: one request per node, handed
out one after another, since a character trades with one bot at a time. Node
to node, an owner can take a listed item onto their own bot, a one-way meeting
closed by receipts, like a swap. No points and no prices.

An account can have several characters. Without a login node, typed names
count; with one, only characters proven by whispering a code in game, each
proven on one account at a time (whoever whispered last), and every proven
character signs in to its account. Forms use the main character unless you
pick another.

Offers (posted, browsed and accepted on the nodes): every node may have 30
open at once; either side of an offer holds up to the node's biggest trade
inventory (8, or 16 or 24 with a backpack and extender, as the node reports
it); a node may have as many offers taken at once as it can have bots online;
a meeting gets six minutes, sixteen at most with extensions. Offers of offline
nodes are left off the board, and a node can renew an offer for another
fourteen days.

## The website

Server-rendered pages (`src/site/*.tsx`, one stylesheet and one small script
under `public/`, asked for by a hash of their contents so a page never gets a
stale cached copy), phone first. Every page has the same frame, laid out like
the node's control panel: the name over a row of section tabs (My nodes,
Communism, Activity, and Admin for operators).

- `/` says what this is, shows live numbers (nodes online, items in the
  communism, swaps done, the current Realm build) and the download link.
- `/me` is the dashboard: a table of nodes, one row each (bots online,
  proxies, swaps) with whatever needs its owner (frozen, too old or behind
  the feed, suspended accounts, logins held, no proxies); the first-run
  checklist until a node is linked; the link code
  (the page notices the node arriving); meetings under way; requests (every
  one still open and the last twenty finished: what you asked nodes to do,
  their latest word, and the bot to `/trade`; the list updates itself); and
  settings: your characters, display name and a Discord webhook for
  notifications.
- Offers are posted, browsed and accepted on the nodes (Trading), not here.
  Crosses (an offer that mirrors yours) arrive as activity and Discord
  messages.
- `/communism` is the federated communism: every online node's items on one
  board, one pool half at a time, with the node pool page's filters and sorts
  (tag search over items / enchantments / effects, sort by feed power,
  quantity, enchant slots or a stat, the forge material, feed power and
  enchant slot sliders, collapse by rarity, the class / slot / consumable
  rail; the facts come from the node package's item data). The board keeps
  itself current: a stream says when the hub's revision moved and the page
  fetches only the tiles that changed (`/communism/stream`, `/communism/delta`);
  a Deposit panel
  (pick a node with room, how many items, a server); "take the picked items"
  as yourself (a withdraw request) or with one of your nodes (a communism
  take). Each queues a request the node runs within a minute
  (docs/hub-protocol.md, "Requests").
- `/activity` is everything that happened around your nodes, kept live over
  a server-sent event stream, a hundred at a time with older pages behind.
- `/admin` for the emails in `ADMIN_EMAILS`.

The catalog (names, categories, sprite sheet, enchantment names, servers)
comes from the node package (`rotmgtradenode/catalog` and friends) and is
served at `/catalog.json` and `/sprites/…`. `npm run preview` starts a
throwaway hub on port 4001 with made-up nodes, offers, communism accounts and
items and a few requests, and `/preview/as/boss@x.test` signs you in without
a password, for looking at the pages.

Data: `./data/hub.db` (or `HUB_DB`; `DATA_DIR` moves the folder). The hub
copies the database at start and every hour (`BACKUP_EVERY_MINUTES`, 0 for
none) into `<DATA_DIR>/backups` (or `BACKUP_DIR`) and keeps two days of
copies, then one a day for thirty days (`src/backup.ts`). The admin page (`/admin`, for the
emails in `ADMIN_EMAILS`) publishes the version feed: minimum and latest node
version, download URL, and the Realm builds confirmed to work with the latest
node's codecs, lists disputed meetings (the two sides contradicted each
other; that freezes nobody) with a count per node, freezes or unfreezes a
node (a frozen node posts and accepts nothing and its offers are hidden), and
under People lifts a limit for one person: how many nodes they may link and
how many trades in game they may start an hour. Sign-in callbacks, node
linking and new Realm sign-in codes are rate-limited per address.

The latest node version and the download follow the node repo's newest
published GitHub release by themselves (`NODE_RELEASES_REPO`, default
`s-mith/rotmgtradenode`, empty for none; checked at start and every
`RELEASE_CHECK_MINUTES`, 10; `src/releases.ts`), so publishing a release is
the only step; the admin page shows what was found and checks again on
demand. `/download` is the link to share: it sends a visitor to the newest
installer for their system (`/download/windows`, `/download/linux`), or to the
admin page's download URL while no release is found, and the site's download
links all point at it. The admin page's latest version and download URL count
only while no release is found.

The request queue (`/api/v1/guest-requests`) and communism
(`/api/v1/communism/*`: publish accounts and items, the federated board,
node-to-node take and give) are further signed endpoint families. A database
from the shared-vault days (grants, guest vaults, invites) has those tables
dropped on open.

## License

MIT.
