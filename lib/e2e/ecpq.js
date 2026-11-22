'use strict';

// Per-host ECP call queue with per-endpoint spacing and one transient retry (ROB-01a).
//
// A Roku handles ECP/installer calls poorly when they overlap (sgnodes can stall the render thread, the
// screenshot endpoint is slow), so every call to one host runs strictly one at a time, in submission order.
// Different hosts never wait for each other. Each endpoint kind also has a minimum gap measured from the END of
// the previous successful call of that kind to the START of the next. A failed call does not charge the gap.
// A call that fails transiently (HTTP 5xx, timeout, "fetch failed") is retried once; client errors
// (401/403/404, other 4xx) are never retried. A non-idempotent call (`{ idempotent: false }`, the ECP
// keypress/launch POSTs) is retried only when it is provably undelivered: the connection was refused or the
// host did not resolve/route. Never after a timeout, an abort, a bare "fetch failed", or any HTTP response
// (including 5xx), since the device may already have acted on it (ADR 0004, owner decision E-107).

const DEFAULT_GAPS = { sgnodes: 200, screenshot: 500, input: 220 };
const DEFAULT_RETRY_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map an ECP/installer path to its spacing class. Anything unlisted has no gap.
function endpointKind(path) {
  const p = String(path || '');
  if (/^\/query\/sgnodes\b/.test(p)) return 'sgnodes';
  if (/^\/input\b/.test(p)) return 'input'; // STA-S-T13: chunks of one mailbox command are spaced 220 ms apart
  if (/screenshot/i.test(p)) return 'screenshot';
  return 'other';
}

// Node/undici error codes proving no request reached the device (connect never completed).
const UNDELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

// True when the thrown error proves the request was never delivered (fetch failed with such a cause).
function isUndelivered(e) {
  if (!e || e.name === 'TimeoutError' || e.name === 'AbortError') return false;
  const code = (e.cause && e.cause.code) || e.code;
  return /fetch failed/i.test(e.message || '') && UNDELIVERED_CODES.has(code);
}

// True for failures worth exactly one more attempt: thrown timeouts / network resets, or an HTTP 5xx result.
// With idempotent === false only an undelivered failure qualifies.
function isTransient(outcome, { idempotent = true } = {}) {
  if (!idempotent) return !!outcome.error && isUndelivered(outcome.error);
  if (outcome.error) {
    const e = outcome.error;
    if (e.code === 'SCREENSHOT_NOT_FOREGROUND') return false;
    return e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed/i.test(e.message || '');
  }
  const s = outcome.value && outcome.value.status;
  return typeof s === 'number' && s >= 500;
}

// opts: { gaps, retryDelayMs, now, sleep } (the last two are test seams).
function createQueue(opts = {}) {
  const gaps = { ...DEFAULT_GAPS, ...(opts.gaps || {}) };
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const now = opts.now || Date.now;
  const wait = opts.sleep || sleep;
  const hosts = new Map(); // host -> { tail: Promise, lastEnd: { [kind]: ms } }

  function stateFor(host) {
    let s = hosts.get(host);
    if (!s) { s = { tail: Promise.resolve(), lastEnd: {} }; hosts.set(host, s); }
    return s;
  }

  async function attempt(fn) {
    try { return { value: await fn() }; } catch (error) { return { error }; }
  }

  // run(host, kind, fn, { idempotent }): fn() performs one attempt and resolves to a result (with a numeric
  // `status`, if HTTP). idempotent: false narrows the retry to provably undelivered failures.
  function run(host, kind, fn, runOpts = {}) {
    const idempotent = runOpts.idempotent !== false;
    const s = stateFor(host);
    const job = s.tail.then(async () => {
      const gap = gaps[kind] || 0;
      const settle = async () => {
        const last = s.lastEnd[kind];
        if (gap && last !== undefined) {
          const remaining = last + gap - now();
          if (remaining > 0) await wait(remaining);
        }
      };
      await settle();
      let out = await attempt(fn);
      const failed = (o) => !!o.error || (o.value && o.value.status >= 400);
      if (isTransient(out, { idempotent })) {
        await wait(retryDelayMs);
        out = await attempt(fn);
      }
      if (!failed(out)) s.lastEnd[kind] = now();
      if (out.error) throw out.error;
      return out.value;
    });
    // Keep the chain alive whatever this job does.
    s.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  return { run, endpointKind, gaps };
}

// Process-wide queue, keyed by host, shared by every device handle (the Studio server is long-lived).
const defaultQueue = createQueue();

module.exports = { createQueue, defaultQueue, endpointKind, isTransient, isUndelivered, DEFAULT_GAPS };
