# Running the hub at rotmg.trade

The hub runs in Docker on one machine. A Cloudflare Tunnel carries its
traffic: `cloudflared` keeps an outbound connection open to Cloudflare, so the
machine needs no open ports or port forwarding and its address is never
public. Cloudflare holds the `rotmg.trade` DNS zone (the domain is registered at
Porkbun, with its nameservers pointing at Cloudflare) and serves HTTPS.

```
deploy/up.sh                 build the image and (re)start the hub and the tunnel
deploy/up.sh hub             rebuild and restart only the hub (a code change)
docker compose -f deploy/compose.yaml logs -f hub     (with HUB_HOME set, as up.sh sets it)
```

Both containers restart by themselves after a crash or a reboot
(`restart: unless-stopped`, and Docker starts at boot). The hub is also on
`http://127.0.0.1:4100` on the machine itself, for checking on it. Nothing else
on the network can reach it, which is why it may trust Cloudflare's
`CF-Connecting-IP` header for each visitor's address (`CLIENT_IP_HEADER`, set in
`compose.yaml`).

## What lives where

Code comes from the two repos, which sit side by side: the image is built from
this repo with the node repo as a second build context (`../rotmgtradenode`).
Everything else is in `HUB_HOME`, `~/rotmg-hub` unless set, outside both repos,
so nothing in a checkout can touch it:

| Path | What |
|---|---|
| `hub.env` | the hub's settings and secrets, mode 600: `BASE_URL=https://rotmg.trade`, `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` when Discord sign-in is on (README.md) |
| `data/hub.db` | the database |
| `data/backups/` | the hub's own copies of it: at start and every hour, two days of them, then one a day for thirty days |
| `cloudflared/cert.pem` | the login that may create tunnels and DNS routes on the zone; needed only for those commands |
| `cloudflared/<tunnel id>.json` | the tunnel's credentials; with them anyone can run this tunnel |
| `cloudflared/config.yml` | which hostname goes where: `rotmg.trade` to `http://hub:4000`, anything else 404 |

The sign-in apps must list `https://rotmg.trade/auth/google/callback` (Google
Cloud console, the OAuth client's authorized redirect URIs) and
`https://rotmg.trade/auth/discord/callback` (Discord developer portal, OAuth2 →
Redirects).

## Setting it up on a new machine

With Docker, the two repos side by side, and the domain on Cloudflare:

```sh
mkdir -p ~/rotmg-hub/data ~/rotmg-hub/cloudflared && chmod 700 ~/rotmg-hub ~/rotmg-hub/cloudflared
# ~/rotmg-hub/hub.env: the settings above (chmod 600)
CF="docker run --rm -u $(id -u):$(id -g) -e HOME=/home/cf -v $HOME/rotmg-hub/cloudflared:/home/cf/.cloudflared cloudflare/cloudflared:2026.9.3"
$CF tunnel login                          # open the link, pick rotmg.trade, Authorize
$CF tunnel create rotmg-hub               # writes cloudflared/<id>.json and prints the id
$CF tunnel route dns rotmg-hub rotmg.trade
# ~/rotmg-hub/cloudflared/config.yml:
#   tunnel: <id>
#   credentials-file: /etc/cloudflared/<id>.json
#   ingress:
#     - hostname: rotmg.trade
#       service: http://hub:4000
#     - service: http_status:404
deploy/up.sh
```

To move an existing hub, stop it (`docker compose -f deploy/compose.yaml down`),
copy `~/rotmg-hub` to the new machine, and run `deploy/up.sh` there. The tunnel
follows its credentials: whichever machine runs them serves `rotmg.trade`.

## Cloudflare settings that matter

- **Bot Fight Mode stays off** (Security → Settings). Nodes are not browsers, it
  would challenge them, and on the free plan it cannot be told to skip `/api`.
- Cloudflare closes a response after 125 s with no bytes from the hub. Node
  long polls end within 25 s, and the website's event streams send a comment
  every 25 s, so neither comes near it.

## Restoring a backup

```sh
docker compose -f deploy/compose.yaml stop hub     # with HUB_HOME set
cp ~/rotmg-hub/data/backups/hub-<when>.db ~/rotmg-hub/data/hub.db
rm -f ~/rotmg-hub/data/hub.db-wal ~/rotmg-hub/data/hub.db-shm
deploy/up.sh hub
```

The backups sit on the same disk as the database. To survive losing the disk,
copy `~/rotmg-hub/data/backups` somewhere else as well.
