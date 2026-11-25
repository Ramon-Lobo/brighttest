// Role names for the lease board, shared with the terminal board: the same map as ROLES in lib/tui.js
// (test/lease-roles.test.js fails when they drift). A role resolves to a palette token, and a token to the
// Tailwind class already built from app.css. The class names are written out in full so the scanner finds them.
export const ROLES = Object.freeze({
  held: 'violet', free: 'pass', stale: 'fail', corrupt: 'fail',
  queued: 'amber', waitBar: 'amber', up: 'pass', unreachable: 'fail', unknown: 'haze',
  runOk: 'pass', runFailed: 'fail', running: 'violet', meta: 'haze', accent: 'violet',
});

export const TEXT = Object.freeze({
  violet: 'text-violet', amber: 'text-amber', pass: 'text-pass', fail: 'text-fail', haze: 'text-haze',
});
export const BG = Object.freeze({
  violet: 'bg-violet', amber: 'bg-amber', pass: 'bg-pass', fail: 'bg-fail', haze: 'bg-haze',
});

export const tokenOf = (role) => ROLES[role] || 'haze';
export const textClass = (role) => TEXT[tokenOf(role)];
export const bgClass = (role) => BG[tokenOf(role)];

// Role and short text of a run row by how it ended, as the terminal board shows it (runOutcome in lib/device-watch.js).
export function runOutcome(run) {
  switch (run.ended) {
    case 'released': return !Number.isFinite(run.exitCode) || run.exitCode === 0
      ? { role: 'runOk', text: 'ok' } : { role: 'runFailed', text: `exit ${run.exitCode}` };
    case 'running': return { role: 'running', text: 'running' };
    case 'lost': return { role: 'runFailed', text: 'lost' };
    case 'reclaimed': return { role: 'runFailed', text: 'reclaimed' };
    case 'forced': return { role: 'runFailed', text: 'forced' };
    case 'timeout': return { role: 'runFailed', text: 'gave up' };
    default: return { role: 'meta', text: '?' };
  }
}

// Durations as "42s", "3m 05s", "1h 02m".
export function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// Text from other processes (agent, purpose, host names) can hold control, invisible or direction-changing
// characters. Same character classes as lib/tui.js (RE_CTRL, RE_INVISIBLE); test/lease-roles.test.js checks they match.
export const RE_CTRL = /[\u0000-\u001f\u007f-\u009f­]/g;
export const RE_INVISIBLE = /[؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]|[\u{e0000}-\u{e007f}]/gu;
export function clean(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').replace(RE_CTRL, '').replace(RE_INVISIBLE, '');
}
