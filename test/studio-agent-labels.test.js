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
    'flow-editor-text', 'flow-save', 'flow-run', 'flow-stop', 'flow-message', 'flow-run-steps', 'live-monitor',
    'monitor-needs-device', 'remote-panel', 'remote-needs-device',
    'tiles-menu', 'tiles-menu-list', 'tiles-preset-default', 'tiles-preset-monitor-info', 'tiles-reset', 'tiles-confirm', 'tiles-cancel',
    'header-run-stop',
  ],
  'lib/TileGrid.svelte': ['layout-grid', 'layout-placeholder', 'layout-live', 'layout-empty', 'layout-empty-show'],
  'lib/Inspector.svelte': ['node-view-fields', 'node-view-state'],
  'lib/NodeState.svelte': [
    'node-state', 'node-state-id', 'node-state-noid', 'node-state-layer-node', 'node-state-layer-m', 'node-state-refresh', 'node-state-raw',
    'node-state-age', 'node-state-dup', 'node-state-reason', 'node-state-large', 'node-state-field', 'node-state-path', 'node-state-notfound',
    'node-state-rows', 'node-state-goto', 'node-state-goto-under', 'node-state-edit', 'node-state-input', 'node-state-load', 'node-state-chip', 'node-state-step',
  ],
  'lib/HierarchyTree.svelte': ['tree-node-state'],
  'lib/Network.svelte': ['net-panel', 'net-filter', 'net-clear', 'net-export-har', 'net-show-secrets', 'net-list', 'net-detail-splitter'],
  'lib/NetDetail.svelte': ['net-detail', 'net-detail-close', 'net-detail-orient', 'net-detail-general', 'net-detail-req-headers', 'net-detail-res-headers', 'net-redaction-badge', 'net-not-in-har', 'net-refused-hint', 'net-copy-url', 'net-copy-req-headers', 'net-copy-res-headers', 'net-query', 'net-mock-this', 'net-copy-rule', 'net-block', 'net-clear-rules'],
  'lib/BodyView.svelte': ['net-body', 'net-body-pretty', 'net-body-raw', 'net-body-show-all', 'net-body-download', 'net-body-truncated', 'net-body-binary', 'net-body-search', 'net-body-search-next', 'net-body-search-prev', 'net-body-search-count', 'net-body-search-case', 'net-body-copy'],
  'lib/Stage.svelte': ['monitor-stage', 'monitor-screenshot', 'monitor-overlay'],
  'lib/Remote.svelte': [
    'remote', 'remote-key-up', 'remote-key-down', 'remote-key-left', 'remote-key-right', 'remote-key-select',
    'remote-key-back', 'remote-key-home',
  ],
  'lib/pages/Devices.svelte': ['page-devices', 'devices-discover', 'device-current', 'devices-message', 'device-list', 'device-row', 'device-connect'],
  'lib/pages/Settings.svelte': ['settings-page', 'settings-device-source', 'settings-test-connection', 'settings-password-status', 'settings-hub-status', 'settings-token-status', 'settings-about-copy'],
  'lib/LeaseBoard.svelte': ['lease-board', 'lease-device'],
  'lib/pages/Record.svelte': ['page-record', 'record-start', 'record-stop', 'record-clear', 'record-save', 'record-message', 'record-doc'],
  'lib/pages/Runs.svelte': [
    'page-runs', 'run-history', 'run-history-item', 'run-stopped-badge', 'trace-viewer', 'trace-frame', 'trace-scrubber', 'trace-prev',
    'trace-slider', 'trace-next', 'trace-position', 'trace-steps', 'trace-step',
  ],
  'lib/pages/Profile.svelte': [
    'page-profile', 'profile-controls', 'profile-start', 'profile-stop', 'profile-interval', 'profile-marker',
    'profile-export-json', 'profile-export-csv', 'profile-tiles', 'profile-snapshot-textures', 'profile-perfetto-enable',
    'profile-perfetto-start', 'profile-perfetto-stop', 'profile-perfetto-heap', 'profile-bsprof-import', 'profile-bsprof-pull',
  ],
};
// Every Inspect panel is its own tile (STUDIO-LAYOUT-T2): ids built from the tile id.
const TILES = ['monitor', 'flow', 'remote', 'node', 'tree', 'selector', 'state', 'actions', 'network'];
const per = (prefix, suffix = '') => TILES.map((t) => `${prefix}${t}${suffix}`);
// Ids built from a template: [file, template in source, expanded ids].
const DYNAMIC = [
  ['App.svelte', 'data-testid="nav-{p.id}"', ['nav-inspect', 'nav-runs', 'nav-record', 'nav-devices', 'nav-profile', 'nav-settings']],
  ['lib/pages/Profile.svelte', 'data-testid="profile-console-{c.replace(', ['profile-console-free', 'profile-console-sgperf-start', 'profile-console-sgperf-report', 'profile-console-sgperf-stop', 'profile-console-loaded-textures', 'profile-console-fps-display-on', 'profile-console-fps-display-off', 'profile-console-logrendezvous-on', 'profile-console-logrendezvous-off']],
  ['lib/ContextMenu.svelte', "testid: 'menu-inspect-state'", ['menu-inspect-state']],
  ['App.svelte', 'data-testid="tiles-menu-item-{id}"', per('tiles-menu-item-')],
  ['App.svelte', 'data-testid="tiles-restore-{id}"', per('tiles-restore-')],
  ['lib/Network.svelte', 'data-testid="net-row"', ['net-row']],
  ['lib/NetDetail.svelte', "data-testid={'net-detail-tab-' + k}", ['net-detail-tab-headers', 'net-detail-tab-payload', 'net-detail-tab-response']],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}"', per('tile-')],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}-handle"', per('tile-', '-handle')],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}-minimize"', per('tile-', '-minimize')],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}-menu"', per('tile-', '-menu')],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}-hide"', per('tile-', '-hide')],
  ['lib/Tile.svelte', 'data-testid="tile-{tile.id}-resize"', per('tile-', '-resize')],
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
  it('the tile ids match the registry', () => {
    const reg = read('lib/tiles.js');
    const ids = [...reg.matchAll(/^\s{4}(\w+): \{ title:/gm)].map((m) => m[1]);
    expect(ids).toEqual(TILES);
  });
  it('the nav ids match the page list', () => {
    const pages = [...read('App.svelte').matchAll(/\{ id: '(\w+)', label:/g)].map((m) => `nav-${m[1]}`);
    expect(pages).toEqual(DYNAMIC[0][2]);
  });
  it('Stop keeps its accessible name, shortcut and 409 handling (STUDIO-STOP-T2)', () => {
    const app = read('App.svelte')
    expect(app).toMatch(/data-testid="flow-stop" aria-label="Stop run"/)
    expect(app).toContain("e.key === '.'") // Mod+. at window level; Escape stays with the editor
    expect(app).toContain('RUN_IN_PROGRESS')
    expect(read('lib/Editor.svelte')).toContain("key: 'Mod-.'")
    expect(read('lib/api.js')).toContain("'/api/run/stop'")
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
