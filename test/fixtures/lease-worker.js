'use strict';
// Integration fixture: acquire the device lease through the library, log the hold interval, release.
//   node lease-worker.js <id> <abs-logfile> [holdMs]
// Env: BRIGHTTEST_LEASE_DIR (required), LEASE_KEY (default 127.0.0.1), LEASE_WAIT_MS, LEASE_GRACE_MS (ticket
// adoption grace), LEASE_CHILD_MS (spawn a child under the lease that sleeps this long and outlives a kill),
// LEASE_NESTED=1 (run a nested worker with BRIGHTTEST_LEASE set: it must be re-entrant).
const fs = require('fs');
const path = require('path');
const lease = require('../../lib/device-lease');

const [id, log, holdMs = '120'] = process.argv.slice(2);
const stamp = () => `${process.hrtime.bigint()} ${Date.now()}`;
const append = (s) => fs.appendFileSync(log, s + '\n');

(async () => {
  let l;
  try {
    l = await lease.acquire({
      key: process.env.LEASE_KEY || '127.0.0.1',
      agent: id, purpose: `worker ${id}`,
      waitMs: process.env.LEASE_WAIT_MS ? Number(process.env.LEASE_WAIT_MS) : 30000,
      ticketGraceMs: process.env.LEASE_GRACE_MS ? Number(process.env.LEASE_GRACE_MS) : undefined,
      pollMs: 100,
    });
  } catch (e) {
    append(`error ${id} ${e.code}`);
    process.exit(lease.exitCodeFor(e));
  }
  append(`enter ${id} ${stamp()} ${l.reentrant ? 'reentrant' : 'held'}`);
  if (process.env.LEASE_CHILD_MS) {
    const child = l.spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${Number(process.env.LEASE_CHILD_MS)})`], { stdio: 'ignore' });
    append(`child ${id} ${child.pid}`);
  }
  if (process.env.LEASE_NESTED === '1') {
    const env = { ...process.env, BRIGHTTEST_LEASE: l.leaseId, LEASE_NESTED: '0' };
    const r = require('child_process').spawnSync(process.execPath, [__filename, `${id}-inner`, log, '10'], { env, stdio: 'inherit' });
    append(`nested ${id} ${r.status}`);
  }
  setTimeout(() => {
    append(`exit ${id} ${stamp()}`);
    l.release();
    process.exit(0);
  }, Number(holdMs));
})();

module.exports = { path: path.resolve(__filename) };
