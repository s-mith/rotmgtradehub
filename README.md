# rotmgtradehub

The hub for [rotmgtrade](../rotmgtrade) nodes: user accounts, the node
registry, the version feed, ban telemetry, and the offer board (offers,
rendezvous, receipts). It runs no bots, holds no items (offers carry catalog
ids and the poster's own refs), never sees a game credential, and handles no
money. Every secret it
uses comes from the environment, which is why it can be open source: anyone
can check that the hub really holds nothing worth taking.

The protocol nodes speak is `docs/hub-protocol.md` in the node repo, and the
signing helpers are imported from there (`rotmgtrade/shared/hubWire`).

```
npm install
ADMIN_EMAILS=you@example.com npm run dev     # http://localhost:4000
npm test
```

Data: `./data/hub.db` (or `HUB_DB`). The admin page (`/admin`, for the
emails in `ADMIN_EMAILS`) publishes the version feed: minimum and latest node
version, download URL, and the Realm builds confirmed to work with the latest
node's codecs, and lists disputed rendezvous with the nodes they froze, which
the operator unfreezes from there. Registration, login and node linking are
rate-limited per IP.

Not here yet: commons, shared vaults (design doc section 6). Each comes as a
signed endpoint family.

## License

MIT.
