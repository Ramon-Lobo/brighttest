'use strict';
// Stop Studio when the npm/npx process that started it is gone. `npx brighttest studio` runs `node bin/cli.js studio`
// as a child of `npm exec`; npm forwards SIGINT/SIGTERM, but when npm itself dies from SIGKILL or SIGALRM the child is
// reparented and would keep the port, the hub and the lease. Only active under `npm exec`/`npx`: a direct
// `node bin/cli.js studio`, nohup or a service manager keeps today's behaviour. Returns a stop function.

function watchParent({ ppid0 = process.ppid, everyMs = 2000, onGone, env = process.env, getPpid = () => process.ppid, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!env || env.npm_command !== 'exec' || !(ppid0 > 1) || typeof onGone !== 'function') return () => {};
  let fired = false;
  const timer = setIntervalFn(() => {
    if (fired || getPpid() === ppid0) return;
    fired = true;
    clearIntervalFn(timer);
    onGone();
  }, everyMs);
  if (timer && timer.unref) timer.unref();
  return () => { clearIntervalFn(timer); };
}

module.exports = { watchParent };
