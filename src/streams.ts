// Open event streams per person: a page that was navigated away from can
// keep its stream open for a while (the browser parks it), and a browser
// allows only a handful of connections to one host. Each stream registers
// here when it opens; past the cap, the oldest of that person's streams on
// that endpoint is closed to make room.
const MAX_PER_ENDPOINT = 2;
const open = new Map<string, (() => void)[]>();

/** Register an open stream; returns the function to call when it ends. `close` must end the stream from outside. */
export function holdStream(userId: number, endpoint: string, close: () => void): () => void {
  const key = `${userId}:${endpoint}`;
  let list = open.get(key);
  if (!list) open.set(key, (list = []));
  while (list.length >= MAX_PER_ENDPOINT) list.shift()!();
  list.push(close);
  return () => {
    const cur = open.get(key);
    if (!cur) return;
    const i = cur.indexOf(close);
    if (i >= 0) cur.splice(i, 1);
    if (!cur.length) open.delete(key);
  };
}

/** How many streams a person holds on an endpoint (tests). */
export function streamsHeld(userId: number, endpoint: string): number {
  return open.get(`${userId}:${endpoint}`)?.length ?? 0;
}
