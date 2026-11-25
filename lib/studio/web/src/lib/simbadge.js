// Simulator target helpers for the header badge (pure, unit-tested).
export const SIM_STATES = { starting: 'starting', settling: 'settling', running: 'running', 'no-hello': 'no hello from the app', exited: 'engine exited' };

export const isSim = (d) => !!d && d.target === 'simulator';

export function simText(d) {
  const e = d && d.engine;
  const eng = e && e.name ? `${e.name}${e.version ? `@${e.version}` : ''}${e.flavor ? ` (${e.flavor})` : ''}` : 'engine';
  const st = d && d.state;
  return `simulator · ${eng} · ${SIM_STATES[st] || st || 'starting'}`;
}

export function simCls(d) {
  const st = d && d.state;
  return st === 'running' ? 'mine' : st === 'no-hello' || st === 'exited' ? 'other' : 'wait';
}

// Poll fast while the engine is coming up, slowly once it is settled or finished.
export function simPollMs(d) {
  const st = d && d.state;
  return st === 'running' || st === 'no-hello' || st === 'exited' ? 5000 : 1000;
}

// The engine tail is only worth carrying when something went wrong.
export const simTail = (d) => (d && (d.state === 'no-hello' || d.state === 'exited') && Array.isArray(d.tail) ? d.tail : []);

// Next studio.device after a poll. `next` is the parsed response, or null when the request failed.
// The mode is sticky: a failed poll never turns a simulator target into a device target.
export function mergeDevice(prev, next) {
  if (next && typeof next === 'object') return isSim(next) && next.tail && !simTail(next).length ? { ...next, tail: [] } : next;
  return isSim(prev) ? prev : { connected: false };
}

// Keep polling while the mode is simulator or not known yet.
export const shouldPoll = (d) => !d || isSim(d) || d.connected === false;
