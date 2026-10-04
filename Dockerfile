# syntax=docker/dockerfile:1
# The hub as one image. The node repo has to be beside it: the catalog, the
# sprites and the wire types come from there.
#
#   docker build --build-context rotmgtradenode=../rotmgtradenode -t rotmgtradehub .
#
# (deploy/compose.yaml passes the same context.) The database lives in /data:
# mount a volume there. Settings come from the environment (README.md).

FROM node:22-bookworm-slim AS build
# better-sqlite3 compiles its native part on install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Only what the hub uses from the node package: its manifest, the catalog and
# wire sources (bundled below), and the files read at run time.
COPY --from=rotmgtradenode package.json realm-enchants.json rotmgtradenode/
COPY --from=rotmgtradenode src/lib rotmgtradenode/src/lib
COPY --from=rotmgtradenode src/shared rotmgtradenode/src/shared
COPY --from=rotmgtradenode public rotmgtradenode/public
WORKDIR /app/rotmgtradehub
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY public public
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=4000
WORKDIR /app
COPY --from=build /app/rotmgtradenode/package.json /app/rotmgtradenode/realm-enchants.json rotmgtradenode/
COPY --from=build /app/rotmgtradenode/public rotmgtradenode/public
WORKDIR /app/rotmgtradehub
COPY --from=build /app/rotmgtradehub/package.json ./
COPY --from=build /app/rotmgtradehub/node_modules node_modules
COPY --from=build /app/rotmgtradehub/dist dist
COPY --from=build /app/rotmgtradehub/public public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/v1/version').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
