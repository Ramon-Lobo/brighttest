import { describe, it, expect } from 'vitest';

const base = { overlay: true, page: 'inspect', tab: 'net', stateFallback: false, live: true, sim: false, lease: null };

describe('studio tree policy', () => {
  it('polls when the overlay is on, at 300 ms', async () => {
    const { treeNeeded, treeIntervalMs } = await import('../lib/studio/web/src/lib/treepolicy.js');
    expect(treeNeeded({ ...base, tab: 'actions' })).toBe(true);
    expect(treeNeeded({ ...base, page: 'record' })).toBe(true);
    expect(treeIntervalMs({ overlay: true })).toBe(300);
  });

  it('with the overlay off, polls only for panels that show tree data, at 1 s', async () => {
    const { treeNeeded, treeIntervalMs } = await import('../lib/studio/web/src/lib/treepolicy.js');
    const off = { ...base, overlay: false };
    for (const tab of ['node', 'tree', 'selector']) expect(treeNeeded({ ...off, tab })).toBe(true);
    for (const tab of ['net', 'actions', 'state']) expect(treeNeeded({ ...off, tab })).toBe(false);
    expect(treeNeeded({ ...off, tab: 'state', stateFallback: true })).toBe(true);
    expect(treeNeeded({ ...off, page: 'record', tab: 'node' })).toBe(false);
    expect(treeIntervalMs(off)).toBe(1000);
  });

  it('never polls without a live device view', async () => {
    const { treeNeeded } = await import('../lib/studio/web/src/lib/treepolicy.js');
    expect(treeNeeded({ ...base, live: false })).toBe(false);
    expect(treeNeeded({ ...base, sim: true })).toBe(false);
    expect(treeNeeded({ ...base, lease: { code: 'LOCKED' } })).toBe(false);
    expect(treeNeeded({ ...base, page: 'runs' })).toBe(false);
  });

  it('remembers the switch and tolerates unreadable storage', async () => {
    const { loadOverlay, saveOverlay, OVERLAY_KEY } = await import('../lib/studio/web/src/lib/treepolicy.js');
    const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } }; };
    const s = mem();
    expect(loadOverlay(s)).toBe(true);
    saveOverlay(s, false);
    expect(s.getItem(OVERLAY_KEY)).toBe('{"v":1,"on":false}');
    expect(loadOverlay(s)).toBe(false);
    saveOverlay(s, true);
    expect(loadOverlay(s)).toBe(true);
    s.setItem(OVERLAY_KEY, 'not json');
    expect(loadOverlay(s)).toBe(true);
    const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadOverlay(bad)).toBe(true);
    expect(() => saveOverlay(bad, false)).not.toThrow();
    expect(loadOverlay(null)).toBe(true);
  });

  it('takes the visible panels instead of one tab', async () => {
    const { treeNeeded, panelNeedsTree, visiblePanels } = await import('../lib/studio/web/src/lib/treepolicy.js');
    const off = { ...base, overlay: false, tab: undefined };
    expect(treeNeeded({ ...off, visiblePanels: [] })).toBe(false);
    expect(treeNeeded({ ...off, visiblePanels: ['network', 'actions'] })).toBe(false);
    expect(treeNeeded({ ...off, visiblePanels: ['network', 'selector'] })).toBe(true);
    expect(treeNeeded({ ...off, visiblePanels: ['state'] })).toBe(false);
    expect(treeNeeded({ ...off, visiblePanels: ['state'], stateFallback: true })).toBe(true);
    expect(panelNeedsTree({ page: 'record', visiblePanels: ['node'] })).toBe(false);
    const layout = [
      { id: 'node', state: 'open' }, { id: 'tree', state: 'min' }, { id: 'state', state: 'hidden' },
      { id: 'monitor', state: 'open' }, { id: 'flow', state: 'open' }, { id: 'network', state: 'open' },
    ];
    expect(visiblePanels(layout)).toEqual(['node', 'network']); // only open inspector panels
  });

  it('stops screenshots and overlay tree reads while the monitor tile is not on screen', async () => {
    const { shotNeeded, treeNeeded, treeIntervalMs, monitorVisible } = await import('../lib/studio/web/src/lib/treepolicy.js');
    const s = { page: 'inspect', live: true, sim: false, lease: null };
    expect(shotNeeded({ ...s, monitor: true })).toBe(true);
    expect(shotNeeded({ ...s, monitor: false })).toBe(false);
    expect(shotNeeded({ ...s })).toBe(true);
    expect(shotNeeded({ ...s, page: 'record', monitor: false })).toBe(true); // Record has its own monitor
    expect(shotNeeded({ ...s, page: 'runs', monitor: true })).toBe(false);
    expect(shotNeeded({ ...s, live: false })).toBe(false);
    expect(shotNeeded({ ...s, sim: true })).toBe(false);
    expect(shotNeeded({ ...s, lease: { code: 'LOCKED' } })).toBe(false);
    const t = { ...base, tab: undefined, visiblePanels: ['actions'] };
    expect(treeNeeded({ ...t, monitor: false })).toBe(false); // overlay on, but nowhere to draw it
    expect(treeNeeded({ ...t, monitor: false, page: 'record' })).toBe(true);
    expect(treeNeeded({ ...t, monitor: false, visiblePanels: ['node'] })).toBe(true);
    expect(treeIntervalMs({ overlay: true, monitor: false })).toBe(1000);
    expect(monitorVisible([{ id: 'monitor', state: 'open' }])).toBe(true);
    for (const state of ['min', 'hidden']) expect(monitorVisible([{ id: 'monitor', state }])).toBe(false);
  });
});
