// Thin wrappers over the studio JSON API (proxied to the studio server in dev, same-origin in prod).
const json = (url, opts) => fetch(url, opts).then((r) => r.json());
const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Like json(), but keeps the HTTP status so panels can tell locked (423) and no-hub (503) from an error.
const fetchState = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, ok: r.ok, ...(await r.json().catch(() => ({}))) }));

export const api = {
  device: () => json('/api/device'),
  discover: () => json('/api/discover'),
  cachedDevices: () => json('/api/cached'),
  connect: (host, password) => post('/api/connect', { host, password }),
  tree: () => json('/api/tree'),
  screenshotUrl: () => '/api/screenshot?t=' + Date.now(),
  keypress: (key, count = 1) => post('/api/keypress', { key, count }),
  launch: (app) => post('/api/launch', { app }),
  steps: () => json('/api/steps'),
  flows: () => json('/api/flows'),
  readFlow: (rel) => json('/api/flow?file=' + encodeURIComponent(rel)),
  saveFlow: (file, text) => post('/api/flow', { file, text }),
  runUrl: (rel) => '/api/run?file=' + encodeURIComponent(rel),
  stopRun: (runId) => post('/api/run/stop', { runId }),
  runs: () => json('/api/runs'),
  runDetail: (id) => json('/api/runs/' + id),
  traceFrame: (runId, step) => `/api/trace/frame?run=${runId}&step=${step}`,
  // profiling
  perfStart: (intervalMs) => post('/api/perf/start', { intervalMs }),
  perfStop: () => post('/api/perf/stop', {}),
  perfMarker: (label) => post('/api/perf/marker', { label }),
  perfSession: (since = 0) => json('/api/perf/session?since=' + since),
  perfBsprofImport: (arrayBuffer) =>
    json('/api/perf/bsprof', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arrayBuffer }),
  perfBsprofPull: () => json('/api/perf/bsprof-pull'),
  perfTextures: () => json('/api/perf/textures'),
  perfConsole: (command) => post('/api/perf/console', { command }),
  perfettoStatus: () => json('/api/perf/perfetto/status'),
  perfettoAction: (action) => post('/api/perf/perfetto/' + action, {}),
  // network panel (NET-N-T10)
  netRequests: (raw = false) => json('/api/net/requests' + (raw ? '?raw=1' : '')),
  netMockThis: (id) => json('/api/net/mock-this?id=' + encodeURIComponent(id)),
  netHarUrl: () => '/api/net/har',
  netRules: () => json('/api/net/rules'),
  netRuleAdd: (rule) => post('/api/net/rules', rule),
  netRulesClear: () => json('/api/net/rules', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }),
  btStreamUrl: (after = 0) => '/api/bt/stream?after=' + after,
  // state inspector (STA-S-T8)
  state: (raw = false) => fetchState('/api/state' + (raw ? '?raw=1' : '')),
  // one node's fields or a component's m through the agent (STUDIO-NS-T1 route)
  stateNode: ({ id, layer, path, depth, raw = false }) => fetchState('/api/state/node?id=' + encodeURIComponent(id) + '&layer=' + layer + (path ? '&path=' + encodeURIComponent(path) : '') + (depth ? '&depth=' + depth : '') + (raw ? '&raw=1' : '')),
  stateCmdStatus: (id) => fetchState('/api/state?id=' + encodeURIComponent(id)),
  stateCmd: (body, raw = false) => fetchState('/api/state/cmd' + (raw ? '?raw=1' : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  stateSnapshots: () => fetchState('/api/state/snapshots'),
  stateSnapshotGet: (name, raw = false) => fetchState('/api/state/snapshots?name=' + encodeURIComponent(name) + (raw ? '&raw=1' : '')),
  stateSnapshotAct: (action, name, layers) => fetchState('/api/state/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, name, ...(layers ? { layers } : {}) }) }),
  stateSnapshotDelete: (name) => fetchState('/api/state/snapshots?name=' + encodeURIComponent(name), { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }),
  stateDiff: (a, b, raw = false) => fetchState('/api/state/diff?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b) + (raw ? '&raw=1' : '')),
  // action log and time travel (STA23-F2)
  stateActions: (raw = false) => fetchState('/api/state/actions' + (raw ? '?raw=1' : '')),
  stateActionTravel: (entry) => fetchState('/api/state/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'travel', entry }) }),
  // device lease
  lease: () => json('/api/lease'),
  leaseBoard: () => json('/api/lease/board'),
  leaseAction: (action) => post('/api/lease', { action }),
};
