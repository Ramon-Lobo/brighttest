import { describe, it, expect } from 'vitest';
import W from '../lib/device-watch.js';
import { NOW, makeBoard } from './support/watch-board.js';

const LINE = 'interactive: yields to waiters 60s after its last action; last action 12s ago';
const board = () => {
  const b = makeBoard();
  b.devices[0].holder = { ...b.devices[0].holder, interactive: LINE };
  return b;
};

describe('interactive holder line in the static outputs', () => {
  it('--once, --plain and non-TTY output name an interactive holder', () => {
    const b = board();
    for (const text of [W.renderOnce(b, { now: NOW, utc: true }), W.renderPlainBlock(b, { now: NOW, utc: true })]) {
      expect(text).toContain(`lab-a holder: ${LINE}`);
    }
  });
  it('a command holder adds no line', () => {
    expect(W.renderOnce(makeBoard(), { now: NOW, utc: true })).not.toContain(' holder: ');
  });
  it('the plain loop (non-TTY) prints it', async () => {
    const out = []; let t = NOW;
    const io = { stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, stdoutIsTTY: false, stdinIsTTY: false, env: {}, platform: 'linux', now: () => t, sleep: async (ms) => { t += ms; } };
    await W.runWatch({ view: { snapshot: board }, flags: { plain: true, forMs: 1 }, io });
    expect(out.join('')).toContain(`lab-a holder: ${LINE}`);
  });
});
