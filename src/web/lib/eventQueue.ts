// SPEC §6 — client event queue. An array mirrored to localStorage, a 2 s flush,
// retry with backoff, and a sendBeacon flush when the page is hidden.
import type { EventItem } from '@shared/api';

export interface TrackContext {
  sessionId: string;
  /** Names from the pinned, materialised config's `events.allowed`. */
  allowed: readonly string[];
}

interface Pending {
  event: EventItem;
  attempts: number;
  nextAttemptAt: number;
}

const STORAGE_KEY = 'funnel.events.v1';
const ENDPOINT = '/api/events';
const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH = 50;
const MAX_ATTEMPTS = 5;

let queue: Pending[] = load();
let flushing = false;
let started = false;

function load(): Pending[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return (parsed as Partial<Pending>[])
      .filter((p) => typeof p?.event?.event_id === 'string' && typeof p.event.session_id === 'string' && typeof p.event.name === 'string')
      .map((p) => ({
        event: p.event as EventItem,
        attempts: Number.isFinite(p.attempts) ? (p.attempts as number) : 0,
        nextAttemptAt: Number.isFinite(p.nextAttemptAt) ? (p.nextAttemptAt as number) : 0,
      }));
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    if (queue.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota): the in-memory queue still works.
  }
}

/** crypto.randomUUID needs a secure context; fall back to getRandomValues (e.g. LAN testing over http). */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon();
  });
}

/** Enqueue one event. Names not allowed by the pinned config are dropped here, so trigger points stay inert. */
export function track(ctx: TrackContext, name: string, stepId: string | null, props: Record<string, unknown> = {}): void {
  if (!ctx.allowed.includes(name)) return;
  queue.push({
    // event_id is fixed at enqueue time and reused on every retry — that is what makes server dedup work.
    event: { event_id: uuid(), session_id: ctx.sessionId, name, step_id: stepId, client_ts: new Date().toISOString(), props },
    attempts: 0,
    nextAttemptAt: 0,
  });
  persist();
  start();
}

export async function flush(): Promise<void> {
  if (flushing) return;
  const batch = queue.filter((p) => p.nextAttemptAt <= Date.now()).slice(0, MAX_BATCH);
  if (batch.length === 0) return;
  flushing = true;
  try {
    let status = 0;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch.map((p) => p.event) }),
      });
      status = response.status;
    } catch {
      // Network failure: status stays 0 and the batch is retried.
    }
    if (status === 200 || status === 400) {
      // 200: every item has a final outcome (accepted, duplicate or rejected). 400: the batch itself is invalid.
      const sent = new Set(batch);
      queue = queue.filter((p) => !sent.has(p));
    } else {
      // Network failure, 5xx, and transient 4xx (408, 413, 429, a proxy 404 mid-deploy): back off and retry.
      for (const p of batch) {
        p.attempts += 1;
        p.nextAttemptAt = Date.now() + 1000 * 2 ** p.attempts;
      }
      queue = queue.filter((p) => p.attempts < MAX_ATTEMPTS);
    }
    persist();
  } finally {
    flushing = false;
  }
}

/** Best-effort delivery while the page is being hidden. Items stay queued; a resend is deduplicated by the server. */
function beacon(): void {
  if (queue.length === 0) return;
  const events = queue.slice(0, MAX_BATCH).map((p) => p.event);
  try {
    const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, blob)) return;
  } catch {
    // Fall through to a keepalive fetch.
  }
  void flush();
}

// Events persisted by a previous page load resume flushing immediately.
if (queue.length > 0) start();
