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
