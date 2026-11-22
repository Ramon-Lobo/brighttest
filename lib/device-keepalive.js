'use strict';
// Opt-in keep-alive for `brighttest device with --keepalive[=sec]`: one host-side ECP keypress per interval
// while the wrapped command runs. Evidence (DQ-C68): `keypress Fwd` every 240 s kept the sample app alive for
// 45 min with no ~595 s stall. Only Fwd at 240 s was tested; other keys and intervals are not claimed to work.
// Never sends Home, Back, Select or any key that moves focus. Uses the lease the wrapper already holds.

const KEEPALIVE_KEY = 'Fwd';
const ALLOWED_KEYS = Object.freeze([KEEPALIVE_KEY]);
const DEFAULT_SEC = 240;
const MIN_SEC = 60;
const MAX_CONSECUTIVE_FAILURES = 3;

// Flag value -> seconds. undefined/null/'' (flag given bare) -> 240; 0 -> 0 (off). Returns { sec } or { error }.
function parseKeepaliveSec(v) {
  if (v === undefined || v === null || v === '' || v === true) return { sec: DEFAULT_SEC };
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return { error: `--keepalive: "${v}" is not a number of seconds` };
  const n = parseInt(s, 10);
  if (n === 0) return { sec: 0 };
  if (n < MIN_SEC) return { error: `--keepalive: ${n}s is below the ${MIN_SEC}s minimum (0 turns it off)` };
  return { sec: n };
}

// start(host, key, everySec, opts) -> stop(). opts: { createDevice, password, ecpPort, log, setInterval,
// clearInterval, now }. everySec 0/falsy: no timer, a no-op stop. The first send is after one full interval.
function start(host, key, everySec, opts = {}) {
  if (!everySec) return () => {};
  if (!ALLOWED_KEYS.includes(key)) throw new Error(`keepalive key "${key}" not allowed (allowed: ${ALLOWED_KEYS.join(', ')})`);
  if (everySec < MIN_SEC) throw new Error(`keepalive interval ${everySec}s is below the ${MIN_SEC}s minimum`);
  const make = opts.createDevice || require('./e2e/ecp').createDevice;
  const log = opts.log || (() => {});
  const setI = opts.setInterval || setInterval;
  const clearI = opts.clearInterval || clearInterval;
  const now = opts.now || Date.now;
  const t0 = now();
  const dev = make({ host, password: opts.password, ecpPort: opts.ecpPort });
  let fails = 0;
  let timer = null;
  let busy = false;
  const stop = () => { if (timer) { clearI(timer); timer = null; } };
  timer = setI(async () => {
    if (!timer || busy) return;
    busy = true;
    const up = Math.round((now() - t0) / 1000);
    try {
      await dev.keypress(key);
      fails = 0;
      log(`[brighttest keepalive] t+${up}s keypress ${key} ok`);
    } catch (e) {
      fails++;
      log(`[brighttest keepalive] t+${up}s keypress ${key} failed: ${e && e.message}`);
      if (fails >= MAX_CONSECUTIVE_FAILURES) {
        log(`[brighttest keepalive] warning: ${fails} consecutive failures; keep-alive stopped`);
        stop();
      }
    } finally { busy = false; }
  }, everySec * 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return stop;
}

module.exports = { start, parseKeepaliveSec, KEEPALIVE_KEY, ALLOWED_KEYS, DEFAULT_SEC, MIN_SEC, MAX_CONSECUTIVE_FAILURES };
