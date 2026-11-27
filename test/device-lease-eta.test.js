import { describe, it, expect } from 'vitest';
import L from '../lib/device-lease.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const studio = (extra = {}) => ({
  acquiredAt: ago(600000), expectMs: 60000, // a long-held Studio session, past the synthetic yield expectation
  holder: { command: ['brighttest', 'studio'], kind: 'interactive', yieldAfterMs: 60000, activityAt: ago(15000), busy: false, ...extra },
});

describe('computeEta with an interactive (Studio) holder', () => {
  it('uses the yield window since the last action, even when the session is older than the window', () => {
    const r = L.computeEta(studio(), [{ verb: 'e2e' }], [], NOW);
    expect(r.perTicket).toEqual([45000]);
    expect(r.overdueMs).toBeUndefined();
  });
  it('is 0 once the yield window has passed (it releases on the next check)', () => {
    expect(L.computeEta(studio({ activityAt: ago(90000) }), [{}], [], NOW).perTicket).toEqual([0]);
  });
  it('stays unknown while a run is in progress (busy)', () => {
    expect(L.computeEta(studio({ busy: true }), [{}], [], NOW).perTicket).toEqual([null]);
  });
  it('a command holder is unchanged', () => {
    const h = { acquiredAt: ago(50), expectMs: 150, holder: { purpose: 'x' } };
    expect(L.computeEta(h, [{}], [], NOW).perTicket).toEqual([100]);
  });
  it('the wait line gives an estimate, not "ETA unknown"', () => {
    const eta = L.computeEta(studio(), [{ verb: 'e2e' }], [], NOW);
    const line = L.formatWaitLine({
      key: 'k', holder: { ...studio(), deadline: new Date(NOW + 3600000).toISOString() }, queue: [{}], position: 2, etaMs: eta.perTicket[0], etaNote: null,
    });
    expect(line).toMatch(/est\. wait ~/);
    expect(line).not.toMatch(/ETA unknown/);
  });
});
