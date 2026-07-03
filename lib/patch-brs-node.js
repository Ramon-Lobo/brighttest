#!/usr/bin/env node
'use strict';
// Post-install patch for brs-node's SceneGraph bundle.
//
// brs-node batches SceneGraph field-change notifications: setting a field only QUEUES its observers,
// which are flushed later. Rooibos runs an entire @SGNode node suite inside a single notification flush
// (the suite is kicked off by the `rooibosRunSuite` field observer), so any field a test sets during the
// suite has its XML `onChange` handler queued but not fired until the whole suite ends — far too late for
// the test's own assertions. The net effect: `onChange` cascades never run headless (they do on device).
//
// This makes a NESTED field-set (one that happens while a flush is already in progress) dispatch its
// observers SYNCHRONOUSLY, which is exactly how real Roku fires onChange on a same-thread set. Recursion
// is bounded by brs-node's own per-observer `running` guard, and the change only affects the headless
// simulator (the device lane uses real hardware). See docs/maintainers.md#brs-node-onchange-patch.
//
// The bundle is minified (one line), so a patch-package diff would embed the whole ~370 KB line; a
// targeted, idempotent, version-aware string replacement is cleaner. Never fails the install: if the
// target string isn't found (e.g. brs-node changed), it warns and exits 0.
const fs = require('fs');
const path = require('path');

const FIND = 'notifyObservers(){y.flushingNotifications&&this.lastNotifiedBatchId===y.currentBatchId||(y.queuedFields.has(this)||(y.notifyQueue.push(this),y.queuedFields.add(this)),y.flushNotificationQueue())}';
const REPLACE = 'notifyObservers(){y.flushingNotifications&&this.lastNotifiedBatchId===y.currentBatchId||(y.flushingNotifications?this.dispatchObservers():(y.queuedFields.has(this)||(y.notifyQueue.push(this),y.queuedFields.add(this)),y.flushNotificationQueue()))}';

function main() {
  const paths = [__dirname, path.join(__dirname, '..'), process.cwd()];
  let pkgJson, version = '?';
  try {
    pkgJson = require.resolve('brs-node/package.json', { paths });
    version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
  } catch (e) {
    // brs-node not resolvable from here (e.g. hoisted elsewhere); nothing to do.
    return;
  }
  const target = path.join(path.dirname(pkgJson), 'bin', 'brs-sg.node.js');
  let src;
  try { src = fs.readFileSync(target, 'utf8'); } catch (e) { return; }

  if (src.includes(REPLACE)) {
    console.log('[roku-test] brs-node onChange patch already applied');
    return;
  }
  if (!src.includes(FIND)) {
    console.warn(`[roku-test] brs-node onChange patch target not found (brs-node ${version}); ` +
      '@SGNode onChange observers may not fire in the headless lane. See docs/maintainers.');
    return;
  }
  fs.writeFileSync(target, src.replace(FIND, REPLACE));
  console.log(`[roku-test] applied brs-node ${version} onChange synchronous-dispatch patch`);
}

main();
