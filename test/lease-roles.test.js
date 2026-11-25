import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as R from '../lib/studio/web/src/lib/leaseRoles.js';

const require = createRequire(import.meta.url);
const T = require('../lib/tui.js');
const CSS = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'studio', 'web', 'src', 'app.css'), 'utf8');

// The terminal board and the Studio board share one role map. The token hexes are checked against app.css in
// test/tui.test.js (drift test); this test keeps the Studio copy of the role names equal to lib/tui.js.
describe('lease roles (Studio copy of lib/tui.js ROLES)', () => {
  it('equals the CJS ROLES', () => { expect({ ...R.ROLES }).toEqual({ ...T.ROLES }); });
  it('resolves every role to a class that exists as a token in app.css', () => {
    for (const role of Object.keys(T.ROLES)) {
      const tok = R.tokenOf(role);
      expect(T.TOKENS[tok], `${role} -> ${tok}`).toBeTruthy();
      expect(R.textClass(role)).toBe(`text-${tok}`);
      expect(R.bgClass(role)).toBe(`bg-${tok}`);
      expect(CSS).toMatch(new RegExp(`--color-${tok}:`));
    }
  });
  it('maps run outcomes like the terminal board', () => {
    expect(R.runOutcome({ ended: 'released', exitCode: 0 })).toEqual({ role: 'runOk', text: 'ok' });
    expect(R.runOutcome({ ended: 'released', exitCode: 3 })).toEqual({ role: 'runFailed', text: 'exit 3' });
    expect(R.runOutcome({ ended: 'running' }).role).toBe('running');
    expect(R.runOutcome({ ended: 'timeout' })).toEqual({ role: 'runFailed', text: 'gave up' });
    expect(R.runOutcome({ ended: 'unknown' }).role).toBe('meta');
  });
  it('formats durations', () => {
    expect(R.fmtDur(42000)).toBe('42s'); expect(R.fmtDur(185000)).toBe('3m 05s'); expect(R.fmtDur(3720000)).toBe('1h 02m'); expect(R.fmtDur(null)).toBe('-');
  });
});
