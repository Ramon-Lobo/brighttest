'use strict';

// The single list of flow steps (ADR 0047). One entry per top-level step key the flow parser accepts.
//   - flow.js normalizeStep rejects any key that is not here (the "unknown step" error);
//   - state-steps.js and net-steps.js read their allowed map keys from `keys`;
//   - Studio serves this list at GET /api/steps and builds editor completions from it;
//   - test/e2e-step-catalog.test.js fails when the parser or runner handles a step this list lacks.
// Data only: no requires, no I/O, so any layer can load it.
//
// Entry fields:
//   key      step name as written in a flow (`- key: ...`)
//   group    app | input | wait | assert | state | net | flow (the order of the list is the order the editor shows)
//   detail   one line shown next to the completion
//   bare     true when `- key` with no value is valid
//   aliasOf  the runner op this key normalizes to (assertPlaying -> assertMedia); omitted otherwise
//   snippet  text the editor inserts. Placeholders: {{sel}} (selected node as `{ id: x }`), {{inner}} (the same
//            without braces), {{text}} (selected node text), {{id}} (selected node id)
//   keys     map keys accepted inside `{ }` (completion and, for state/net steps, validation)
//   enums    allowed values for a map key
//   needs    'hub' (instrumented build) | 'logs' (device console reader) | null
//   example  one flow line that must parse (checked by the test)

const SELECTOR = ['id', 'subtype', 'text', 'textContains', 'uri', 'focused', 'focusable', 'visible', 'index'];
const ACK = ['applied', 'reflected'];

const entries = [
  { key: 'launch', group: 'app', bare: true, detail: 'start the app', snippet: 'launch', keys: [], needs: null,
    example: '- launch' },
  { key: 'requires', group: 'flow', detail: 'skip the rest of the flow unless the device matches', snippet: 'requires: { firmware: ">=12.5" }',
    keys: ['firmware', 'videoMode', 'deviceClass'], enums: { deviceClass: ['tv', 'box', 'stick'] }, needs: null,
    example: '- requires: { firmware: ">=12.5", deviceClass: box }' },
  { key: 'runFlow', group: 'flow', detail: 'run a reusable subflow', snippet: 'runFlow: { file: login.e2e.yaml }',
    keys: ['file', 'env'], needs: null, example: '- runFlow: { file: login.e2e.yaml, env: { user: demo } }' },
  { key: 'press', group: 'input', detail: 'keypress (Up/Down/Left/Right/Select/Back...)', snippet: 'press: Select', keys: ['key', 'count'], needs: null,
    example: '- press: Select' },
  { key: 'holdKey', group: 'input', detail: 'hold a key down for N milliseconds', snippet: 'holdKey: { key: Right, ms: 500 }',
    keys: ['key', 'ms'], needs: null, example: '- holdKey: { key: Right, ms: 500 }' },
  { key: 'pressUntil', group: 'input', detail: 'repeat a key until a selector appears', snippet: 'pressUntil: { key: Down, visible: {{sel}} }',
    keys: ['key', 'visible', 'selector', 'max'], needs: null, example: '- pressUntil: { key: Down, visible: { id: row5 }, max: 10 }' },
  { key: 'focus', group: 'input', detail: 'D-pad path-find onto a node', snippet: 'focus: {{sel}}',
    keys: [...SELECTOR, 'maxPresses'], needs: null, example: '- focus: { id: playButton }' },
  { key: 'text', group: 'input', detail: 'type into the focused field', snippet: 'text: ', keys: [], needs: null,
    example: '- text: hello' },
  { key: 'back', group: 'input', bare: true, detail: 'press Back', snippet: 'back', keys: [], needs: null, example: '- back' },
  { key: 'home', group: 'input', bare: true, detail: 'press Home', snippet: 'home', keys: [], needs: null, example: '- home' },
  { key: 'wait', group: 'wait', detail: 'pause N milliseconds', snippet: 'wait: 500', keys: ['ms'], needs: null, example: '- wait: 500' },
  { key: 'waitFor', group: 'wait', detail: 'wait for a selector', snippet: 'waitFor: { {{inner}}, timeout: 10 }',
    keys: [...SELECTOR, 'selector', 'timeout'], needs: null, example: '- waitFor: { id: homeScreen, timeout: 10 }' },
  { key: 'assertVisible', group: 'assert', detail: 'node is present', snippet: 'assertVisible: {{sel}}', keys: SELECTOR, needs: null,
    example: '- assertVisible: { id: homeScreen }' },
  { key: 'assertGone', group: 'assert', detail: 'node is absent', snippet: 'assertGone: {{sel}}', keys: SELECTOR, needs: null,
    example: '- assertGone: { id: spinner }' },
  { key: 'assertFocused', group: 'assert', detail: 'node has focus', snippet: 'assertFocused: {{sel}}', keys: SELECTOR, needs: null,
    example: '- assertFocused: { id: playButton }' },
  { key: 'assertText', group: 'assert', detail: "node's text equals/contains", snippet: 'assertText: { {{inner}}, equals: "{{text}}" }',
    keys: [...SELECTOR, 'equals', 'contains'], needs: null, example: '- assertText: { id: title, equals: Home }' },
  { key: 'assertField', group: 'assert', detail: 'any node field equals/contains', snippet: 'assertField: { {{inner}}, field: , equals:  }',
    keys: [...SELECTOR, 'field', 'equals', 'contains'], needs: null, example: '- assertField: { id: hero, field: opacity, equals: "1" }' },
  { key: 'assertMedia', group: 'assert', detail: 'ECP media-player state (play, pause, buffer...)', snippet: 'assertMedia: { state: play }',
    keys: ['state', 'timeout'], enums: { state: ['play', 'pause', 'buffer', 'finished'] }, needs: null,
    example: '- assertMedia: { state: pause, timeout: 5 }' },
  { key: 'assertPlaying', group: 'assert', bare: true, aliasOf: 'assertMedia', detail: 'media is playing (shorthand for assertMedia state: play)',
    snippet: 'assertPlaying', keys: ['timeout'], needs: null, example: '- assertPlaying' },
  { key: 'assertState', group: 'assert', detail: "value in the app's published state", snippet: 'assertState: { path: , equals:  }',
    keys: ['layer', 'path', 'equals', 'contains', 'deepEquals', 'exists', 'timeout'], enums: { layer: ['global', 'scene', 'node', 'm', 'registry'], exists: ['true', 'false'] },
    needs: 'hub', example: '- assertState: { path: current, equals: PlayerPanel }' },
  { key: 'assertLog', group: 'assert', detail: 'a device console line matches (text or "/regex/")', snippet: 'assertLog: "{{text}}"',
    keys: ['pattern', 'timeout'], needs: 'logs', example: '- assertLog: "ready"' },
  { key: 'expectNoLog', group: 'assert', detail: 'no console line so far matches', snippet: 'expectNoLog: "{{text}}"',
    keys: ['pattern'], needs: 'logs', example: '- expectNoLog: "error"' },
  { key: 'screenshot', group: 'app', detail: 'save a frame', snippet: 'screenshot: shot.png', keys: [], needs: null,
    example: '- screenshot: home.png' },
  { key: 'waitForAgent', group: 'state', bare: true, detail: 'wait until the instrumented app answers', snippet: 'waitForAgent',
    keys: ['timeout'], needs: 'hub', example: '- waitForAgent: { timeout: 10 }' },
  { key: 'setState', group: 'state', detail: "write app state (layer, path, value)", snippet: 'setState: { layer: global, path: , value:  }',
    keys: ['layer', 'path', 'value', 'ops', 'node', 'ack', 'timeout'], enums: { layer: ['global', 'scene', 'node', 'm', 'registry'], ack: ACK },
    needs: 'hub', example: '- setState: { layer: global, path: user.tier, value: premium }' },
  { key: 'snapshot', group: 'state', detail: 'save the app state under a name', snippet: 'snapshot: fresh_home',
    keys: ['name', 'nodes', 'ack', 'timeout'], enums: { ack: ACK }, needs: 'hub', example: '- snapshot: fresh_home' },
  { key: 'restore', group: 'state', detail: 'restore a saved state snapshot', snippet: 'restore: fresh_home',
    keys: ['name', 'ack', 'timeout'], enums: { ack: ACK }, needs: 'hub', example: '- restore: fresh_home' },
  { key: 'callFunc', group: 'state', detail: 'call an allow-listed node function', snippet: 'callFunc: { node: { id: {{id}} }, fn: , args: [] }',
    keys: ['node', 'fn', 'args', 'ack', 'timeout'], enums: { ack: ACK }, needs: 'hub',
    example: '- callFunc: { node: { id: homePanel }, fn: bt_resetHome, args: [] }' },
  { key: 'mockHttp', group: 'net', detail: 'answer matching requests with a canned response', snippet: 'mockHttp: { url: "**/", status: 200 }',
    keys: ['id', 'method', 'url', 'reqHeaders', 'reqBody', 'times', 'status', 'headers', 'body', 'json', 'file', 'bodyBase64',
      'delayMs', 'fault', 'kind', 'holdMs', 'partialBytes', 'responses', 'passthrough'], needs: 'hub',
    example: '- mockHttp: { url: "**/v1/home", status: 200, json: { ok: true } }' },
  { key: 'waitForRequest', group: 'net', detail: 'wait until the app makes a matching request', snippet: 'waitForRequest: { url: "**/" }',
    keys: ['method', 'url', 'status', 'bodyContains', 'timeout'], needs: 'hub', example: '- waitForRequest: { url: "**/v1/home", timeout: 5 }' },
  { key: 'assertRequest', group: 'net', detail: 'a matching request was (or was not) made', snippet: 'assertRequest: { url: "**/", count: 1 }',
    keys: ['method', 'url', 'status', 'bodyContains', 'count', 'timeout'], needs: 'hub', example: '- assertRequest: { url: "**/v1/home", count: 1 }' },
  { key: 'recordHttp', group: 'net', detail: 'record traffic to a HAR file (or stop)', snippet: 'recordHttp: { file: net.har }',
    keys: ['file', 'stop'], needs: 'hub', example: '- recordHttp: { file: net.har }' },
  { key: 'clearHttp', group: 'net', bare: true, detail: "drop this flow's mock rules", snippet: 'clearHttp', keys: [], needs: 'hub',
    example: '- clearHttp' },
];

function freeze(e) {
  for (const k of ['keys']) if (e[k]) Object.freeze(e[k]);
  if (e.enums) { for (const v of Object.values(e.enums)) Object.freeze(v); Object.freeze(e.enums); }
  return Object.freeze(e);
}
const STEP_CATALOG = Object.freeze(entries.map(freeze));
const byKey = new Map(STEP_CATALOG.map((e) => [e.key, e]));

const stepKeys = () => STEP_CATALOG.map((e) => e.key);
const entry = (key) => byKey.get(key);

module.exports = { STEP_CATALOG, stepKeys, entry };
