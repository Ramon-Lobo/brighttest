'use strict';
// Perfetto trace capture from a Roku device — the deepest profiling surface Roku exposes.
// Needs firmware that serves /perfetto-session; the minimum version is not asserted here (Studio gates on
// the device firmware it reads, see lib/studio/web Profile page). docs/maintainers.md does not record a
// Perfetto floor, so none is hard-coded.
//
// Protocol (as implemented by Roku's VS Code tooling; verified against roku-debug's PerfettoManager):
//   1. POST http://<device>:8060/perfetto/enable/<channelId>   — enable tracing for a channel. Must
//      happen BEFORE the channel launches; the response lists currently-enabled channels.
//   2. ws://<device>:8060/perfetto-session                     — the device streams binary Perfetto
//      trace packets (threads, scheduling, counters at ~250ms cadence). Append to a
//      .perfetto-trace file.
//   3. POST http://<device>:8060/perfetto/heapgraph/trigger/<channelId> — drop a HEAP GRAPH snapshot
//      into the active trace stream (per-object memory graph).
//
// The resulting file opens in https://ui.perfetto.dev — no Roku tooling needed to read it.
//
// Node 22's global WebSocket keeps this dependency-free. The Roku side stops streaming as soon as it
// receives a close frame but never completes the close handshake, so stop() waits for the stream to go
// quiet and then force-terminates (same workaround roku-debug uses).

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const state = require('./perfetto-state');
const { resolveEcpPort } = require('../devices');
const { defaultQueue } = require('../e2e/ecpq');
const { queueKey } = require('../e2e/ecp');

const QUIET_MS = 1200;   // stream silent this long after close → consider the device done
const CEILING_MS = 8000; // hard cap on waiting for quiet

const RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 2000;
const RESTART_DEADLINE_MS = 30000;

class PerfettoCapture extends EventEmitter {
  // esn: enables per-ESN persisted state (omit to skip persistence). stateDir: override ~/.brighttest.
  // autoRestart: re-enable and reopen the stream after an unexpected disconnect, bounded by
  // restartAttempts and restartDeadlineMs, then emit 'restart-failed' and stop trying.
  constructor({ host, channelId = 'dev', dir, ecpPort, esn, stateDir, staleMs, autoRestart = false,
    restartAttempts = RESTART_ATTEMPTS, restartDelayMs = RESTART_DELAY_MS, restartDeadlineMs = RESTART_DEADLINE_MS }) {
    super();
    this.esn = esn || null;
    this.stateDir = stateDir;
    this.staleMs = staleMs;
    this.autoRestart = autoRestart;
    this.restartAttempts = restartAttempts;
    this.restartDelayMs = restartDelayMs;
    this.restartDeadlineMs = restartDeadlineMs;
    this.stopping = false;
    this.restarting = false;
    this.host = host;
    this.ecpPort = resolveEcpPort(ecpPort);
    this.channelId = channelId;
    this.dir = dir;
    this.socket = null;
    this.filePath = null;
    this.bytes = 0;
    this.lastMessageAt = 0;
    this.error = null;
    this.enabledChannels = null; // null = enable never attempted/confirmed this session
    const rec = state.readState(this.esn, { dir: this.stateDir, staleMs: this.staleMs });
    this.persisted = rec; // fresh record from a previous Studio run, or null
  }

  // Enable unless a fresh persisted record already lists this channel (stale or missing -> POST).
  async ensureEnabled() {
    const rec = state.readState(this.esn, { dir: this.stateDir, staleMs: this.staleMs });
    if (rec && rec.channels.some((c) => c.toLowerCase() === this.channelId.toLowerCase())) {
      this.enabledChannels = rec.channels;
      return { enabledChannels: rec.channels, cached: true };
    }
    return this.enable();
  }

  get tracing() { return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN); }

  status() {
    return {
      supported: null, // filled by the caller from device firmware
      enabledChannels: this.enabledChannels,
      tracing: this.tracing,
      file: this.filePath ? path.basename(this.filePath) : null,
      bytes: this.bytes,
      error: this.error,
      files: this.listFiles(),
    };
  }

  listFiles() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.perfetto-trace'))
        .map((f) => ({ name: f, bytes: fs.statSync(path.join(this.dir, f)).size }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch { return []; }
  }

  // Resolve a trace filename inside the capture dir, refusing traversal.
  safeFile(name) {
    const full = path.resolve(this.dir, String(name || ''));
    if (!full.startsWith(this.dir + path.sep) || !full.endsWith('.perfetto-trace')) {
      throw Object.assign(new Error('bad trace file name'), { code: 'EPATH' });
    }
    return full;
  }

  // POST through the shared per-host queue so it never overlaps Studio's other ECP calls (ROB-01b).
  // Non-idempotent: retried only when provably undelivered.
  async _post(urlPath) {
    return defaultQueue.run(queueKey(this.host, this.ecpPort), defaultQueue.endpointKind(urlPath), async () => {
      const r = await fetch(`http://${this.host}:${this.ecpPort}${urlPath}`, { method: 'POST' });
      return { status: r.status, ok: r.ok, text: await r.text().catch(() => '') };
    }, { idempotent: false });
  }

  async enable() {
    const r = await this._post(`/perfetto/enable/${encodeURIComponent(this.channelId)}`);
    const text = r.text;
    // <enabled-channels><channel>dev</channel>…</enabled-channels>
    const channels = [...text.matchAll(/<channel>([^<]*)<\/channel>/g)].map((m) => m[1]);
    this.enabledChannels = channels;
    if (!r.ok) throw new Error(`perfetto enable: device answered HTTP ${r.status}`);
    if (!channels.map((c) => c.toLowerCase()).includes(this.channelId.toLowerCase())) {
      throw new Error(`device did not enable channel "${this.channelId}" (enabled: ${channels.join(', ') || 'none'}). ` +
        'Tracing must be enabled before the channel launches — enable, then relaunch the channel.');
    }
    state.writeState(this.esn, channels, { dir: this.stateDir });
    return { enabledChannels: channels };
  }

  async start() {
    if (this.tracing) throw new Error('already tracing');
    this.stopping = false;
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(this.dir, `trace-${stamp}.perfetto-trace`);
    this.bytes = 0;
    this.error = null;
    const stream = fs.createWriteStream(this.filePath);

    let opened = false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.ecpPort}/perfetto-session`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { opened = true; this.socket = ws; resolve(); };
      ws.onerror = () => {
        if (opened) return; // post-open errors are followed by onclose, which ends the stream
        // Open failed: release the trace file stream and remove the empty file it created.
        const file = this.filePath;
        this.socket = null;
        stream.once('close', () => { try { fs.unlinkSync(file); } catch { /* already gone */ } });
        stream.destroy();
        reject(new Error(`could not open perfetto-session on ${this.host}:${this.ecpPort} — needs tracing enabled for the channel and firmware that supports perfetto-session (see docs/maintainers.md)`));
      };
      ws.onmessage = (ev) => {
        const chunk = Buffer.from(ev.data);
        this.bytes += chunk.length;
        this.lastMessageAt = Date.now();
        stream.write(chunk);
      };
      ws.onclose = () => {
        stream.end();
        const dropped = this.socket === ws && !this.stopping;
        if (this.socket === ws) this.socket = null;
        if (dropped && this.autoRestart) this._restart();
      };
    });
    return { file: path.basename(this.filePath) };
  }

  async stop() {
    this.stopping = true;
    const ws = this.socket;
    if (!ws) return { file: this.filePath ? path.basename(this.filePath) : null, bytes: this.bytes };
    try { ws.close(); } catch { /* force-terminate below regardless */ }
    // Wait for the stream to go quiet (the device keeps flushing briefly after our close frame).
    const start = Date.now();
    while (Date.now() - start < CEILING_MS) {
      if (Date.now() - (this.lastMessageAt || 0) >= QUIET_MS) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.socket = null;
    return { file: this.filePath ? path.basename(this.filePath) : null, bytes: this.bytes };
  }

  // One bounded restart sequence after a dropped stream: re-enable (through the shared queue; this also
  // doubles as the reachability probe) and reopen the stream. Gives up after restartAttempts or
  // restartDeadlineMs, whichever comes first, and reports via 'restart-failed'.
  async _restart() {
    if (this.restarting) return;
    this.restarting = true;
    const deadline = Date.now() + this.restartDeadlineMs;
    this.error = 'perfetto stream dropped; restarting';
    let lastErr = null;
    try {
      for (let attempt = 1; attempt <= this.restartAttempts && !this.stopping; attempt++) {
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, this.restartDelayMs));
        if (this.stopping || Date.now() >= deadline) break;
        try {
          await this.enable();
          await this.start();
          this.error = null;
          this.emit('restarted', { attempt });
          return;
        } catch (e) { lastErr = e; }
      }
      if (!this.stopping) {
        this.error = `perfetto stream dropped; restart failed${lastErr ? `: ${lastErr.message}` : ''}`;
        this.emit('restart-failed', { error: this.error });
      }
    } finally { this.restarting = false; }
  }

  // Heap graph snapshots land in the ACTIVE trace, so require one.
  async heapSnapshot() {
    if (!this.tracing) throw new Error('start a trace first — heap snapshots are written into the active trace stream');
    const r = await this._post(`/perfetto/heapgraph/trigger/${encodeURIComponent(this.channelId)}`);
    if (!r.ok) throw new Error(`heap snapshot trigger: device answered HTTP ${r.status}`);
    // Give the device a beat to flush the graph into the stream (roku-debug waits 1s).
    await new Promise((s) => setTimeout(s, 1000));
    return { ok: true, bytes: this.bytes };
  }
}

module.exports = { PerfettoCapture, QUIET_MS };
