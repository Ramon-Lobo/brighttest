// Pure helpers for the Builds page: filter, sort, labels, error text per code, confirmation prefs.
// No DOM and no fetch here; the page and the unit tests share them.

export const STEP_LABELS = {
  lease: 'waiting for the device lease',
  probe: 'checking the device (port 80)',
  upload: 'uploading to the device',
  install: 'installing',
  'delete-retry': 'deleting and retrying',
  'verify-active': 'checking the channel started',
};

export const SORTS = [
  { id: 'newest', label: 'Newest' },
  { id: 'installed', label: 'Last installed' },
  { id: 'label', label: 'Label' },
  { id: 'size', label: 'Size' },
];

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

export const sourceKinds = (b) => [...new Set((b.sources || []).map((s) => (s.kind === 'cli-add' ? 'cli' : s.kind)))];

export function filterBuilds(builds, { q = '', kind = '', source = '', pinned = false, tag = '' } = {}) {
  const needle = String(q).trim().toLowerCase();
  return builds.filter((b) => {
    if (kind && b.kind !== kind) return false;
    if (source && !sourceKinds(b).includes(source)) return false;
    if (pinned && !b.pinned) return false;
    if (tag && !(b.tags || []).includes(tag)) return false;
    if (!needle) return true;
    const hay = [b.label, b.filename, b.notes, ...(b.tags || []), b.manifest && b.manifest.version, b.sha256 && b.sha256.slice(0, 12), b.id]
      .filter(Boolean).join('\n').toLowerCase();
    return hay.includes(needle) || (b.sha256 || '').startsWith(needle);
  });
}

export function sortBuilds(builds, by = 'newest') {
  const t = (s) => Date.parse(s) || 0;
  const cmp = {
    newest: (a, b) => t(b.createdAt) - t(a.createdAt),
    installed: (a, b) => t(b.lastInstall && b.lastInstall.at) - t(a.lastInstall && a.lastInstall.at),
    label: (a, b) => String(a.label || '').localeCompare(String(b.label || '')),
    size: (a, b) => (b.size || 0) - (a.size || 0),
  }[by] || (() => 0);
  return [...builds].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || cmp(a, b));
}

export const allTags = (builds) => [...new Set(builds.flatMap((b) => b.tags || []))].sort();

// Client-side checks before sending; the server stays the authority.
export function precheck(file, maxMB) {
  if (!/\.zip$/i.test(file.name || '')) return 'Not a .zip file.';
  if (maxMB && file.size > maxMB * 1024 * 1024) return `Over the ${maxMB} MB limit (builds.maxZipMB).`;
  return '';
}

export function uploadError(code, message, maxMB) {
  switch (code) {
    case 'BUILD_TOO_LARGE': return `Over the ${maxMB || 64} MB limit (builds.maxZipMB).`;
    case 'BUILD_INVALID_ZIP': return 'Not a readable zip file.';
    case 'BUILD_UNSAFE_ZIP': return `Refused: ${message || 'unsafe zip'}. Roku packages are plain zips with a manifest at the top.`;
    case 'BUILD_NO_MANIFEST': return "No manifest at the top of the zip; a Roku package needs one (zip the folder's contents, not the folder).";
    case 'STORE_LOCKED': return 'The store is busy; try again.';
    case 'STORE_WRITE_FAILED': return `Could not write the store: ${message || 'disk error'}.`;
    default: return message || 'Upload failed.';
  }
}

const HINTS = {
  UNREACHABLE: 'The device did not answer on port 80. Check it is on, on this network, and developer mode is enabled.',
  AUTH: 'The device rejected the dev password (HTTP 401). Reconnect from Devices with the right password.',
  INSTALL_FAILED: 'The installer refused the package. Check the manifest and that the zip is a valid channel.',
  NETWORK: 'The connection to the device broke mid-install. Retry; if it repeats, reboot the device.',
  NOT_ACTIVE: 'Installed, but the dev channel is not in front: it probably exited at launch. Check the console log.',
  CANCELLED: 'Cancelled.',
  LEASE_LOST: 'Studio lost the device lease mid-install; the device may still finish installing.',
};
const HEADLINES = {
  UNREACHABLE: 'Device unreachable', AUTH: 'Wrong dev password', INSTALL_FAILED: 'Install failed', NETWORK: 'Connection failed',
  NOT_ACTIVE: 'Installed, channel not running', CANCELLED: 'Install cancelled', LEASE_LOST: 'Lease lost',
};
export const failureText = (r) => ({
  headline: HEADLINES[r.code] || 'Install failed',
  cause: r.cause || '',
  message: r.message || '',
  hint: HINTS[r.code] || '',
});

export const TOKEN_WARNING = 'This build was made with a different hub token (or Studio has none): the State and Network panels will not connect to it. Rebuild with `instrument build --net` using Studio\'s token, or install anyway.';

export function installError(status, body) {
  const code = body && body.code;
  if (status === 423 || code === 'LOCKED') return { kind: 'locked', text: (body && body.error) || 'the device is in use', lease: body && body.lease };
  if (code === 'TOKEN_MISMATCH') return { kind: 'token', text: TOKEN_WARNING, tokenCheck: body.tokenCheck };
  const text = {
    RUN_IN_PROGRESS: 'A run is in progress; wait for it to finish.',
    INSTALL_IN_PROGRESS: 'Another install is already in progress.',
    SIMULATOR_TARGET: 'Install needs a device; Studio targets the simulator.',
    NO_DEVICE: 'No device connected.',
  }[code];
  return { kind: 'error', text: text || (body && body.error) || `install request failed (HTTP ${status})` };
}

// The device strip text from GET /api/builds/current (or its error).
export function currentLine(cur, { sim = false } = {}) {
  if (sim) return 'simulator: install needs a device';
  if (!cur || cur.error) return 'no device';
  const who = (cur.device && (cur.device.name || cur.device.model)) || cur.host;
  if (cur.match === 'none') return `On ${who}: no dev channel installed`;
  const app = cur.devApp ? `${cur.devApp.title || 'dev channel'}${cur.devApp.version ? ' ' + cur.devApp.version : ''}` : 'dev channel';
  if (cur.match === 'unknown') return `On ${who}: dev channel: unknown build (installed outside this store)`;
  const label = cur.build ? cur.build.label : app;
  const via = cur.installed ? `, installed ${ago(cur.installed.at)}${cur.installed.via ? ' from ' + (cur.installed.via === 'studio' ? 'Studio' : cur.installed.via) : ''}` : '';
  return `On ${who}: ${label}${cur.build ? ` (${cur.build.id.slice(0, 7)})` : ''}${cur.match === 'probable' ? ' (probably)' : ''}${via}`;
}

// "don't ask again" preference, one key per browser.
export const PREFS_KEY = 'bt.studio.builds';
export function loadPrefs(store) {
  try { const v = JSON.parse(store.getItem(PREFS_KEY)); if (v && v.v === 1) return { confirm: v.confirm !== false }; } catch { /* default */ }
  return { confirm: true };
}
export function savePrefs(store, prefs) {
  try { store.setItem(PREFS_KEY, JSON.stringify({ v: 1, confirm: prefs.confirm !== false })); } catch { /* storage off */ }
}

// Does the install need a confirmation dialog? Always when the token warning applies; otherwise unless opted out.
export const needsConfirm = (prefs, tokenWarn) => !!tokenWarn || prefs.confirm !== false;
