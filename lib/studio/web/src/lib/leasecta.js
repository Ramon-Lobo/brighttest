// "Take the device back" call to action: the label, the queued text and the one click handler, shared by the banner,
// the header control and the held notices in the State, Action log and Node state tiles. It queues Studio like any
// other waiter (POST /api/lease acquire) and never preempts the holder.

// Studio had the device and lost it: "back". Never held it in this session: plain "Take the device".
export const ctaLabel = (everHeld) => (everHeld ? 'Take the device back' : 'Take the device');

// "Waiting, you are #2": Studio queued behind the others already waiting (its own entry is the last one queued).
export function queuedText(info) {
  const n = info && info.queue ? info.queue.length : 0;
  return n > 0 ? `Waiting, you are #${n}` : 'Waiting for the device';
}

// "2m 05s" / "45s" / "1h 03m" from a millisecond span; never negative.
export function formatAge(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// The banner sentence: who holds the device and for how long. A pool answer carries its own text.
export function heldText(l, now = Date.now()) {
  if (l && l.lease && l.lease.text && l.lease.pool) return l.lease.text;
  const h = l && l.lease && l.lease.holder;
  if (h && !h.mine) {
    const t = typeof h.since === 'number' ? h.since : Date.parse(h.since); // the server sends an ISO time
    const age = Number.isFinite(t) ? `, held for ${formatAge(now - t)}` : '';
    const why = h.purpose ? ` (${h.purpose})` : '';
    return `${h.agent} has the device${why}${age}`;
  }
  return (l && l.error) || 'Studio released the device';
}
