// Account settings, shown at the bottom of /me: the characters you play,
// where notifications go, and your display name. The forms post to /me and
// land back on #settings with what happened.
import type { FC } from "hono/jsx";
import type { Hono } from "hono";
import { addTypedCharacter, charactersOf, loginNodeId, removeCharacter, setDisplayName, setIgn, setMainIgn, type Character, type User } from "../auth";
import type { Db } from "../db";
import { loginNodeState } from "../realmLogin";
import { sendDiscordWebhook, setWebhook, webhookFor } from "../events";
import { Badge, Flash } from "./layout";
import type { Site } from "./context";

/** The person's characters, and whether this site proves them: no login node (typed names count), or its login node online or not. */
type CharactersView = { characters: Character[]; realm: "off" | "online" | "offline" };
export type SettingsView = { chars: CharactersView; webhook: string | null };

export function settingsView(db: Db, userId: number): SettingsView {
  const ln = loginNodeState(db);
  return { chars: { characters: charactersOf(db, userId), realm: !ln.node ? "off" : ln.online ? "online" : "offline" }, webhook: webhookFor(db, userId) };
}

/** Where a settings form lands: /me, scrolled to the settings, saying what happened. */
export const settingsDone = (msg: { ok?: string; error?: string }): string =>
  `/me?${msg.error ? `settings_error=${encodeURIComponent(msg.error)}` : `settings_ok=${encodeURIComponent(msg.ok ?? "")}`}#settings`;

export const Settings: FC<{ user: User; view: SettingsView; error?: string; ok?: string }> = ({ user, view: { chars: { characters, realm }, webhook }, error, ok }) => (
  <section id="settings">
    <h2>Settings</h2>
    <Flash error={error} ok={ok} />
    <div class="panel settings">
      <div class="setting">
        <span class="label">Characters</span>
        <div class="more chars">
          {characters.length === 0 && <span class="muted">none yet</span>}
          {characters.map((ch) => (
            <form method="post" action="/me" class="char">
              <input type="hidden" name="ign" value={ch.ign} />
              <code>{ch.ign}</code>
              {realm !== "off" && (ch.provenAt !== null ? <Badge tone="good">proven</Badge> : <Badge tone="warn">not proven</Badge>)}
              {ch.main ? <Badge tone="accent">main</Badge> : <button type="submit" name="do" value="ign-main" class="quiet small">make main</button>}
              <button type="submit" name="do" value="ign-remove" class="quiet small">remove</button>
            </form>
          ))}
        </div>
        {realm === "off" ? (
          <form method="post" action="/me" class="more control">
            <input id="set-ign" name="ign" placeholder="YourName" pattern="[A-Za-z]{1,32}" maxlength={32} required aria-label="Add a character" />
            <button type="submit" name="do" value="ign">Add</button>
          </form>
        ) : realm === "online" ? (
          <div class="more control"><a class="button small" href="/auth/realm">{characters.some((c) => c.provenAt !== null) ? "Prove another character" : "Prove my character"}</a></div>
        ) : null}
        <p class="hint">
          {realm === "off" ? "The characters bots trade with, exactly as Realm shows them." : realm === "online" ? "Proven by whispering a code in game; each proven character can sign in to this account too." : "The login bot is offline; proving has to wait."}
          {" "}Deposits and withdraws use the main one unless you pick another.
        </p>
      </div>
      <form method="post" action="/me" class="setting">
        <label for="set-name">Display name</label>
        <div class="control">
          <input id="set-name" name="name" value={user.displayName} pattern="[A-Za-z0-9 _\-]{2,24}" minlength={2} maxlength={24} required />
          <button type="submit" name="do" value="name">Save</button>
        </div>
        <p class="hint">What others see. Not your real name{user.email ? <>; your email ({user.email}) is never shown</> : null}.</p>
      </form>
      <form method="post" action="/me" class="setting">
        <label for="set-webhook">Discord</label>
        <div class="control">
          <input id="set-webhook" name="webhook" type="url" value={webhook ?? ""} placeholder="webhook URL" />
          <button type="submit" name="do" value="save">Save</button>
          <button type="submit" name="do" value="test" class="quiet" disabled={!webhook}>Test</button>
        </div>
        <p class="hint">A webhook that pings you when something needs you (Server settings → Integrations → Webhooks).</p>
      </form>
    </div>
  </section>
);

export function registerSettings(app: Hono, site: Site): void {
  const { db } = site;
  const done = (c: import("hono").Context, msg: { ok?: string; error?: string }) => c.redirect(settingsDone(msg));
  // The old page's address, for links and bookmarks: its messages come along.
  app.get("/me/settings", (c) => {
    const ok = c.req.query("ok");
    const error = c.req.query("error");
    return c.redirect(ok || error ? settingsDone({ ok, error }) : "/me#settings");
  });
  app.post("/me", async (c) => {
    const user = site.me(c);
    if (!user) return c.redirect("/");
    const f = await c.req.parseBody();
    const action = String(f.do ?? "save");
    if (action === "name") {
      const r = setDisplayName(db, user.id, String(f.name ?? ""));
      return done(c, r.ok ? { ok: `You go by ${r.name} now.` } : { error: r.error });
    }
    if (action === "ign") {
      // With a login node on this hub a typed name counts for nothing: it is proven or not at all.
      if (loginNodeId(db)) return done(c, { error: "This site proves characters: use the prove button instead of typing the name." });
      const typed = String(f.ign ?? "").trim();
      if (!typed) return done(c, { error: "Type the character's name, exactly as Realm shows it." });
      const r = addTypedCharacter(db, user.id, typed);
      return done(c, r.ok ? { ok: `Added ${typed}. Bots will trade with that name.` } : { error: r.error });
    }
    const named = String(f.ign ?? "").trim();
    if (action === "ign-main") return done(c, setMainIgn(db, user.id, named) ? { ok: `${named} is your main character now.` } : { error: "That is not one of your characters." });
    if (action === "ign-remove") return done(c, removeCharacter(db, user.id, named) ? { ok: `${named} removed.` } : { error: "That is not one of your characters." });
    if (action === "ign-clear") {
      setIgn(db, user.id, null);
      return done(c, { ok: "IGN forgotten." });
    }
    if (action === "test") {
      const sent = await sendDiscordWebhook(db, user.id, { id: 0, kind: "test", tone: "muted", text: `Hello from rotmg trade, ${user.displayName}. Notifications work.`, href: "/me", at: Date.now() });
      return done(c, sent ? { ok: "Sent. Check Discord." } : { error: "Discord did not take it. Is the webhook still there?" });
    }
    const url = String(f.webhook ?? "").trim();
    const r = setWebhook(db, user.id, url || null);
    return done(c, r.ok ? { ok: url ? "Saved. Send a test to be sure." : "Notifications are off." } : { error: r.error });
  });
}
