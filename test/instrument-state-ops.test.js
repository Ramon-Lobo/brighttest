import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStateOps, checkSize, diffLayers, loggable, StateOpsError, MAX_STATE_BYTES } = require('../lib/instrument/state-ops.js');

function mk(o = {}) { return createStateOps({ session: 's1', ...o }); }
function send(ops, seq, extra = {}, now = 0) {
  return ops.track({ id: `c-${seq}`, seq, op: 'set', ...extra }, { now, ack: extra.ack });
}
const ack = (seq, phase, more = {}) => ({ id: `c-${seq}`, seq, phase, ok: true, ...more });

describe('state-ops seq/ack (TP-STA-10)', () => {
  it('in-order acks: 3 commands reach done in seq order', () => {
    const ops = mk();
    [1, 2, 3].forEach((s) => send(ops, s));
    for (const s of [1, 2, 3]) {
      expect(ops.onAck(ack(s, 'received')).cmd.status).toBe('pending');
      expect(ops.onAck(ack(s, 'applied')).cmd.status).toBe('done');
    }
    expect(ops.pending).toBe(0);
    expect(ops.gaps).toEqual([]);
  });

  it('waits for reflected when asked', () => {
    const ops = mk();
    send(ops, 1, { ack: 'reflected' });
    expect(ops.onAck(ack(1, 'applied')).cmd.status).toBe('pending');
    expect(ops.onAck(ack(1, 'reflected', { hash: 'h' })).cmd).toMatchObject({ status: 'done', hash: 'h' });
  });

  it('gap: an applied ack for a later seq flags the earlier open one as missing, and a late ack is out of order', () => {
    const ops = mk();
    [1, 2, 3].forEach((s) => send(ops, s));
    ops.onAck(ack(1, 'applied'));
    ops.onAck(ack(3, 'applied'));
    expect(ops.missing()).toEqual([2]);
    ops.onAck(ack(2, 'applied'));
    expect(ops.gaps).toEqual([2]);
    expect(ops.counters.outOfOrder).toBe(1);
  });

  it('seqs must strictly increase when tracked', () => {
    const ops = mk();
    send(ops, 5);
    expect(() => send(ops, 5, { id: 'x' })).toThrow(StateOpsError);
    expect(() => ops.track({ id: 'dup', seq: 4, op: 'set' })).toThrow(/does not follow/);
  });

  it('duplicate ack is ignored and changes nothing', () => {
    const ops = mk();
    send(ops, 1);
    ops.onAck(ack(1, 'applied', { result: 7 }));
    const again = ops.onAck(ack(1, 'applied', { result: 99 }));
    expect(again.kind).toBe('duplicate');
    expect(ops.get('c-1').result).toBe(7);
    expect(ops.onAck(ack(1, 'received')).kind).toBe('duplicate'); // an older phase after a newer one
    expect(ops.counters.duplicates).toBe(2);
  });

  it('unknown id and invalid phase are refused', () => {
    const ops = mk();
    expect(ops.onAck(ack(9, 'applied')).kind).toBe('unknown');
    expect(ops.onAck({ id: 'c-1', phase: 'bogus' }).kind).toBe('invalid');
  });

  it('failed applied ack marks the command failed with the error', () => {
    const ops = mk();
    send(ops, 1);
    expect(ops.onAck(ack(1, 'applied', { ok: false, error: 'type mismatch' })).cmd).toMatchObject({ status: 'failed', ok: false, error: 'type mismatch' });
  });

  it('timeout per phase: received, then applied, each once', () => {
    const ops = mk({ timeouts: { received: 100, applied: 500, reflected: 900 } });
    send(ops, 1, {}, 0);
    send(ops, 2, {}, 0);
    ops.onAck(ack(2, 'received'));
    expect(ops.tick(99)).toEqual([]);
    const t1 = ops.tick(100);
    expect(t1.map((c) => c.id)).toEqual(['c-1']);
    expect(t1[0].error).toMatch(/received/);
    expect(ops.tick(100)).toEqual([]); // not twice
    const t2 = ops.tick(500);
    expect(t2[0].id).toBe('c-2');
    expect(t2[0].error).toMatch(/applied/);
  });

  it('reflected timeout names the reflected phase', () => {
    const ops = mk({ timeouts: { received: 10, applied: 20, reflected: 30 } });
    send(ops, 1, { ack: 'reflected' }, 0);
    ops.onAck(ack(1, 'applied'));
    expect(ops.tick(30)[0].error).toMatch(/reflected/);
  });

  it('a late ack after timeout still completes the command', () => {
    const ops = mk({ timeouts: { received: 1, applied: 1, reflected: 1 } });
    send(ops, 1, {}, 0);
    ops.tick(5);
    expect(ops.onAck(ack(1, 'applied')).cmd.status).toBe('done');
  });

  it('409 resync: session mismatch is answered, open commands are abandoned and never replayed twice', () => {
    const ops = mk();
    [1, 2].forEach((s) => send(ops, s));
    ops.onAck(ack(1, 'applied'));
    expect(ops.onAck({ ...ack(2, 'applied'), session: 'old' })).toEqual({ kind: 'resync', session: 's1' });
    expect(ops.get('c-2').status).toBe('pending');
    const dropped = ops.resync('s2');
    expect(dropped.map((c) => c.id)).toEqual(['c-2']);
    expect(ops.session).toBe('s2');
    expect(ops.resync('s2')).toEqual([]); // second resync abandons nothing
    expect(ops.get('c-1').status).toBe('done'); // finished work is untouched
    expect(ops.onAck({ ...ack(2, 'applied'), session: 's2' }).kind).toBe('duplicate'); // late ack for an abandoned command does not revive it
    expect(ops.get('c-2').status).toBe('abandoned');
    expect(ops.pending).toBe(0);
  });

  it('prepare validates op, args, ack and size', () => {
    const ops = mk();
    expect(ops.prepare({ op: 'set', args: { layer: 'global', path: 'a', value: 1 } })).toMatchObject({ op: 'set', ack: 'applied' });
    expect(() => ops.prepare({ op: 'eval' })).toThrow(/op not allowed/);
    expect(() => ops.prepare({ op: 'set', args: [] })).toThrow(/args/);
    expect(() => ops.prepare({ op: 'set', ack: 'later' })).toThrow(/ack/);
    expect(() => ops.prepare({ op: 'set', args: { value: 'x'.repeat(MAX_STATE_BYTES) } })).toThrow(expect.objectContaining({ code: 'STATE_TOO_LARGE' }));
  });

  it('checkSize rejects over the cap, never truncates', () => {
    expect(checkSize('x'.repeat(MAX_STATE_BYTES))).toBe(MAX_STATE_BYTES);
    expect(() => checkSize('x'.repeat(MAX_STATE_BYTES + 1))).toThrow(/nothing is truncated/);
  });

  it('keeps open commands when trimming tracked history', () => {
    const ops = mk({ maxTracked: 2 });
    send(ops, 1); send(ops, 2); send(ops, 3);
    expect(ops.list().length).toBe(3); // all pending, none dropped
    ops.onAck(ack(1, 'applied'));
    send(ops, 4);
    expect(ops.get('c-1')).toBeNull();
  });
});

describe('state-ops snapshot store and layer-scoped diff (TP-STA-10)', () => {
  const L1 = { global: { user: { tier: 'free', n: 1 }, gone: true }, registry: { app: { k: 'v' } } };
  const L2 = { global: { user: { tier: 'premium', n: 1 }, added: [1] }, registry: { app: { k: 'v' } } };

  it('snapshot store saves a copy, lists, deletes, and refuses oversized snapshots', () => {
    const ops = mk();
    const src = JSON.parse(JSON.stringify(L1));
    ops.saveSnapshot('s1', src, 10);
    src.global.user.tier = 'mutated';
    expect(ops.getSnapshot('s1')).toEqual(L1);
    expect(ops.listSnapshots()).toEqual([{ name: 's1', at: 10 }]);
    expect(() => ops.saveSnapshot('big', { global: { v: 'x'.repeat(MAX_STATE_BYTES) } })).toThrow(expect.objectContaining({ code: 'STATE_TOO_LARGE' }));
    expect(ops.getSnapshot('nope')).toBeNull();
    expect(ops.deleteSnapshot('s1')).toBe(true);
  });

  it('store is bounded', () => {
    const ops = mk();
    for (let i = 0; i < 20; i++) ops.saveSnapshot(`s${i}`, { global: {} });
    expect(() => ops.saveSnapshot('extra', { global: {} })).toThrow(expect.objectContaining({ code: 'STORE_FULL' }));
    ops.saveSnapshot('s0', { global: { again: 1 } }); // overwrite is fine
  });

  it('diff is layer-scoped, sorted, with set and del ops', () => {
    expect(diffLayers(L1, L2)).toEqual([
      { op: 'del', layer: 'global', path: 'gone' },
      { op: 'set', layer: 'global', path: 'added', value: [1] },
      { op: 'set', layer: 'global', path: 'user.tier', value: 'premium' },
    ]);
    expect(diffLayers(L1, L2, { layers: ['registry'] })).toEqual([]);
    expect(diffLayers(L1, L1)).toEqual([]);
  });

  it('diff handles a whole layer appearing or vanishing, and diffSnapshots', () => {
    expect(diffLayers({ a: { x: 1 } }, { b: { y: 2 } })).toEqual([
      { op: 'del', layer: 'a', path: '' },
      { op: 'set', layer: 'b', path: '', value: { y: 2 } },
    ]);
    const ops = mk();
    ops.saveSnapshot('a', L1); ops.saveSnapshot('b', L2);
    expect(ops.diffSnapshots('a', 'b', { layers: ['global'] }).length).toBe(3);
    expect(() => ops.diffSnapshots('a', 'zz')).toThrow(/not found/);
  });

  it('loggable masks sensitive path segments and configured paths', () => {
    const c = { id: 'c-1', seq: 1, op: 'set' };
    expect(loggable({ ...c, args: { layer: 'global', path: 'user.authToken', value: 'dummy-secret-1' } }).args.value).toBe('<redacted:authToken>');
    expect(loggable({ ...c, args: { layer: 'global', path: 'user.tier', value: 'premium' } }).args.value).toBe('premium');
    expect(loggable({ ...c, args: { layer: 'global', path: 'user.email', value: 'a@b.c' } }, ['global.user.email']).args.value).toBe('<redacted:email>');
    expect(loggable({ ...c, args: { layer: 'global', path: 'session.id', value: 'dummy-sess' } }).args.value).toBe('<redacted:session>');
  });
});
