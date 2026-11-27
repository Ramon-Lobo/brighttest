// Parse the text typed into a State edit field (pure, unit tested).
// A string field takes the text as typed, except a value wrapped in matching double quotes that parses as a JSON
// string ("abc"), which is stored unwrapped so typing the quotes seen in the tree does not store them.
export function parseValue(text, type) {
  if (type === 'string') {
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      try { const v = JSON.parse(text); if (typeof v === 'string') return { ok: true, value: v }; } catch { /* keep raw */ }
    }
    return { ok: true, value: text };
  }
  if (type === 'number') { const n = Number(text); return text.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, why: 'enter a number' }; }
  if (type === 'boolean') return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, why: 'enter true or false' };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: true, value: text }; }
}

export const stringHint = 'text as typed; quotes around the whole value are removed';
