// Pure helpers for the Network panel.

export const NO_HUB_TEXT = 'No instrument hub is running in this Studio session, so there is no network traffic to show.';

// The panel message for a 503 from /api/net/*: the server's own `error` (a bad instrument.net value, a missing
// hub token, a port in use), or the fixed no-hub text when the body has none.
export function noHubMessage(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  return typeof e === 'string' && e.trim() ? e : NO_HUB_TEXT;
}

// The selected row, looked up by id so it follows later updates (a pending row that completes).
export function selectedRow(rows, id) {
  if (id == null) return null;
  return rows.find((r) => r.id === id) || null;
}

// A row can be mocked or copied as a rule only once it has a completed exchange.
export function canMock(row) {
  return !!row && row.bytes != null && !isRefused(row);
}

// A request the hub refused because its host is not in the passthrough allow-list (net.error refused:true; the
// stored row has source "refused", status 403). Its own state in the panel, with an "allow this host" hint.
export function isRefused(row) {
  return !!row && (row.refused === true || row.source === 'refused');
}

// The host name to add to upstreamHosts (no port: a bare name allows any port).
export function refusedHost(row) {
  return String((row && row.host) || '').replace(/:\d+$/, '');
}

export function refusedHint(row) {
  const h = refusedHost(row);
  return `Refused by the passthrough allow-list. Add "${h}" to instrument.net.upstreamHosts in brighttest.json (or to the flow's config.net.upstreamHosts) to allow it.`;
}
