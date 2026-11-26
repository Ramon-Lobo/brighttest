import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Studio's controls carry stable `data-testid`s so browser agents (and tests) can find them. They are listed in
// docs/guide/studio.md. This fails if a listed id leaves the Svelte source, if a control loses its accessible name,
// or if the docs and this list drift apart. It reads the source: Studio's web client has no component test runner.
const SRC = path.join(__dirname, '..', 'lib', 'studio', 'web', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// [file, id] with a literal data-testid in that file.
const STATIC = {
  'App.svelte': [
    'studio-app', 'studio-header', 'device-summary', 'sim-badge', 'sim-tail', 'lease-badge', 'lease-badge-summary',
    'lease-queue', 'toggle-overlay', 'toggle-all-nodes', 'toggle-offscreen', 'toggle-live', 'live-status', 'lease-bar', 'lease-queued',
    'lease-take-over', 'page-nav', 'page-inspect', 'flow-tree', 'flow-tree-show', 'flow-editor', 'flow-name',
    'flow-editor-text', 'flow-save', 'flow-run', 'flow-message', 'flow-run-steps', 'live-monitor',
    'monitor-needs-device', 'inspector-panel', 'remote-panel', 'remote-needs-device',
    'tab-node', 'tab-tree', 'tab-selector', 'tab-state', 'tab-actions', 'tab-net',
  ],
  'lib/Inspector.svelte': ['node-view-fields', 'node-view-state'],
  'lib/NodeState.svelte': [
    'node-state', 'node-state-id', 'node-state-noid', 'node-state-layer-node', 'node-state-layer-m', 'node-state-refresh', 'node-state-raw',
    'node-state-age', 'node-state-dup', 'node-state-reason', 'node-state-large', 'node-state-field', 'node-state-path', 'node-state-notfound',
    'node-state-rows', 'node-state-goto', 'node-state-goto-under', 'node-state-edit', 'node-state-input', 'node-state-load', 'node-state-chip', 'node-state-step',
  ],
  'lib/HierarchyTree.svelte': ['tree-node-state'],
  'lib/Stage.svelte': ['monitor-stage', 'monitor-screenshot', 'monitor-overlay'],
  'lib/Remote.svelte': [
    'remote', 'remote-key-up', 'remote-key-down', 'remote-key-left', 'remote-key-right', 'remote-key-select',
    'remote-key-back', 'remote-key-home',
  ],
  'lib/pages/Devices.svelte': ['page-devices', 'devices-discover', 'device-current', 'devices-message', 'device-list', 'device-row', 'device-connect'],
  'lib/LeaseBoard.svelte': ['lease-board', 'lease-device'],
  'lib/pages/Record.svelte': ['page-record', 'record-start', 'record-stop', 'record-clear', 'record-save', 'record-message', 'record-doc'],
  'lib/pages/Runs.svelte': [
    'page-runs', 'run-history', 'run-history-item', 'trace-viewer', 'trace-frame', 'trace-scrubber', 'trace-prev',
    'trace-slider', 'trace-next', 'trace-position', 'trace-steps', 'trace-step',
  ],
  'lib/pages/Profile.svelte': [
    'page-profile', 'profile-controls', 'profile-start', 'profile-stop', 'profile-interval', 'profile-marker',
    'profile-export-json', 'profile-export-csv', 'profile-tiles', 'profile-snapshot-textures', 'profile-perfetto-enable',
    'profile-perfetto-start', 'profile-perfetto-stop', 'profile-perfetto-heap', 'profile-bsprof-import', 'profile-bsprof-pull',
  ],
};
// Ids built from a template: [file, template in source, expanded ids].
const DYNAMIC = [
  ['App.svelte', 'data-testid="nav-{p.id}"', ['nav-inspect', 'nav-runs', 'nav-record', 'nav-devices', 'nav-profile', 'nav-settings']],
  ['lib/pages/Profile.svelte', 'data-testid="profile-console-{c.replace(', ['profile-console-free', 'profile-console-sgperf-start', 'profile-console-sgperf-report', 'profile-console-sgperf-stop', 'profile-console-loaded-textures', 'profile-console-fps-display-on', 'profile-console-fps-display-off', 'profile-console-logrendezvous-on', 'profile-console-logrendezvous-off']],
  ['lib/ContextMenu.svelte', "testid: 'menu-inspect-state'", ['menu-inspect-state']],
];
const ALL = [...Object.values(STATIC).flat(), ...DYNAMIC.flatMap((d) => d[2])];

describe('Studio agent labels', () => {
  for (const [file, ids] of Object.entries(STATIC)) {
    it(`${file} keeps its data-testids`, () => {
      const src = read(file);
      const missing = ids.filter((id) => !src.includes(`data-testid="${id}"`));
      expect(missing).toEqual([]);
    });
  }
  for (const [file, tpl] of DYNAMIC) {
    it(`${file} keeps the templated ${tpl}`, () => expect(read(file)).toContain(tpl));
  }
  it('the nav ids match the page list', () => {
    const pages = [...read('App.svelte').matchAll(/\{ id: '(\w+)', label:/g)].map((m) => `nav-${m[1]}`);
    expect(pages).toEqual(DYNAMIC[0][2]);
  });
  it('has no duplicate ids in the list', () => expect(new Set(ALL).size).toBe(ALL.length));
  it('every control that has no visible text keeps an accessible name', () => {
    for (const f of ['lib/Remote.svelte', 'lib/pages/Runs.svelte']) {
      const src = read(f);
      for (const m of src.matchAll(/<button[^\n]*data-testid="(remote-key-(?:up|down|left|right|select)|trace-(?:prev|next))"[^\n]*/g)) {
        expect(m[0], `${f} ${m[1]}`).toContain('aria-label=');
      }
    }
    expect(read('lib/pages/Runs.svelte')).toMatch(/<input type="range" data-testid="trace-slider" aria-label=/);
    expect(read('lib/Stage.svelte')).toMatch(/data-testid="monitor-screenshot" alt="live device screen"/);
  });
  it('docs/guide/studio.md lists every id', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'guide', 'studio.md'), 'utf8');
    const missing = ALL.filter((id) => !doc.includes('`' + id + '`'));
    expect(missing).toEqual([]);
  });
});
