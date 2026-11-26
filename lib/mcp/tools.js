'use strict';
const fs = require('fs');
const path = require('path');

// The brighttest-mcp/v1 tool set (ADR 0003). Names and schemas are a public contract, snapshot-tested
// (test/mcp-schema.test.js). Every tool is built on the existing e2e primitives; none takes a password,
// host or absolute path. Handlers get (args, session) and return plain data, or throw an Error whose
// `code` becomes the typed error code of the tool result.

const CONTRACT = 'brighttest-mcp/v1';

// ---- limits (defaults; the server takes overrides for tests) ----------------------------------------
const LIMITS = {
  maxTreeNodes: 500,          // nodes returned by inspect_tree before it flags truncation
  maxTreeBytes: 64 * 1024,    // JSON bytes of the nodes list
  maxTextChars: 200,          // per node text
  maxScreenshotBytes: 2 * 1024 * 1024,
  maxStateBytes: 128 * 1024,
  maxNetRequests: 500,
  maxNetBytes: 128 * 1024,    // JSON bytes of the net_requests list
  maxNetRules: 100,           // net_mock rules per session
  maxNetWildcards: 8,         // `*` characters in one URL glob
  maxPressesPerSession: 500,
  maxPressesPerCall: 20,
  maxNavigatePresses: 30,
  maxFlowRunsPerSession: 10,
  queueWaitMs: 30000,         // how long a device call may wait behind earlier ones before it is dropped
  pressGapMs: 250,            // end-to-start gap between presses of this session
  toolTimeoutMs: 30000,
  flowTimeoutMs: 120000,
  stateToolTimeoutMs: 45000,  // app_state_set / app_state_snapshot: 35 s agent connect wait plus the step
};

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// ---- schemas -----------------------------------------------------------------------------------------
const SELECTOR = {
  type: 'object',
  description: 'Match nodes in the live SceneGraph tree. All given keys must hold. Prefer id.',
  properties: {
    id: { type: 'string', description: 'SceneGraph node id' },
    subtype: { type: 'string', description: 'Node type, e.g. Label, RowList' },
    text: { type: 'string', description: 'Exact visible text' },
    textContains: { type: 'string', description: 'Substring of visible text' },
    uri: { type: 'string', description: 'Exact uri (posters, images)' },
    visible: { type: 'boolean' },
    focusable: { type: 'boolean' },
    focused: { type: 'boolean', description: 'Only the deepest focused node' },
    index: { type: 'integer', minimum: 0, description: 'Pick the Nth match (0-based)' },
  },
  additionalProperties: false,
  minProperties: 1,
};

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: 'list_devices',
    description: 'List the Roku devices brighttest knows (cached) and the one this session targets, with model, firmware and reachability. Devices come only from the brighttest resolution chain (ROKU_HOST, project .env, cache); no serial numbers or passwords are returned.',
    inputSchema: NO_ARGS,
    lease: false,
    handler: (args, s) => s.listDevices(),
  },
  {
    name: 'device_doctor',
    description: 'Read-only capability check of the target device (developer mode, ECP mode, firmware, video mode) with the exact fix text for anything wrong. Does not take the device lease.',
    inputSchema: NO_ARGS,
    lease: false,
    handler: (args, s) => s.doctor(),
  },
  {
    name: 'inspect_tree',
    description: 'Read the live SceneGraph tree. Without a selector returns a bounded depth-first node list; with a selector returns only the matching nodes. An empty match is a normal result (matches: []). Output is capped; truncated is true when the cap cut nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR,
        maxNodes: { type: 'integer', minimum: 1, maximum: LIMITS.maxTreeNodes, description: `Nodes to return, at most ${LIMITS.maxTreeNodes}` },
      },
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.inspectTree(args, c),
  },
  {
    name: 'press',
    description: 'Press a remote key on the device, one or more times, spaced by the ECP queue gap. Keys are the Roku remote key names (Up, Down, Left, Right, Select, Back, Home, ...) or Lit_<char> for one literal character. The session has a press cap.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Remote key name or Lit_<char>' },
        count: { type: 'integer', minimum: 1, maximum: LIMITS.maxPressesPerCall, description: `Presses, default 1, at most ${LIMITS.maxPressesPerCall} per call` },
      },
      required: ['key'],
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.press(args, c),
  },
  {
    name: 'navigate_to',
    description: 'Move D-pad focus onto the first node matching the selector (the "click X" of a D-pad world). Returns the keys pressed and the final focused node. Fails with the last focused node when the target cannot be reached. Counts against the press cap.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR,
        maxPresses: { type: 'integer', minimum: 1, maximum: LIMITS.maxNavigatePresses, description: `Press budget for this move, default ${LIMITS.maxNavigatePresses}` },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.navigateTo(args, c),
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the sideloaded app as an inline image. Needs the dev password configured out of band (ROKU_PASSWORD or the device cache); it is never a tool parameter. Only works while the dev channel is in front.',
    inputSchema: NO_ARGS,
    lease: true,
    handler: (args, s, c) => s.screenshot(c),
  },
  {
    name: 'app_state',
    description: "Read the app's self-published state from an instrumented build: the __bt_agent node (its global, scene and focus layers) first, or the legacy __bt_state node when there is no readable agent node. Errors with STATE_NOT_PUBLISHED when neither node is published (the build is not instrumented).",
    inputSchema: NO_ARGS,
    lease: true,
    handler: (args, s, c) => s.appState(c),
  },
  {
    name: 'run_flow',
    description: 'Run one *.e2e.yaml flow from the project (path relative to the project root, no ".." and no absolute path) and return the per-step results. A failing flow returns isError with the failing step. The session has a flow-run cap and the call has a duration cap.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512, description: 'Flow file relative to the project root, ending in .e2e.yaml' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.runFlow(args, c),
  },
  {
    name: 'net_requests',
    description: 'List the HTTP requests this session\'s net proxy has seen (newest last): method, url, status, duration, source and whether a mock answered it (mocked). Auth headers, tokens and sensitive query values are redacted. Optional filters: method, url glob, status. Output is capped by limit. The first net call opens a net window: one device lease held for the session plus a session hub that carries the app\'s live traffic. The window is released after 10 minutes without a device call (or earlier at session end, the lease cap, or lease loss); the result shows the hub while it is open (hub, else null; leaseId shows its first 8 characters only). The app reaches the hub only if the build and the MCP server share the hub token: set BRIGHTTEST_HUB_TOKEN in the server environment to the value used for instrument build --net. Mocks and the request list stay until the session ends.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method filter, e.g. GET' },
        url: { type: 'string', maxLength: 256, description: 'URL glob filter, e.g. **/catalog' },
        status: { type: 'integer', minimum: 100, maximum: 599, description: 'Response status filter' },
        limit: { type: 'integer', minimum: 1, maximum: LIMITS.maxNetRequests, description: `Entries to return (the newest), default 100, at most ${LIMITS.maxNetRequests}` },
      },
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.netRequests(args, c),
  },
  {
    name: 'net_mock',
    description: 'Add a mock for matching requests: answer them with the given status and JSON or text body instead of the origin. First match wins, newest rule first. The mock lives until the MCP session ends; there is no way to make it permanent. The first net call opens a net window (one device lease held for the session, plus a session hub for the app\'s live traffic), released after 10 minutes without a device call, at session end, or on lease loss. Needs BRIGHTTEST_HUB_TOKEN in the server environment (the value used for instrument build --net) for the app to reach the hub. Mocks stay until the session ends even after the window is released.',
    inputSchema: {
      type: 'object',
      properties: {
        match: {
          type: 'object', description: 'Which requests to answer',
          properties: {
            method: { type: 'string', description: 'HTTP method, e.g. GET (any when omitted)' },
            url: { type: 'string', maxLength: 256, description: 'URL glob, e.g. **/catalog' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        respond: {
          type: 'object', description: 'The canned response',
          properties: {
            status: { type: 'integer', minimum: 100, maximum: 599, description: 'Status code, default 200' },
            json: { description: 'JSON body (any JSON value)' },
            body: { type: 'string', maxLength: 65536, description: 'Text body, when json is not given' },
            headers: { type: 'object', description: 'Response headers (string values)', additionalProperties: { type: 'string', maxLength: 1024 } },
            delayMs: { type: 'integer', minimum: 0, maximum: 10000, description: 'Delay before answering' },
          },
          additionalProperties: false,
        },
        times: { type: 'integer', minimum: 1, maximum: 1000, description: 'Stop matching after this many hits' },
      },
      required: ['match', 'respond'],
      additionalProperties: false,
    },
    lease: true,
    handler: (args, s, c) => s.netMock(args, c),
  },
];

// ---- argument validation (the schema subset used above) ----------------------------------------------
// Returns null when valid, else a message naming the field. Pure.
function validate(schema, value, where) {
  const t = schema.type;
  const typeOk = t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value)
    : t === 'string' ? typeof value === 'string'
    : t === 'boolean' ? typeof value === 'boolean'
    : true;
  if (!typeOk) return `${where} must be ${t === 'integer' || t === 'object' ? 'an' : 'a'} ${t}`;
  if (t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be <= ${schema.maximum}`;
  }
  if (t === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) return `${where} must be at most ${schema.maxLength} characters`;
  if (t === 'object') {
    const props = schema.properties || {};
    const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null;
    for (const r of schema.required || []) if (value[r] === undefined) return `${where}.${r} is required`;
    for (const k of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) { if (extra) { const bad = validate(extra, value[k], `${where}.${k}`); if (bad) return bad; } else if (schema.additionalProperties === false) return `${where}.${k} is not a known parameter`; continue; }
      const bad = validate(props[k], value[k], `${where}.${k}`);
      if (bad) return bad;
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return `${where} needs at least ${schema.minProperties} property`;
  }
  return null;
}

// ---- path confinement (run_flow) ---------------------------------------------------------------------
// Rejects before any file content is read or any device call is made. Returns the real absolute path.
function confineFlowPath(root, rel) {
  const reject = (rule) => fail('PATH_REJECTED', `run_flow path rejected: ${rule}`, { rule });
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw reject('path must be a non-empty string');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw reject('absolute paths are not allowed; use a path relative to the project root');
  if (rel.split(/[\\/]+/).includes('..')) throw reject('".." segments are not allowed');
  if (!/\.e2e\.ya?ml$/i.test(rel)) throw reject('only *.e2e.yaml (or .yml) files can be run');
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (e) { throw fail('PATH_REJECTED', 'project root is not readable', { rule: 'root' }); }
  const full = path.resolve(realRoot, rel);
  if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw reject('path is outside the project root');
  let real;
  try { real = fs.realpathSync(full); }
  catch (e) { throw fail('FLOW_NOT_FOUND', `no such flow: ${rel}`); }
  if (!real.startsWith(realRoot + path.sep)) throw reject('path resolves outside the project root (symlink)');
  let st;
  try { st = fs.statSync(real); } catch (e) { throw fail('FLOW_NOT_FOUND', `no such flow: ${rel}`); }
  if (!st.isFile()) throw reject('path is not a file');
  return real;
}

module.exports = { CONTRACT, LIMITS, TOOLS, validate, confineFlowPath, fail };
