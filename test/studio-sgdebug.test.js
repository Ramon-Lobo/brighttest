import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const sgdebug = require('../lib/studio/sgdebug.js');

// A local TCP server standing in for the Roku's port-8080 console: sends a banner on connect, echoes
// the command, then streams a canned response. Exercises the real socket path incl. quiet-gap logic.
let server;
const socks = new Set();
const track = (sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); };
function fakeConsole(response, { echo = true, banner = 'SceneGraph Debug Console', split = false } = {}) {
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      track(sock);
      if (split) { sock.write(banner.slice(0, 7)); setTimeout(() => sock.write(banner.slice(7) + '\r\n>'), 20); }
      else sock.write(banner + '\r\n>');
      sock.on('data', (d) => {
        const cmd = d.toString().trim();
        setTimeout(() => {
          if (echo) sock.write(cmd + '\r\n');
          sock.write(response + '\r\n>');
        }, 50);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
// Force-destroy any surviving connections before closing — server.close() otherwise waits (and the
// hook times out) on a socket the client abandoned.
afterEach(() => new Promise((r) => {
  for (const s of socks) s.destroy();
  socks.clear();
  if (!server) return r();
  const srv = server; server = null;
  srv.close(() => r());
}));

describe('sgdebug console client', () => {
  it('sends a whitelisted command and collects the response past the echo', async () => {
    const port = await fakeConsole('mem: 123456 KiB free');
    const { raw } = await sgdebug.run('127.0.0.1', 'free', { port, quietMs: 200 });
    expect(raw).toContain('123456');
    expect(raw).not.toContain('SceneGraph Debug Console'); // banner trimmed
  });

  const FAKE_BANNER = 'X0000000000A (Roku Ultra - 16.0.4.853)';

  it('strips the device banner (serial) from raw, with and without echo', async () => {
    for (const echo of [true, false]) {
      const port = await fakeConsole('mem: 5 KiB free', { echo, banner: FAKE_BANNER });
      const { raw } = await sgdebug.run('127.0.0.1', 'free', { port, quietMs: 200 });
      expect(raw).not.toContain('X0000000000A');
      expect(raw).not.toContain('Roku Ultra');
      expect(raw).toBe('mem: 5 KiB free');
      await new Promise((r) => { for (const s of socks) s.destroy(); server.close(r); server = null; });
    }
  });

  it('strips a banner split across two TCP chunks and via query()', async () => {
    const port = await fakeConsole('mem: 5 KiB free', { banner: FAKE_BANNER, split: true });
    const r = await sgdebug.query('127.0.0.1', 'free', { port, quietMs: 200 });
    expect(JSON.stringify(r)).not.toContain('X0000000000A');
  });

  it('stripBanner removes only the banner line (device-shaped fixture, no echo)', () => {
    const raw = `${FAKE_BANNER}\r\n>channel: mem=1KiB{anon=1}\r\nserial-like X0000000000A in output`;
    expect(sgdebug.stripBanner(raw)).toBe('>channel: mem=1KiB{anon=1}\r\nserial-like X0000000000A in output');
    expect(sgdebug.stripBanner('no banner here\n>')).toBe('no banner here\n>'); // old firmware: unchanged
  });

  it('rejects commands not on the whitelist', async () => {
    await expect(sgdebug.run('127.0.0.1', 'rm -rf /', { port: 1 })).rejects.toThrow(/unknown console command/);
    expect(sgdebug.COMMANDS['sgperf_report']).toBe('sgperf report');
  });

  it('has no logrendezvous status command; on/off stay mapped', () => {
    expect(Object.keys(sgdebug.COMMANDS).filter((k) => k.startsWith('logrendezvous')).sort())
      .toEqual(['logrendezvous_off', 'logrendezvous_on']);
    expect(sgdebug.COMMANDS.logrendezvous_on).toBe('logrendezvous on');
    expect(sgdebug.COMMANDS.logrendezvous_off).toBe('logrendezvous off');
    expect(Object.values(sgdebug.COMMANDS)).not.toContain('logrendezvous status');
  });

  it('times out cleanly against a silent server', async () => {
    const port = await new Promise((resolve) => {
      server = net.createServer((sock) => track(sock)); // accept, say nothing
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    await expect(sgdebug.run('127.0.0.1', 'free', { port, quietMs: 100, timeoutMs: 500 }))
      .rejects.toThrow(/timed out/);
  });

  it('fails fast on a refused connection', async () => {
    await expect(sgdebug.run('127.0.0.1', 'free', { port: 1, timeoutMs: 2000 })).rejects.toThrow();
  });
});

// Transcript-driven fake modelled on a recorded fw-16 session (generic channel names): the console
// logs every received line, `target <n>` moves the `*`, and sgperf output is per-thread stats.
const TARGET_LIST = (sel) => ['main', 'Native UI', 'Live TV Guide', 'Sample Channel', 'Backdrops']
  .map((n, i) => `${i === sel ? '*' : ' '} [${i}] ${n}`).join('\r\n');
function transcriptConsole(received, { banner = 'X0000000000A (Roku Ultra - 16.0.4.853)', targetOutput, names, stub = false } = {}) {
  const list = (sel) => (names ? names.map((n, i) => `${i === sel ? '*' : ' '} [${i}] ${n}`).join('\r\n') : TARGET_LIST(sel));
  let sel = 0;
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      track(sock);
      sock.write(banner + '\r\n>');
      sock.on('data', (d) => {
        for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
          received.push(line);
          let out = '';
          if (line === 'target list') out = list(sel);
          else if (line.startsWith('target ')) { sel = Number(line.slice(7)); out = targetOutput ?? list(sel); }
          else if (stub && sel !== 0 && !['help', 'free', 'plugins', 'chanperf', 'sgnodes', 'showkey'].includes(line)) out = 'Command not recognized';
          else if (line === 'sgperf report') out = sel === 0 ? '' : 'thread node calls: create  1201 + op   902  @   0.0% rendezvous';
          setTimeout(() => sock.write(line + '\r\n' + out + '\r\n>'), 30);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('channel target selection (BUG-B1; device check pending DQ-1)', () => {
  it('sends target list, target <n>, then the command, and never leaks the serial', async () => {
    const received = [];
    const port = await transcriptConsole(received);
    const r = await sgdebug.query('127.0.0.1', 'sgperf_report', { port, quietMs: 120, channel: 'Sample Channel' });
    expect(received).toEqual(['target list', 'target 3', 'sgperf report']);
    expect(r.raw).toBe('thread node calls: create  1201 + op   902  @   0.0% rendezvous');
    expect(r.parsed.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('X0000000000A');
  });

  it('stub target (listed but not running): rejects with an explicit error', async () => {
    const received = [];
    const port = await transcriptConsole(received, { stub: true });
    await expect(sgdebug.run('127.0.0.1', 'sgperf_report', { port, quietMs: 120, channel: 'Sample Channel' }))
      .rejects.toThrow(/not running|stub/);
    expect(received).toEqual(['target list', 'target 3', 'sgperf report']);
  });

  it('stub error also covers loaded_textures and names the target title', async () => {
    const port = await transcriptConsole([], { stub: true });
    await expect(sgdebug.run('127.0.0.1', 'loaded_textures', { port, quietMs: 120, channel: 'Sample Channel' }))
      .rejects.toThrow(/target "Sample Channel" answered "Command not recognized"/);
  });

  it('index instability: swapped list order sends a different index and still works', async () => {
    const a = [];
    let port = await transcriptConsole(a, { names: ['main', 'Native UI', 'Sample Channel', 'Backdrops', 'Media Hub'] });
    await sgdebug.run('127.0.0.1', 'sgperf_report', { port, quietMs: 120, channel: 'Sample Channel' });
    await new Promise((r) => { for (const s of socks) s.destroy(); server.close(r); server = null; });
    const b = [];
    port = await transcriptConsole(b, { names: ['main', 'Native UI', 'Media Hub', 'Backdrops', 'Sample Channel'] });
    const r = await sgdebug.run('127.0.0.1', 'sgperf_report', { port, quietMs: 120, channel: 'Sample Channel' });
    expect(a).toEqual(['target list', 'target 2', 'sgperf report']);
    expect(b).toEqual(['target list', 'target 4', 'sgperf report']);
    expect(r.raw).toContain('thread node calls');
  });

  it('does not select a target for global commands or when no channel is given', async () => {
    const received = [];
    const port = await transcriptConsole(received);
    await sgdebug.run('127.0.0.1', 'free', { port, quietMs: 100, channel: 'Sample Channel' });
    await sgdebug.run('127.0.0.1', 'sgperf_report', { port, quietMs: 100 });
    expect(received).toEqual(['free', 'sgperf report']);
  });

  it('errors clearly when the channel is not in the target list', async () => {
    const received = [];
    const port = await transcriptConsole(received);
    await expect(sgdebug.run('127.0.0.1', 'chanperf', { port, quietMs: 100, channel: 'Nope' }))
      .rejects.toThrow(/target not found for channel "Nope".*Sample Channel/);
    expect(received).toEqual(['target list']);
  });

  it('parseTargets / pickTarget handle the list shape; main is never a channel match', () => {
    const t = sgdebug.parseTargets(TARGET_LIST(3));
    expect(t).toHaveLength(5);
    expect(t[3]).toEqual({ index: 3, name: 'Sample Channel', selected: true });
    expect(sgdebug.pickTarget(t, 'sample channel').index).toBe(3);
    expect(sgdebug.pickTarget(t, 'main')).toBeNull();
    expect(sgdebug.pickTarget(t, 'Sample Channel (dev)').index).toBe(3);
  });
});

describe('tolerant console parsers (formats vary per firmware — pin these against a live device)', () => {
  it('parseFree extracts labelled byte figures with units', () => {
    const r = sgdebug.parseFree('Available: 316,244 KiB\nIn use: 83,124 KiB\njunk line');
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([
      { label: 'Available', bytes: 316244 * 1024 },
      { label: 'In use', bytes: 83124 * 1024 },
    ]);
  });

  it('parseSgperf pulls thread create/op/rendezvous shapes and keeps the rest as `other`', () => {
    const raw = [
      'thread node operations for thread: render  1234 creates 5678 ops 2.5% rendezvous',
      'thread node operations for thread: Task-12  10 creates 44 ops 91.0% rendezvous',
      'some unrecognised counter: 42',
    ].join('\n');
    const r = sgdebug.parseSgperf(raw);
    expect(r.ok).toBe(true);
    expect(r.threads).toHaveLength(2);
    expect(r.threads[0].creates).toBe(1234);
    expect(r.threads[1].rendezvousPct).toBe(91);
    expect(r.other).toContain('some unrecognised counter: 42');
  });

  it('parseSgperf parses `thread node calls: create N + op M @ P% rendezvous` lines', () => {
    const raw = [
      '>',
      'thread node calls: create     0 + op     1  @ 100.0% rendezvous',
      'thread node calls: create  1,201 + op   902  @   0.0% rendezvous',
      'thread node calls: create 7 + op 9',
    ].join('\n');
    const r = sgdebug.parseSgperf(raw);
    expect(r.ok).toBe(true);
    expect(r.threads).toHaveLength(3);
    expect(r.threads[0]).toMatchObject({ kind: 'node-calls', creates: 0, ops: 1, rendezvousPct: 100 });
    expect(r.threads[1]).toMatchObject({ creates: 1201, ops: 902, rendezvousPct: 0 });
    expect(r.threads[2]).toMatchObject({ creates: 7, ops: 9, rendezvousPct: null });
    expect(r.other).toEqual([]);
  });

  it('parseChanperf parses the recorded 8080 line (mem, anon, file, shared, swap, cpu, user, sys)', () => {
    const r = sgdebug.parseChanperf('channel: mem=28460KiB{anon=7288,file=20992,shared=180,swap=0},%cpu=0{user=0,sys=0}');
    expect(r).toEqual({ ok: true, mem: 28460, anon: 7288, file: 20992, shared: 180, swap: 0, cpu: 0, user: 0, sys: 0 });
    // device-shaped: banner + prompt prefix still parses; non-zero CPU
    expect(sgdebug.parseChanperf('>channel: mem=100KiB{anon=1,file=2,shared=3,swap=4},%cpu=12{user=9,sys=3}').cpu).toBe(12);
  });

  it('parseChanperf reports the "not available" line as ok:false, never throws', () => {
    expect(sgdebug.parseChanperf('channel: mem and cpu data not available')).toEqual({ ok: false, error: 'mem and cpu data not available' });
    expect(sgdebug.parseChanperf('').ok).toBe(false);
  });

  it('query() wires chanperf to the parser (parsed not null)', async () => {
    const port = await fakeConsole('channel: mem=28460KiB{anon=7288,file=20992,shared=180,swap=0},%cpu=0{user=0,sys=0}');
    const r = await sgdebug.query('127.0.0.1', 'chanperf', { port, quietMs: 150 });
    expect(r.parsed).not.toBeNull();
    expect(r.parsed.anon).toBe(7288);
  });

  it('parsers never throw on arbitrary text', () => {
    expect(sgdebug.parseFree('').ok).toBe(false);
    expect(sgdebug.parseSgperf('no numbers here').ok).toBe(false);
  });
});

// Reply status (BUG-B1b): replies are copied from a recorded session; `@@SEND <cmd>` starts each block.
const RECORDED = (() => {
  const text = fs.readFileSync(new URL('./fixtures/console-8080-replies.txt', import.meta.url), 'utf8');
  const out = {};
  for (const blk of text.split(/^@@SEND /m).slice(1)) {
    const nl = blk.indexOf('\n');
    out[blk.slice(0, nl).trim()] = blk.slice(nl + 1).replace(/\r?\n>\s*$/, '').replace(/^\n+/, '');
  }
  return out;
})();
const statusOf = async (name, reply) => {
  const port = await fakeConsole(reply);
  return sgdebug.query('127.0.0.1', name, { port, quietMs: 150 });
};

describe('console reply status (BUG-B1b)', () => {
  it('ok: sgperf report with thread stats keeps ok/parsed/raw', async () => {
    const r = await statusOf('sgperf_report', RECORDED['sgperf report']);
    expect(r).toMatchObject({ status: 'ok', reason: sgdebug.STATUS.ok.reason });
    expect(r.parsed.ok).toBe(true);
    expect(r.raw).toContain('thread node calls');
  });

  it('empty: sgperf report with no output', async () => {
    const r = await statusOf('sgperf_report', '');
    expect(r.status).toBe('empty');
    expect(r.reason).toBe(sgdebug.STATUS.empty.reason);
    expect(r.parsed.ok).toBe(false);
  });

  it('empty is the normal reply for sgperf start', async () => {
    expect((await statusOf('sgperf_start', '')).status).toBe('ok');
  });

  it('not-implemented: loaded_textures reply with a glyph table fills fonts', async () => {
    const r = await statusOf('loaded_textures', RECORDED['loaded_textures']);
    expect(r.status).toBe('not-implemented');
    expect(r.fonts.length).toBeGreaterThanOrEqual(1);
    expect(r.fonts[0]).toMatchObject({ family: 'Roku UI Regular', size: 34, file: '<SYSTEM FONT>' });
    expect(r.fonts[0].line).toBe('Roku UI Regular-34--                  <SYSTEM FONT>');
  });

  it('needs-scene-graph: loaded_textures on target main', async () => {
    const r = await statusOf('loaded_textures', RECORDED['loaded_textures (target main)']);
    expect(r.status).toBe('needs-scene-graph');
    expect(r.reason).toBe(sgdebug.STATUS.needsSceneGraph.reason);
  });

  it('unavailable: chanperf reply, parsed fields unchanged', async () => {
    const r = await statusOf('chanperf', RECORDED['chanperf']);
    expect(r.status).toBe('unavailable');
    expect(r.parsed).toEqual({ ok: false, error: 'mem and cpu data not available' });
  });

  it('ok: chanperf with a mem line', async () => {
    const r = await statusOf('chanperf', 'channel: mem=28460KiB{anon=7288,file=20992,shared=180,swap=0},%cpu=0{user=0,sys=0}');
    expect(r.status).toBe('ok');
  });

  it('matching is case-insensitive', () => {
    expect(sgdebug.classify('loaded_textures', 'NOT IMPLEMENTED').status).toBe('not-implemented');
  });

  it('stub-target: the error carries the status', async () => {
    const port = await transcriptConsole([], { stub: true });
    const err = await sgdebug.run('127.0.0.1', 'sgperf_report', { port, quietMs: 120, channel: 'Sample Channel' }).catch((e) => e);
    expect(err.status).toBe('stub-target');
    expect(err.reason).toBe(sgdebug.STATUS.stubTarget.reason);
  });

  it('needs-dev-channel: the recorded untargeted loaded_textures reply is not ok', async () => {
    const r = await statusOf('loaded_textures', RECORDED['loaded_textures (no developer channel)']);
    expect(r.status).toBe('needs-dev-channel');
    expect(r.reason).toContain('can only be used while a developer channel is running');
  });

  it('not-recognized: Command not recognized without a target selection', async () => {
    const r = await statusOf('sgperf_report', RECORDED['sgperf report (untargeted stub)']);
    expect(r.status).toBe('not-recognized');
  });

  it('a non-empty unrecognised reply to a normal-empty command is unknown', async () => {
    expect((await statusOf('sgperf_start', 'something unexpected')).status).toBe('unknown');
  });

  it('a command with no parser never claims "reply parsed"', async () => {
    const r = await statusOf('plugins', 'some plugin list');
    expect(r.status).toBe('ok');
    expect(r.reason).not.toBe(sgdebug.STATUS.ok.reason);
  });

  it('unknown fallback: unparsable chanperf text', () => {
    const r = sgdebug.classify('chanperf', 'garbage', sgdebug.parseChanperf('garbage'));
    expect(r.status).toBe('unknown');
  });

  it('empty reason does not claim the command was accepted', () => {
    expect(sgdebug.STATUS.empty.reason).toBe('no output came back before the quiet wait ended');
  });

  it('parseFonts stays fast on a 400 KB hostile line and caps rows', () => {
    const t0 = Date.now();
    const hostile = 'Family-Size-\n' + 'a-1-'.repeat(100000) + '\n';
    expect(sgdebug.parseFonts(hostile)).toEqual([]);
    const many = 'Family-Size-\n' + 'Roku UI Regular-34--   <SYSTEM FONT>\n'.repeat(5000);
    expect(sgdebug.parseFonts(many).length).toBeLessThanOrEqual(500);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
