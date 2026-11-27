// Pure helpers for the Settings page (STUDIO-SET-T1): wording only, no fetches and no writes.
const SOURCE_TEXT = {
  flag: 'the --host flag', env: 'the ROKU_HOST environment variable', dotenv: 'the project .env file', cache: 'the cached device list',
  connect: 'the Devices page (this session only)', simulator: 'the simulator (--simulator)', pool: 'the device pool (deviceLease.pool)', none: 'nowhere: no device is set', unknown: 'an unknown source',
};
export const sourceLabel = (s) => SOURCE_TEXT[s] || SOURCE_TEXT.unknown;

const PW_TEXT = { flag: 'the --password flag', env: 'ROKU_PASSWORD in the environment', dotenv: 'ROKU_PASSWORD in the project .env', cache: 'the cached device list', connect: 'typed on the Devices page' };
export function passwordText(p) {
  if (!p) return '';
  if (p.source === 'n/a') return 'not used by the simulator';
  return p.known ? `known (from ${PW_TEXT[p.source] || p.source})` : 'not known: pass --password or set ROKU_PASSWORD';
}

export const tokenText = (t) => (t === 'set' ? 'set' : t === 'malformed' ? 'set but malformed (needs 32 lowercase hex characters)' : 'not set');

// A lease value with its source, e.g. "30m (default)".
export const leaseText = (v) => (v && v.value !== undefined ? `${v.value}${v.ms ? ` (${v.ms} ms)` : ''} (${v.source})` : '');

// Studio's own localStorage keys (this feature set only): bt.studio.*
export const PREF_PREFIX = 'bt.studio.';
export const prefKeys = (storage) => { const out = []; try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREF_PREFIX)) out.push(k); } } catch { /* storage unavailable */ } return out.sort(); };
// Remove only bt.studio.* keys, and only after confirm() says yes. Returns the removed keys ([] when cancelled).
export function resetPrefs(storage, confirmFn) {
  const keys = prefKeys(storage);
  if (!keys.length || !confirmFn(`Remove ${keys.length} saved Studio preference${keys.length === 1 ? '' : 's'} (${keys.join(', ')}) from this browser?`)) return [];
  for (const k of keys) { try { storage.removeItem(k); } catch { /* storage unavailable */ } }
  return keys;
}
export const engineText = (e) => (e && e.name ? `${e.name}@${e.version} (${e.flavor})` : 'not found');

// One block of text for a bug report: no password, no token, nothing from the device.
export function aboutText(s) {
  if (!s) return '';
  return [`brighttest ${s.about.version}`, `node ${s.about.node}`, ...s.about.engines.map((e) => `${e.kind}: ${engineText(e)}`), `target: ${s.project.target}`, `hub: ${s.hub.up ? 'up' : `down (${s.hub.reason})`}`].join('\n');
}
