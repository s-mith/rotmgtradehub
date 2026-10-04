// The activity feed: what happened to this person's nodes, offers, meetings
// and requests, newest first, kept live by hub.js over the event stream.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { holdStream } from "../streams";
import { bus, listEventsFor, type EventView } from "../events";
import { Layout, When } from "./layout";
import type { Site } from "./context";

export const ActivityList: FC<{ events: EventView[] }> = ({ events }) => (
  <ul class="activity">
    {events.map((e) => (
      <li class={e.tone}>
        <span class="dot" />
        <span>{e.href ? <a href={e.href}>{e.text}</a> : e.text}</span>
        <When at={e.at} />
      </li>
    ))}
  </ul>
);

const PAGE = 100;

export function registerActivity(app: Hono, site: Site): void {
  app.get("/activity", (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    // A page of a hundred at a time: the newest, or the ones before an event already seen.
    const before = Number(c.req.query("before"));
    const paged = Number.isInteger(before) && before > 0;
    const events = listEventsFor(site.db, user.id, PAGE + 1, paged ? before : undefined);
    const more = events.length > PAGE;
    const shown = events.slice(0, PAGE);
    const pager = (paged || more) && (
      <p class="pager">
        {paged && <a href="/activity">Newest</a>}
        {more && <a href={`/activity?before=${shown[shown.length - 1].id}`}>Older</a>}
      </p>
    );
    return c.html(
      <Layout title="activity" frame={site.frame(user, "activity")}>
        <h1>Activity</h1>
        <p class="muted">Everything rotmg trade saw happen around your nodes, offers and requests. {paged ? "These are older events." : "This page updates by itself."}</p>
        {paged ? (shown.length ? <ActivityList events={shown} /> : <p class="muted">Nothing older.</p>) : <div data-live="/activity/stream">{shown.length ? <ActivityList events={shown} /> : <p class="muted">Nothing yet.</p>}</div>}
        {pager}
      </Layout>,
    );
  });
  // One message per event for this person; hub.js re-fetches the page region on each. A comment every 25 s keeps proxies from closing it.
  app.get("/activity/stream", (c) => {
    const user = site.me(c);
    if (!user) return c.text("sign in", 401);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (id: number) => { void stream.writeSSE({ event: "message", data: String(id), id: String(id) }); };
      const off = bus.subscribe(user.id, send);
      const end = () => { open = false; off(); };
      const release = holdStream(user.id, "activity", () => { end(); void stream.close(); });
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
}
