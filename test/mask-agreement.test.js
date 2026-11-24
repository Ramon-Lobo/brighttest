import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { makeShown } = require('../lib/e2e/appstate.js');
const { redact } = require('../lib/instrument/events.js');
const { loggable } = require('../lib/instrument/state-ops.js');

const SECRET = 'SECRET@x';
// Each case: masks, layer, path (dotted, as written to the device), value that holds a secret at that location.
const cases = [
  { name: 'layers. prefix', masks: ['layers.global.user.email'], layer: 'global', path: 'user', value: { name: 'n', email: SECRET } },
  { name: 'layers. prefix, leaf path', masks: ['layers.global.user.email'], layer: 'global', path: 'user.email', value: SECRET },
  { name: 'case differences', masks: ['Global.User.Email'], layer: 'global', path: 'user.email', value: SECRET },
  { name: 'case differences, layers.', masks: ['LAYERS.Global.user.EMAIL'], layer: 'global', path: 'user', value: { email: SECRET } },
  { name: 'bracket index', masks: ['global.list[1]'], layer: 'global', path: 'list', value: ['a', SECRET] },
  { name: 'bracket wildcard', masks: ['global.list[*]'], layer: 'global', path: 'list', value: [SECRET, SECRET] },
  { name: 'wildcard segment', masks: ['global.*.email'], layer: 'global', path: 'user', value: { email: SECRET } },
  { name: 'layers. + wildcard', masks: ['layers.*.user.email'], layer: 'global', path: 'user', value: { email: SECRET } },
];

describe('mask list agreement across hub redact, state-ops loggable and assertState makeShown', () => {
  for (const c of cases) {
    it(c.name, () => {
      const hub = JSON.stringify(redact({ layers: { [c.layer]: nest(c.path, c.value) } }, c.masks));
      const ops = JSON.stringify(loggable({ op: 'set', args: { layer: c.layer, path: c.path, value: c.value } }, c.masks));
      const shown = makeShown(true, c.masks)(c.layer, c.path, c.value);
      expect(hub).not.toContain(SECRET);
      expect(ops).not.toContain(SECRET);
      expect(shown).not.toContain(SECRET);
    });
  }
  it('an unmasked sibling stays visible in all three', () => {
    const masks = ['layers.global.user.email'];
    const v = { name: 'visible-n', email: SECRET };
    expect(JSON.stringify(redact({ layers: { global: { user: v } } }, masks))).toContain('visible-n');
    expect(JSON.stringify(loggable({ op: 'set', args: { layer: 'global', path: 'user', value: v } }, masks))).toContain('visible-n');
    expect(makeShown(true, masks)('global', 'user', v)).toContain('visible-n');
  });
});

function nest(path, value) {
  return path.split('.').reduceRight((acc, s) => ({ [s]: acc }), value);
}
