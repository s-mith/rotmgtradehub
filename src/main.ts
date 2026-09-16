import { serve } from "@hono/node-server";
import { openDb } from "./db";
import { createApp } from "./app";

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`[hub] listening on http://${info.address}:${info.port}${process.env.ADMIN_EMAILS ? "" : " (ADMIN_EMAILS unset: no admin)"}`);
});
process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
