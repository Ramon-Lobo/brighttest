'use strict';
// Live performance collection for the studio's Profile page, over the two ECP surfaces a stock dev
// device exposes (verified against a Roku Ultra, fw 15.3.4, running a large production app):
//
//   • /query/chanperf     — the channel's CPU (user/sys %, over a ~1s window) and memory
//                           (used/anon/file/swap, plus the channel's memory limit).
//   • /query/r2d2-bitmaps — texture-memory usage per graphics instance plus every live bitmap
//                           (dev channels only; needs developer mode).
//
// A PerfSession polls both on an interval and keeps a flat sample array plus user markers ("pressed
// play", "opened details"), exportable as JSON or CSV. Markers are also added automatically when the
// studio sends a keypress mid-session, so remote interactions line up with the charts.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull <tag>value</tag> out of an XML fragment (Roku's perf XML is flat and attribute-free; a real
// XML dependency would be overkill — this matches the zero-dep parsing in sgnodes.js).
function tagNum(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// /query/chanperf → { ok, error?, cpu: { user, sys, durationS }, memory: { used, anon, file, swap, limit } }
// All memory figures in bytes. Returns ok:false (with the device's error string) while no channel runs.
function parseChanperf(xml) {
  const text = String(xml || '');
  if (/<status>\s*FAILED/i.test(text) || !/<plugin>/.test(text)) {
    const err = (text.match(/<error>([^<]*)<\/error>/) || [])[1] || 'no channel running';
    return { ok: false, error: err };
  }
  // proc-stat rides along in every chanperf response: cumulative CPU ticks (exact CPU% over any
  // window, independent of the device's ~1s sampling) and page-fault counters. majflt is the one to
  // watch — major faults hit storage and stall the channel; a climbing rate means memory pressure.
  const proc = (text.match(/<proc-stat>([\s\S]*?)<\/proc-stat>/) || [])[1] || '';
  return {
    ok: true,
    cpu: {
      user: tagNum(text, 'user'),
      sys: tagNum(text, 'sys'),
      durationS: tagNum(text, 'duration-seconds'),
    },
    memory: {
      used: tagNum(text, 'used'),
      anon: tagNum(text, 'anon'),
      file: tagNum(text, 'file'),
      swap: tagNum(text, 'swap'),
      limit: tagNum(text, 'limit'),
    },
    procStat: proc ? {
      utime: tagNum(proc, 'utime'),
      stime: tagNum(proc, 'stime'),
      minflt: tagNum(proc, 'minflt'),
      majflt: tagNum(proc, 'majflt'),
      clkTck: tagNum(proc, 'clk-tck'),
      state: (proc.match(/<state>([^<]*)<\/state>/) || [])[1] || null,
    } : null,
  };
}

// /query/r2d2-bitmaps → { ok, texture: { used, max, available }, systemMemory, bitmapCount }
// Sums across graphics instances (the device reports one per roGraphics context; the channel's is the
// one with non-zero use). NOTE: the firmware really does spell it "sytem-memory" — accept both.
function parseR2d2(xml) {
  const text = String(xml || '');
  if (!/<r2d2-bitmaps>/.test(text)) return { ok: false, error: 'no r2d2 data (developer mode required)' };
  let used = 0, max = 0, sysMem = 0;
  for (const m of text.matchAll(/<texture-memory>([\s\S]*?)<\/texture-memory>/g)) {
    used += tagNum(m[1], 'used') || 0;
    max = Math.max(max, tagNum(m[1], 'max') || 0);
  }
  for (const m of text.matchAll(/<s[iy]?[sy]?tem-memory>([\s\S]*?)<\/s[iy]?[sy]?tem-memory>/g)) {
    sysMem += tagNum(m[1], 'used') || 0;
  }
  // Per-bitmap inventory. Field availability varies by firmware, so read tolerantly: width/height are
  // always present; size and name (OS 9.3+) when the device provides them. When size is absent estimate
  // RGBA (w*h*4) and say so — an estimate that finds a 4K poster eating 33MB is still actionable.
  const bitmaps = [];
  for (const m of text.matchAll(/<bitmap>([\s\S]*?)<\/bitmap>/g)) {
    const b = m[1];
    const width = tagNum(b, 'width') || 0;
    const height = tagNum(b, 'height') || 0;
    const size = tagNum(b, 'size');
    const name = (b.match(/<(?:name|url)>([^<]*)<\/(?:name|url)>/) || [])[1] || null;
    bitmaps.push({
      width, height, name,
      bytes: size !== null ? size : width * height * 4,
      bytesEstimated: size === null,
    });
  }
  bitmaps.sort((a, b) => b.bytes - a.bytes);
  return { ok: true, texture: { used, max, available: Math.max(0, max - used) }, systemMemory: sysMem, bitmapCount: bitmaps.length, bitmaps };
}

// One polled sample, flat so it charts and CSVs without reshaping.
function toSample(t, chan, r2d2) {
  return {
    t, // ms since session start
    cpuUser: chan && chan.ok ? chan.cpu.user : null,
    cpuSys: chan && chan.ok ? chan.cpu.sys : null,
    memUsed: chan && chan.ok ? chan.memory.used : null,
    memAnon: chan && chan.ok ? chan.memory.anon : null,
    memFile: chan && chan.ok ? chan.memory.file : null,
    memSwap: chan && chan.ok ? chan.memory.swap : null,
    memLimit: chan && chan.ok ? chan.memory.limit : null,
    // Cumulative page-fault counters (the client charts per-sample deltas).
    minflt: chan && chan.ok && chan.procStat ? chan.procStat.minflt : null,
    majflt: chan && chan.ok && chan.procStat ? chan.procStat.majflt : null,
    texUsed: r2d2 && r2d2.ok ? r2d2.texture.used : null,
    texMax: r2d2 && r2d2.ok ? r2d2.texture.max : null,
    bitmaps: r2d2 && r2d2.ok ? r2d2.bitmapCount : null,
  };
}

const CSV_COLUMNS = ['t', 'cpuUser', 'cpuSys', 'memUsed', 'memAnon', 'memFile', 'memSwap', 'memLimit', 'minflt', 'majflt', 'texUsed', 'texMax', 'bitmaps'];

class PerfSession {
  constructor(device, { intervalMs = 1000 } = {}) {
    this.device = device;
    this.intervalMs = Math.max(250, Number(intervalMs) || 1000);
    this.samples = [];
    this.markers = []; // { t, label }
    this.startedAt = Date.now();
    this.running = false;
    this.lastError = null;
    this._stop = false;
  }

  // Poll loop as a setTimeout chain (never overlapping requests, unlike setInterval — a busy render
  // thread can make one poll take longer than the interval).
  start() {
    this.running = true;
    this._stop = false;
    const tick = async () => {
      if (this._stop) { this.running = false; return; }
      try { await this.sampleOnce(); this.lastError = null; }
      catch (e) { this.lastError = e.message; }
      if (!this._stop) setTimeout(tick, this.intervalMs);
      else this.running = false;
    };
    tick();
    return this;
  }

  async sampleOnce() {
    const t = Date.now() - this.startedAt;
    // chanperf is cheap; r2d2 lists every bitmap so it can be slow — fetch both, tolerate either failing.
    const [chanRes, r2d2Res] = await Promise.allSettled([
      this.device.ecpGet('/query/chanperf'),
      this.device.ecpGet('/query/r2d2-bitmaps'),
    ]);
    const chan = chanRes.status === 'fulfilled' ? parseChanperf(chanRes.value.text) : null;
    const r2d2 = r2d2Res.status === 'fulfilled' ? parseR2d2(r2d2Res.value.text) : null;
    if (chanRes.status === 'rejected' && r2d2Res.status === 'rejected') throw new Error(chanRes.reason.message);
    this.samples.push(toSample(t, chan, r2d2));
  }

  mark(label) {
    this.markers.push({ t: Date.now() - this.startedAt, label: String(label || 'marker') });
  }

  stop() { this._stop = true; this.running = false; }

  toJSON() {
    return {
      kind: 'brighttest-perf-session',
      version: 1,
      startedAt: this.startedAt,
      intervalMs: this.intervalMs,
      samples: this.samples,
      markers: this.markers,
    };
  }

  toCSV() {
    const esc = (v) => (v === null || v === undefined ? '' : String(v));
    const lines = [CSV_COLUMNS.join(',')];
    for (const s of this.samples) lines.push(CSV_COLUMNS.map((c) => esc(s[c])).join(','));
    if (this.markers.length) {
      lines.push('');
      lines.push('marker_t,label');
      // Quote labels: they are user text and may contain commas/quotes.
      for (const m of this.markers) lines.push(`${m.t},"${String(m.label).replace(/"/g, '""')}"`);
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { parseChanperf, parseR2d2, toSample, PerfSession, CSV_COLUMNS, sleep };
