import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const sgdebug = require('../lib/studio/sgdebug.js');

// A local TCP server standing in for the Roku's port-8080 console: sends a banner on connect, echoes
// the command, then streams a canned response. Exercises the real socket path incl. quiet-gap logic.
let server;
const socks = new Set();
const track = (sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); };
function fakeConsole(response, { echo = true } = {}) {
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      track(sock);
      sock.write('SceneGraph Debug Console\r\n>');
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

  it('rejects commands not on the whitelist', async () => {
    await expect(sgdebug.run('127.0.0.1', 'rm -rf /', { port: 1 })).rejects.toThrow(/unknown console command/);
    expect(sgdebug.COMMANDS['sgperf_report']).toBe('sgperf report');
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

  it('parsers never throw on arbitrary text', () => {
    expect(sgdebug.parseFree('').ok).toBe(false);
    expect(sgdebug.parseSgperf('no numbers here').ok).toBe(false);
  });
});
