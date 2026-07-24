// Thin wrappers over the studio JSON API (proxied to the studio server in dev, same-origin in prod).
const json = (url, opts) => fetch(url, opts).then((r) => r.json());
const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  device: () => json('/api/device'),
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
};
