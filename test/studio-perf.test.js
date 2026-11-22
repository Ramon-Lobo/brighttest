import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const perf = require('../lib/studio/perf.js');

// Fixtures mirror the real chanperf/r2d2 responses captured from a Roku Ultra (fw 15.3.4) running
// a large production app — including the firmware's actual "sytem-memory" spelling.
const CHANPERF = `<?xml version="1.0" encoding="UTF-8" ?>
<chanperf><timestamp>1785875055394</timestamp><plugin>
<cpu-percent><duration-seconds>1.000000</duration-seconds><user>8.9</user><sys>0.3</sys></cpu-percent>
<memory><used>61956096</used><res>61956096</res><anon>39653376</anon><swap>0</swap><file>22122496</file><shared>180224</shared><limit>859832320</limit></memory>
</plugin><status>OK</status></chanperf>`;

const CHANPERF_DOWN = `<?xml version="1.0"?><chanperf><status>FAILED</status><error>Channel not running</error></chanperf>`;

const R2D2 = `<?xml version="1.0" encoding="UTF-8" ?>
<r2d2-bitmaps><timestamp>1</timestamp><channel-id>dev</channel-id><graphics-instances>
<rographics><sytem-memory><used>0</used></sytem-memory><texture-memory><used>0</used><available>240000000</available><max>240000000</max></texture-memory></rographics>
<rographics><sytem-memory><used>1255248</used></sytem-memory><texture-memory><used>130191360</used><available>109808640</available><max>240000000</max></texture-memory>
<bitmap><width>705</width><height>397</height></bitmap><bitmap><width>10</width><height>10</height></bitmap></rographics>
</graphics-instances></r2d2-bitmaps>`;

describe('parseChanperf', () => {
  it('reads cpu and memory from a live response', () => {
    const r = perf.parseChanperf(CHANPERF);
    expect(r.ok).toBe(true);
    expect(r.cpu).toEqual({ user: 8.9, sys: 0.3, durationS: 1 });
    expect(r.memory.used).toBe(61956096);
    expect(r.memory.limit).toBe(859832320);
    expect(r.memory.swap).toBe(0);
  });

  it('reports the device error when no channel runs', () => {
    const r = perf.parseChanperf(CHANPERF_DOWN);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running/i);
  });

  it('does not throw on garbage', () => {
    expect(perf.parseChanperf('').ok).toBe(false);
    expect(perf.parseChanperf('<html>nope</html>').ok).toBe(false);
  });
});

describe('parseR2d2', () => {
  it('sums texture memory across graphics instances and counts bitmaps', () => {
    const r = perf.parseR2d2(R2D2);
    expect(r.ok).toBe(true);
    expect(r.texture.used).toBe(130191360);
    expect(r.texture.max).toBe(240000000);
    expect(r.bitmapCount).toBe(2);
    expect(r.systemMemory).toBe(1255248); // the firmware's "sytem-memory" spelling
  });

  it('fails soft without r2d2 data', () => {
    expect(perf.parseR2d2('').ok).toBe(false);
  });
});

describe('PerfSession', () => {
  const fakeDevice = (chanXml, r2d2Xml) => ({
    ecpGet: async (p) => ({ text: p.includes('chanperf') ? chanXml : r2d2Xml }),
  });

  it('collects flat samples from both endpoints', async () => {
    const s = new perf.PerfSession(fakeDevice(CHANPERF, R2D2));
    await s.sampleOnce();
    expect(s.samples).toHaveLength(1);
    const smp = s.samples[0];
    expect(smp.cpuUser).toBe(8.9);
    expect(smp.memUsed).toBe(61956096);
    expect(smp.texUsed).toBe(130191360);
    expect(smp.bitmaps).toBe(2);
  });

  it('keeps sampling half-null when one endpoint fails', async () => {
    const dev = { ecpGet: async (p) => { if (p.includes('r2d2')) throw new Error('boom'); return { text: CHANPERF }; } };
    const s = new perf.PerfSession(dev);
    await s.sampleOnce();
    expect(s.samples[0].cpuUser).toBe(8.9);
    expect(s.samples[0].texUsed).toBeNull();
  });

  it('exports CSV with markers quoted', async () => {
    const s = new perf.PerfSession(fakeDevice(CHANPERF, R2D2));
    await s.sampleOnce();
    s.mark('pressed "OK", opened details');
    const csv = s.toCSV();
    expect(csv.split('\n')[0]).toBe(perf.CSV_COLUMNS.join(','));
    expect(csv).toContain('8.9');
    expect(csv).toContain('"pressed ""OK"", opened details"');
  });

  it('exports JSON with the session envelope', async () => {
    const s = new perf.PerfSession(fakeDevice(CHANPERF, R2D2), { intervalMs: 500 });
    await s.sampleOnce();
    const j = s.toJSON();
    expect(j.kind).toBe('brighttest-perf-session');
    expect(j.intervalMs).toBe(500);
    expect(j.samples).toHaveLength(1);
  });

  it('clamps silly intervals', () => {
    expect(new perf.PerfSession(fakeDevice(CHANPERF, R2D2), { intervalMs: 5 }).intervalMs).toBe(250);
  });
});

// ── deeper extraction: proc-stat, memory split, bitmap inventory ───────────────────────────────────

const CHANPERF_FULL = `<?xml version="1.0" encoding="UTF-8" ?>
<chanperf><timestamp>1</timestamp><plugin>
<cpu-percent><duration-seconds>1.000000</duration-seconds><user>8.9</user><sys>0.3</sys></cpu-percent>
<proc-stat><utime>16532</utime><stime>782</stime><cutime>0</cutime><cstime>0</cstime>
<minflt>92462</minflt><majflt>2839</majflt><starttime>1184526</starttime><state>S</state><clk-tck>100</clk-tck></proc-stat>
<memory><used>61956096</used><anon>39653376</anon><swap>0</swap><file>22122496</file><limit>859832320</limit></memory>
</plugin><status>OK</status></chanperf>`;

const R2D2_NAMED = `<r2d2-bitmaps><timestamp>1</timestamp><graphics-instances>
<rographics><texture-memory><used>140000000</used><available>1</available><max>240000000</max></texture-memory>
<bitmap><width>1920</width><height>1080</height><size>8294400</size><name>pkg:/images/hero.jpg</name></bitmap>
<bitmap><width>705</width><height>397</height></bitmap>
</rographics></graphics-instances></r2d2-bitmaps>`;

describe('deeper chanperf extraction', () => {
  it('reads proc-stat: cumulative ticks, page faults, clk-tck', () => {
    const r = perf.parseChanperf(CHANPERF_FULL);
    expect(r.procStat).toEqual({ utime: 16532, stime: 782, minflt: 92462, majflt: 2839, clkTck: 100, state: 'S' });
    expect(r.memory.file).toBe(22122496);
  });

  it('flows fault counters and memFile into samples and CSV', async () => {
    const dev = { ecpGet: async (p) => ({ text: p.includes('chanperf') ? CHANPERF_FULL : R2D2_NAMED }) };
    const s = new perf.PerfSession(dev);
    await s.sampleOnce();
    expect(s.samples[0].minflt).toBe(92462);
    expect(s.samples[0].majflt).toBe(2839);
    expect(s.samples[0].memFile).toBe(22122496);
    expect(s.toCSV().split('\n')[0]).toContain('majflt');
  });

  it('tolerates chanperf without proc-stat', () => {
    const r = perf.parseChanperf(CHANPERF); // original fixture, no proc-stat block
    expect(r.ok).toBe(true);
    expect(r.procStat).toBeNull();
  });
});

describe('texture inventory', () => {
  it('reads per-bitmap size and name when the firmware provides them', () => {
    const r = perf.parseR2d2(R2D2_NAMED);
    expect(r.bitmaps[0]).toEqual({ width: 1920, height: 1080, name: 'pkg:/images/hero.jpg', bytes: 8294400, bytesEstimated: false });
  });

  it('estimates RGBA bytes when size is absent, and flags the estimate', () => {
    const r = perf.parseR2d2(R2D2_NAMED);
    const est = r.bitmaps.find((b) => b.width === 705);
    expect(est.bytes).toBe(705 * 397 * 4);
    expect(est.bytesEstimated).toBe(true);
    expect(est.name).toBeNull();
  });

  it('sorts the inventory by bytes descending', () => {
    const r = perf.parseR2d2(R2D2_NAMED);
    expect(r.bitmaps[0].bytes).toBeGreaterThan(r.bitmaps[1].bytes);
  });
});

// ── cadence (BUG-B3): start-anchored schedule + measured interval ──────────────────────────────────

describe('PerfSession cadence', () => {
  afterEach(() => vi.useRealTimers());
  const slowDevice = (ms) => ({
    ecpGet: (path) => new Promise((r) => setTimeout(() => r({ text: path.includes('chanperf') ? CHANPERF : R2D2 }), ms)),
  });

  it('keeps samples on the start-anchored grid when calls take 700 ms and intervalMs is 1000', async () => {
    vi.useFakeTimers();
    const s = new perf.PerfSession(slowDevice(700), { intervalMs: 1000 }).start();
    await vi.advanceTimersByTimeAsync(10_000);
    s.stop();
    const ts = s.samples.map((x) => x.t);
    expect(ts.length).toBeGreaterThanOrEqual(9);
    ts.forEach((t, i) => expect(Math.abs(t - i * 1000)).toBeLessThanOrEqual(100)); // not 1700 ms apart
    expect(s.effectiveIntervalMs).toBe(1000);
    expect(s.toJSON().effectiveIntervalMs).toBe(1000);
  });

  it('skips missed slots (no burst) and reports the real spacing when calls exceed the interval', async () => {
    vi.useFakeTimers();
    const s = new perf.PerfSession(slowDevice(1300), { intervalMs: 1000 }).start();
    await vi.advanceTimersByTimeAsync(10_000);
    s.stop();
    const gaps = s.samples.slice(1).map((x, i) => x.t - s.samples[i].t);
    expect(gaps.length).toBeGreaterThan(2);
    gaps.forEach((g) => expect(g).toBe(2000)); // next free slot, never a catch-up burst
    expect(s.effectiveIntervalMs).toBe(2000);  // honest: differs from the requested 1000
    expect(s.intervalMs).toBe(1000);
  });

  it('effectiveIntervalMs is null with fewer than two samples', () => {
    expect(new perf.PerfSession(slowDevice(1)).effectiveIntervalMs).toBeNull();
  });
});

describe('graphics frame rate', () => {
  const FR = '<graphics-frame-rate><timestamp>1</timestamp><frame-rate>59.5</frame-rate></graphics-frame-rate>';
  it('parses fps and fails soft', () => {
    expect(perf.parseFrameRate(FR)).toEqual({ ok: true, fps: 59.5 });
    expect(perf.parseFrameRate('').ok).toBe(false);
    expect(perf.parseFrameRate('<x><status>FAILED</status><error>nope</error></x>')).toEqual({ ok: false, error: 'nope' });
  });
  it('puts fps in the sample, or null with a reason when the query fails', async () => {
    const ok = new perf.PerfSession({ ecpGet: async (p) => ({ text: p.includes('frame-rate') ? FR : p.includes('chanperf') ? CHANPERF : R2D2 }) });
    await ok.sampleOnce();
    expect(ok.samples[0].fps).toBe(59.5);
    expect(ok.samples[0].fpsReason).toBeUndefined();
    const bad = new perf.PerfSession({ ecpGet: async (p) => { if (p.includes('frame-rate')) throw new Error('404'); return { text: p.includes('chanperf') ? CHANPERF : R2D2 }; } });
    await bad.sampleOnce();
    expect(bad.samples[0].fps).toBeNull();
    expect(bad.samples[0].fpsReason).toBe('404');
    expect(bad.samples[0].cpuUser).toBe(8.9);
  });
});
