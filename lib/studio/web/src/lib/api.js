// Thin wrappers over the studio JSON API (proxied to the studio server in dev, same-origin in prod).
const json = (url, opts) => fetch(url, opts).then((r) => r.json());
const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  device: () => json('/api/device'),
  discover: () => json('/api/discover'),
  cachedDevices: () => json('/api/cached'),
  connect: (host, password) => post('/api/connect', { host, password }),
  tree: () => json('/api/tree'),
  screenshotUrl: () => '/api/screenshot?t=' + Date.now(),
  keypress: (key, count = 1) => post('/api/keypress', { key, count }),
  launch: (app) => post('/api/launch', { app }),
  flows: () => json('/api/flows'),
  readFlow: (rel) => json('/api/flow?file=' + encodeURIComponent(rel)),
  saveFlow: (file, text) => post('/api/flow', { file, text }),
  runUrl: (rel) => '/api/run?file=' + encodeURIComponent(rel),
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
  // device lease
  lease: () => json('/api/lease'),
  leaseAction: (action) => post('/api/lease', { action }),
};
