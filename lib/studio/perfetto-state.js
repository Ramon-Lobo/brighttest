'use strict';
// Per-ESN Perfetto enable state, persisted under ~/.brighttest/perfetto-state.json so it survives a
// Studio restart. Records older than the stale window are ignored (the device may have rebooted and
// forgotten the enable), so the caller re-sends the enable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STALE_MS = 6 * 60 * 60 * 1000;

function stateFile(dir) {
  const base = dir || process.env.BRIGHTTEST_STATE_DIR || path.join(os.homedir(), '.brighttest');
  return path.join(base, 'perfetto-state.json');
}

function readAll(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

// Returns the record { channels, enabledAt } for the ESN, or null when absent or stale.
function readState(esn, { dir, staleMs = STALE_MS, now = Date.now() } = {}) {
  if (!esn) return null;
  const rec = readAll(dir)[esn];
  if (!rec || typeof rec.enabledAt !== 'number' || !Array.isArray(rec.channels)) return null;
  if (now - rec.enabledAt > staleMs) return null;
  return rec;
}

function writeState(esn, channels, { dir, now = Date.now() } = {}) {
  if (!esn) return;
  const all = readAll(dir);
  all[esn] = { channels, enabledAt: now };
  const file = stateFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}

const pad2 = (n) => String(n).padStart(2, '0');

// One line saying what brighttest knows about Perfetto on the device. The device state cannot be queried and
// there is no disable call, so this never says off/disabled/stopped. Prints only a local time, never the ESN.
function describeState(rec, { now = Date.now() } = {}) {
  if (!rec || typeof rec.enabledAt !== 'number') return 'no brighttest record; device state not queryable';
  const d = new Date(rec.enabledAt);
  let when = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (now - rec.enabledAt > 24 * 60 * 60 * 1000) when = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${when}`;
  return `enabled by brighttest at ${when}, device state not queryable`;
}

module.exports = { readState, writeState, stateFile, describeState, STALE_MS };
