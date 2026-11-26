'use strict';
function fail(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

// MCP app state tools (STA-S-T15): app_state_get, app_state_set, app_state_snapshot.
// Validation is the flow-step validation of STA-S-T7 (state-steps.normalizeStep), not a second copy: layers, paths,
// snapshot names and the node reference are checked by the same code, and writes go through the same hub command
// path (stateOps.prepare allow-list and type checks run in the hub and in the agent). The two write tools run on the
// session hub window (one session lease and one hub per MCP session, shared with the net tools): the first write waits
// for the agent's own hello (it retries every 30 s), later writes find it connected. Reads use the ECP agent node and
// need no hub and never open a window. No tool takes a host, a password or a hub token.

const STEP_TIMEOUT_MS = 8000;
const POLL_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAYER_DESC = 'Layer: global, scene, node or registry (set); global, scene or focus (get)';

class ArgError extends Error { constructor(m) { super(m); this.code = 'INVALID_ARGS'; } }

function build(key, arg) {
  const stateSteps = require('../e2e/state-steps');
  const clean = Object.fromEntries(Object.entries(arg).filter(([, v]) => v !== undefined));
  try { return stateSteps.normalizeStep(key, clean, 0, ArgError); }
  catch (e) { throw fail('INVALID_ARGS', String(e.message).replace(/^line 0: /, '')); }
}

const methods = {
  appStateGet(args, call) {
    return this.withDevice(call, async ({ device }) => {
      const sg = require('../e2e/sgnodes');
      const appstate = require('../e2e/appstate');
      const ag = await appstate.readAgentState(device, undefined, { maxBytes: this.limits.maxStateBytes });
      let root;
      let source;
      if (ag.present && !ag.error) { root = ag.layers; source = 'agent'; } else {
        const res = appstate.extractAppState((await sg.fetchTreeFor(device, { id: appstate.STATE_NODE_ID })).roots);
        if (!res.present) throw fail('STATE_NOT_PUBLISHED', 'the app does not publish state: no __bt_agent or __bt_state node (the build is not instrumented)');
        if (res.error) throw fail('STATE_UNREADABLE', `the published state could not be read: ${res.error}`);
        root = res.state; source = 'legacy';
      }
      if (args.layer !== undefined) {
        const k = source === 'agent' && root && typeof root === 'object' ? appstate.resolveKey(root, args.layer) : undefined;
        if (k === undefined) throw fail('STATE_LAYER_NOT_FOUND', `no layer "${args.layer}" in the published state`, { data: { layers: source === 'agent' ? Object.keys(root) : [] } });
        root = root[k];
      }
      let value = root;
      if (args.path !== undefined) {
        const r = appstate.getPathCI(root, args.path);
        if (r.value === undefined) throw fail('STATE_PATH_NOT_FOUND', `no value at "${args.path}"`, { data: { keys: r.keys } });
        value = r.value;
      }
      const bytes = Buffer.byteLength(JSON.stringify(value) || 'null', 'utf8');
      if (bytes > this.limits.maxStateBytes) throw fail('APP_STATE_TOO_LARGE', `the requested state is ${bytes} bytes, over the ${this.limits.maxStateBytes}-byte cap; narrow it with layer and path`, { data: { bytes, cap: this.limits.maxStateBytes } });
      return { source, ...(args.layer !== undefined ? { layer: args.layer } : {}), ...(args.path !== undefined ? { path: args.path } : {}), value, bytes };
    });
  },
  appStateSet(args, call) {
    const step = build('setState', { layer: args.layer, path: args.path, value: args.value, node: args.node, ack: args.ack });
    if (!('value' in args)) throw fail('INVALID_ARGS', 'value is required');
    this.requireHubToken();
    return this.withDevice(call, async ({ device }) => {
      const r = await this.runStateStep(call, device, step);
      return { ok: true, layer: step.layer, path: step.path, detail: r.detail };
    }, { window: 'state', precheck: (ctx) => this.requireAgentNode(ctx) });
  },
  appStateSnapshot(args, call) {
    const step = build('snapshot', { name: args.name });
    this.requireHubToken();
    return this.withDevice(call, async ({ device }) => {
      const r = await this.runStateStep(call, device, step, (st) => st.hub.stateOps.getSnapshot(`${st.scope}:${step.name}`));
      const layers = r.extra || {};
      const bytes = Buffer.byteLength(JSON.stringify(layers), 'utf8');
      if (bytes > this.limits.maxStateBytes) throw fail('APP_STATE_TOO_LARGE', `snapshot is ${bytes} bytes, over the ${this.limits.maxStateBytes}-byte cap; nothing was truncated`, { data: { bytes, cap: this.limits.maxStateBytes } });
      return { name: step.name, layers, bytes, detail: r.detail };
    }, { window: 'state', precheck: (ctx) => this.requireAgentNode(ctx) });
  },

  // D5a: the hub only accepts the build's baked token when it is the operator's BRIGHTTEST_HUB_TOKEN. Checked before
  // any lease is taken; the value itself is never read into a message.
  requireHubToken() {
    if (!require('../instrument/hub').hubTokenFromEnv(this.env)) {
      throw fail('STATE_NO_HUB_TOKEN', 'app_state_set and app_state_snapshot need BRIGHTTEST_HUB_TOKEN (32 hex characters) in the MCP server environment: the same value the app was built with (brighttest instrument build --net). No device request was sent.');
    }
  },

  // D5b: the dev app must publish the agent node. Runs under a command lease before the window opens, so a missing
  // node starts no hub and holds no session lease.
  async requireAgentNode({ device }) {
    const ag = await require('../e2e/appstate').readAgentState(device, undefined, { maxBytes: this.limits.maxStateBytes });
    if (!ag.present) throw fail('STATE_NOT_INSTRUMENTED', 'the running app does not publish the brighttest agent node (__bt_agent): it is not an instrumented build, or it is not running. Build with `brighttest instrument build --net`, sideload it and launch it.');
  },

  // One state step on the window's hub (never starts a hub). Waits up to limits.stateConnectMs for the agent to be
  // connected (live), then runs the step. Returns { detail, extra }.
  async runStateStep(call, device, step, after) {
    const stateSteps = require('../e2e/state-steps');
    const hub = this._hub;
    if (!hub) throw fail('STATE_NO_HUB', 'the session hub is not running');
    const began = stateSteps.beginFlow({ steps: [step], config: {}, file: 'mcp', name: 'mcp' }, hub, this.loadCfg(), 'mcp', { helloBase: 0 });
    if (began.error) throw fail('STATE_NO_HUB', began.error);
    const state = began.state;
    try {
      const deadline = Date.now() + this.limits.stateConnectMs;
      while (!hub.agentLive()) {
        if (call.signal.aborted) throw new Error(String(call.signal.reason || 'aborted'));
        if (Date.now() >= deadline) {
          throw this.agentSeen
            ? fail('STATE_AGENT_GONE', 'the app agent was connected to the session hub but is not polling any more (the app exited or restarted?). Relaunch the instrumented app; the session hub window stays open and the agent reconnects within about 30 seconds.')
            : fail('STATE_AGENT_UNREACHABLE', `the app publishes its agent node but did not connect to the session hub within ${Math.round(this.limits.stateConnectMs / 1000)} s. Check that the build used the same BRIGHTTEST_HUB_TOKEN, hub port and a LAN address of this machine (run brighttest doctor with BRIGHTTEST_DOCTOR_HUB_PROBE=1 for the hub reach probe). The session hub window stays open, so a fixed build can still connect.`);
        }
        await sleep(POLL_MS);
      }
      this.agentSeen = true;
      let detail;
      try { ({ detail } = await stateSteps.execStep(step, { state, signal: call.signal, stepTimeoutMs: this.limits.stateStepMs || STEP_TIMEOUT_MS, device })); }
      catch (e) {
        if (e && e.code === 'STATE_ACK_TIMEOUT' && !hub.agentLive()) throw fail('STATE_AGENT_GONE', 'the app agent stopped polling the session hub before it acknowledged the command (the app exited or restarted?). Relaunch the instrumented app and retry.');
        throw e;
      }
      return { detail, extra: after ? after(state) : null };
    } finally { stateSteps.endFlow(state); }
  },
};

function defs() {
  return [
    {
      name: 'app_state_get',
      description: 'Read the published app state (instrumented build: __bt_agent layers; older builds: __bt_state). Optionally narrow by layer (global, scene, focus) and a dotted path (case-insensitive segments). Output is capped; errors with STATE_NOT_PUBLISHED when the build is not instrumented.',
      inputSchema: { type: 'object', properties: { layer: { type: 'string', maxLength: 64, description: 'Layer name, e.g. global, scene, focus' }, path: { type: 'string', maxLength: 256, description: 'Dotted path inside the layer (or inside all layers when no layer is given)' } }, additionalProperties: false },
      lease: true,
      handler: (args, s, c) => s.appStateGet(args, c),
    },
    {
      name: 'app_state_set',
      description: 'Set one value in the running instrumented app (the setState flow step). The agent applies only its allow-listed ops and refuses type mismatches without crashing. Runs on the session hub window: the first write opens it (one device lease held for the session, released after 10 minutes without a device call) and waits up to 35 s for the app agent to connect; later writes are fast. Needs BRIGHTTEST_HUB_TOKEN in the server environment (the value used for instrument build --net) and the instrument hub port (instrument.hub.port). The app network is not touched unless a net tool is used. Errors: STATE_NO_HUB_TOKEN, STATE_NOT_INSTRUMENTED, STATE_AGENT_UNREACHABLE, STATE_AGENT_GONE, STATE_CMD_FAILED, STATE_ACK_TIMEOUT, DEVICE_BUSY.',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { type: 'string', maxLength: 16, description: LAYER_DESC + '; default global' },
          path: { type: 'string', maxLength: 256, description: 'Dotted path such as user.tier; for registry <section>.<key>' },
          value: { description: 'JSON value to write (string, number, boolean, null, array or object)' },
          node: { type: 'object', properties: { id: { type: 'string', maxLength: 128, description: 'SceneGraph node id (layer node only)' } }, required: ['id'], additionalProperties: false },
          ack: { type: 'string', maxLength: 16, description: 'applied (default) or reflected' },
        },
        required: ['path', 'value'],
        additionalProperties: false,
      },
      lease: true,
      handler: (args, s, c) => s.appStateSet(args, c),
    },
    {
      name: 'app_state_snapshot',
      description: 'Take a named snapshot of the app state layers through the agent and return the layers (capped, never truncated). The snapshot lives only for this call, so restore is not offered. Same session hub window, connect wait, token and errors as app_state_set.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 64, description: 'Snapshot name: letters, digits, "_", "-" or "."' } }, required: ['name'], additionalProperties: false },
      lease: true,
      handler: (args, s, c) => s.appStateSnapshot(args, c),
    },
  ];
}

module.exports = { defs, methods };
