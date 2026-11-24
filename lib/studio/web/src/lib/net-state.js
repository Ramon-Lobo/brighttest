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
  return !!row && row.bytes != null;
}
