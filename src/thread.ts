// R51: what counts as a thread. The engine accepts one form, `<channel>:<ts>`, and normalizes the two other forms a session may copy.

const CHANNEL = '[A-Z][A-Z0-9]{8,12}';
const CANON = new RegExp(`^(${CHANNEL}):(\\d+\\.\\d+)$`);
const WITH_PREFIX = new RegExp(`^slack:(${CHANNEL}):(\\d+\\.\\d+)$`);
const PERMALINK = new RegExp(`^https?://[^/\\s]+/archives/(${CHANNEL})/p(\\d{10})(\\d{6})(?:[?#].*)?$`);

/** The canonical `<channel>:<ts>` for a thread, a `slack:`-prefixed ref, or a permalink (a reply permalink's thread_ts wins); null when the text is none of these. */
export function normalizeThread(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const c = CANON.exec(s) ?? WITH_PREFIX.exec(s);
  if (c) return `${c[1]}:${c[2]}`;
  const p = PERMALINK.exec(s);
  if (!p) return null;
  const q = /[?&]thread_ts=(\d+\.\d+)/.exec(s);
  return `${p[1]}:${q ? q[1] : `${p[2]}.${p[3]}`}`;
}

/** The channel and ts of a message link (`slack:<C>:<ts>`, `<C>:<ts>` or a permalink); the ts is the message's own, not the thread's. */
export function parseMessageLink(input: unknown): { channel: string; ts: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const c = CANON.exec(s) ?? WITH_PREFIX.exec(s);
  if (c) return { channel: c[1], ts: c[2] };
  const p = PERMALINK.exec(s);
  return p ? { channel: p[1], ts: `${p[2]}.${p[3]}` } : null;
}

export const THREAD_HELP =
  'A thread is written <channel>:<ts>, for example C0C4K4EGZT6:1791149910.562169. For a Slack mention, copy it from the request comment\'s external_ref (slack:<channel>:<ts>, drop the "slack:") or from the thread link; a DevRev DM id is not a thread.';
