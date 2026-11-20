'use strict';
// Named scenarios for the fake Roku. Each is a partial config merged over DEFAULTS in server.js.
// Where the design names a behavior without defining its wire shape, the choice made here is noted.
//
// Config keys:
//   fault          { mode: 'status'|'hang'|'reset'|'slow', status?, ms?, once? }  ECP-only fault switch.
//                  `once` = fault only the first request to each ECP path.
//   ecpMode        'permissive' | 'limited'  (limited: only device-info, apps, active-app answer)
//   developerEnabled  false -> installer 404, launch/dev 404, console/debug ports closed
//   unreachable    true -> nothing listens (ports are allocated then released)
//   activeApp      initial active app: 'dev' | 'roku' | 'native-ui' | 'dynamic-menu'
//   tree           'small' | 'large-3k' | 'large-6k' | 'facade' | 'dialog-root'
//   sgnodes        'ok' | 'fail' | 'cold-stall' | 'hang'
//   launchBounce   number of active-app queries that report Roku after launch/dev before dev shows
//   launchStays    true -> launch/dev answers 200 but the app never becomes active
//   launch404Count number of launch/dev calls that 404 right after a successful sideload
//   crashAfterKeys keypress count that triggers a crash (active app -> Roku, debugger transcript on 8085)
//   debugOnConnect 'history' | 'crash' | 'halted'  what port 8085 prints on connect
//   liveLines      true -> 8085 emits a live log line every 100 ms after replay
//   installerMode  'ok' | 'compile-failure' | 'transient-once' | 'tcp80-closed' | 'page'
//   deleteFails    true -> installer Delete returns a failure page
//   screenshotOk   false -> installer answers "Screenshot not ok"
//   screenshotFormat 'jpg' | 'png'
//   bannerSplit    true -> console banner arrives in two TCP chunks
const SCENARIOS = {
  healthy: {},
  'latency-200ms': { fault: { mode: 'slow', ms: 200 } },
  '5xx-once': { fault: { mode: 'status', status: 503, once: true } },
  '5xx-always': { fault: { mode: 'status', status: 503 } },
  'reset-once': { fault: { mode: 'reset', once: true } },
  stall: { fault: { mode: 'hang' } },
  401: { fault: { mode: 'status', status: 401 } },
  403: { fault: { mode: 'status', status: 403 } },
  404: { fault: { mode: 'status', status: 404 } },
  'crash-mid-flow': { crashAfterKeys: 3 },
  limited: { ecpMode: 'limited' },
  'dev-disabled': { developerEnabled: false },
  unreachable: { unreachable: true },
  'cold-stall': { sgnodes: 'cold-stall' },
  'home-bounce': { launchBounce: 2 },
  // Interpretation: the app is "active" but the tree holds only an OS overlay, not the app's scene.
  'osd-facade': { tree: 'facade' },
  // Interpretation: a system dialog is the top screen/root of the tree.
  'system-dialog-root': { tree: 'dialog-root' },
  'launch-404-after-sideload': { launch404Count: 2 },
  'sgnodes-fails': { sgnodes: 'fail' },
  // Interpretation: app stopped at the debugger: tree queries hang, 8085 shows the debugger prompt.
  'halted-app': { sgnodes: 'hang', debugOnConnect: 'halted' },
  // Interpretation: installer answers 200 with a generic HTML page that has no Success/Failure text.
  'installer-page': { installerMode: 'page' },
  'never-leaves-home': { activeApp: 'roku', launchStays: true },
  'replay-then-live': { liveLines: true },
  'debugger-crash': { debugOnConnect: 'crash' },
  'large-tree-3k': { tree: 'large-3k' },
  'large-tree-6k': { tree: 'large-6k' },
};

module.exports = { SCENARIOS };
