// Winding down what an unlinked node had going (src/nodes.ts unlinkNode). Its
// row stays; this closes, on its side, everything that would otherwise wait
// for a node that will never answer again.
import type { Db } from "./db";
import { getSettings, setSettings } from "./db";
import { recordChange, stackKey } from "./communismLive";
import { giveUpMeetingsOf } from "./offers";
import { failRequestsFor } from "./requests";
import type { NodeRow } from "./nodes";

const WHY = "its node was unlinked";

export function windDown(db: Db, node: Pick<NodeRow, "id">, now: number): void {
  db.prepare("UPDATE offers SET status = 'cancelled', closed_reason = ?, updated_at = ?, closed_at = ? WHERE node_id = ? AND status = 'open'").run(WHY, now, now, node.id);
  giveUpMeetingsOf(db, node.id, WHY, now);
  failRequestsFor(db, node.id, WHY, now);
  const items = db.prepare("SELECT node_id, bot_ign, item_id, enchants_json, seasonal FROM communism_items WHERE node_id = ?").all(node.id) as { node_id: string; bot_ign: string; item_id: string; enchants_json: string; seasonal: number }[];
  db.prepare("DELETE FROM communism_items WHERE node_id = ?").run(node.id);
  db.prepare("DELETE FROM communism_accounts WHERE node_id = ?").run(node.id);
  if (items.length) recordChange(items.map((it) => ({ key: stackKey(it), seasonal: !!it.seasonal })));
  if (getSettings(db).loginNodeId === node.id) setSettings(db, { loginNodeId: "" });
  db.prepare("UPDATE realm_logins SET state = 'failed', error = 'the login node was unlinked' WHERE node_id = ? AND state IN ('taken', 'ready')").run(node.id);
}
