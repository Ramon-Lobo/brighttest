// Pure helpers for the action log panel (STA23-F2). The panel only calls the existing /api/state/actions routes.
export const shortHash = (h) => (h === null || h === undefined || h === '' ? '-' : String(h).slice(0, 8));

// Turn a travel response (status + body, as api.stateActionTravel returns it) into the message the panel shows.
export function travelOutcome(r) {
  if (r && r.status === 202) return { bad: false, text: `${r.note || 'travel queued'}` };
  if (r && r.status === 404) return { bad: true, text: `Not found: ${r.error || 'no such action log entry'}` };
  const code = r && (r.code || r.status);
  return { bad: true, text: `${code || 'error'}: ${(r && r.error) || 'request failed'}` };
}

// A row for one log entry: what the table shows. `travelable` is false when no snapshot was recorded on it.
export function rowOf(a) {
  return { entry: a.entry, type: a.type === null || a.type === undefined ? '(unnamed)' : String(a.type), before: shortHash(a.hashBefore), after: shortHash(a.hashAfter),
    changed: a.changed, snapshot: a.snapshot || null };
}

// Chained poller: the next fetch is scheduled only after the previous one settles, so requests never overlap.
// now() while one is in flight queues exactly one follow-up. A reply is applied only if no newer fetch started since.
export function createPoller(fetchFn, apply, { delay = 2000, setT = setTimeout, clearT = clearTimeout } = {}) {
  let timer = null, stopped = true, inflight = false, again = false, seq = 0;
  async function run() {
    timer = null;
    if (stopped) return;
    if (inflight) { again = true; return; }
    inflight = true;
    const mine = ++seq;
    let res, failed = false;
    try { res = await fetchFn(); } catch (e) { failed = true; res = e; }
    inflight = false;
    if (stopped) return;
    if (mine === seq) apply(res, failed);
    if (again) { again = false; run(); } else timer = setT(run, delay);
  }
  return {
    start() { stopped = false; run(); },
    now() { if (stopped) return; if (timer !== null) { clearT(timer); timer = null; } run(); },
    stop() { stopped = true; if (timer !== null) clearT(timer); timer = null; },
  };
}
