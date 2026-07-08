#!/usr/bin/env node
'use strict';
// Post-install brs-node patches. Runs after patch-package (see package.json postinstall). Never fails the
// install: anything unexpected prints a warning and exits 0. See docs/maintainers.md.
//
// PATCH 1 — synchronous onChange dispatch (string-replace in the minified SceneGraph bundle brs-sg.node.js).
//   brs-node batches SceneGraph field-change notifications. Rooibos runs an entire @SGNode suite inside one
//   notification flush, so a field a test sets only QUEUES its onChange, which fires after the suite ends —
//   too late for the test's assertions. This dispatches a NESTED field-set's observers synchronously, like
//   real Roku's same-thread onChange.
//
// PATCH 2 — install a rebuilt core bundle (brs.node.js) that adds `roTextToSpeech`.
//   brs-node (a simulator) lacked roTextToSpeech, which cbs-roku's shared audio-guide helper creates in
//   widget init/focus. CreateObject returned invalid, then the widget deref'd it and crashed the run. We
//   rebuilt brs-node@2.2.0 from source (lvcabral/brs-engine) with a headless roTextToSpeech stub and vendor
//   the minified bundle at vendor/brs-node/brs.node.js. This is the interim delivery until the class is
//   upstreamed and a new brs-node is released (then drop this and bump the dep). brs-sg.node.js delegates
//   its component registry to brs.node.js, so swapping the core bundle covers the SceneGraph lane too.
const fs = require('fs');
const path = require('path');

const ONCHANGE = {
  bundle: 'bin/brs-sg.node.js',
  desc: 'onChange synchronous-dispatch',
  find: 'notifyObservers(){y.flushingNotifications&&this.lastNotifiedBatchId===y.currentBatchId||(y.queuedFields.has(this)||(y.notifyQueue.push(this),y.queuedFields.add(this)),y.flushNotificationQueue())}',
  // When already inside a flush, dispatch this nested field-set's observers synchronously (so they
  // fire mid-test, not after the suite) BUT guard re-entrancy with a per-field __disp flag: a field
  // already on the current dispatch stack is coalesced instead of re-dispatched, matching real Roku
  // and preventing infinite recursion when observers cascade in a cycle (e.g. ThemeButton.updateFocus).
  replace: 'notifyObservers(){y.flushingNotifications&&this.lastNotifiedBatchId===y.currentBatchId||(y.flushingNotifications?(this.__disp||(this.__disp=!0,this.dispatchObservers(),this.__disp=!1)):(y.queuedFields.has(this)||(y.notifyQueue.push(this),y.queuedFields.add(this)),y.flushNotificationQueue()))}',
  appliedMarker: 'this.__disp=!0,this.dispatchObservers()',
  onMissing: '@SGNode onChange observers may not fire in the headless lane',
};

// The vendored bundle was built against this exact brs-node version; only install it on a match.
const VENDOR_BRS_NODE_VERSION = '2.2.0';

function applyOnChange(pkgDir, version) {
  const target = path.join(pkgDir, ONCHANGE.bundle);
  let src;
  try { src = fs.readFileSync(target, 'utf8'); } catch (e) { return; }
  if (src.includes(ONCHANGE.appliedMarker)) {
    console.log(`[roku-test] brs-node ${ONCHANGE.desc} patch already applied`);
    return;
  }
  if (!src.includes(ONCHANGE.find)) {
    console.warn(`[roku-test] brs-node ${ONCHANGE.desc} patch target not found (brs-node ${version}); ` +
      `${ONCHANGE.onMissing}. See docs/maintainers.`);
    return;
  }
  fs.writeFileSync(target, src.replace(ONCHANGE.find, ONCHANGE.replace));
  console.log(`[roku-test] applied brs-node ${version} ${ONCHANGE.desc} patch`);
}

function installTtsBundle(pkgDir, version) {
  const vendored = path.join(__dirname, '..', 'vendor', 'brs-node', 'brs.node.js');
  const target = path.join(pkgDir, 'bin', 'brs.node.js');
  if (!fs.existsSync(vendored)) return;
  if (version !== VENDOR_BRS_NODE_VERSION) {
    console.warn(`[roku-test] vendored roTextToSpeech bundle is for brs-node ${VENDOR_BRS_NODE_VERSION} ` +
      `but ${version} is installed; skipping. @SGNode audio-guide widgets may crash headless. See docs/maintainers.`);
    return;
  }
  let cur = '', want = '';
  try { cur = fs.readFileSync(target, 'utf8'); } catch (e) { /* will copy */ }
  try { want = fs.readFileSync(vendored, 'utf8'); } catch (e) { return; }
  if (cur === want) {
    console.log('[roku-test] brs-node core bundle already installed (up to date)');
    return;
  }
  fs.copyFileSync(vendored, target);
  console.log(`[roku-test] installed rebuilt brs-node ${version} core bundle (adds roTextToSpeech)`);
}

// PATCH 4 — install a rebuilt SceneGraph bundle (brs-sg.node.js) that registers extra built-in node
//   types missing from stock brs-node. Currently adds `DynamicPinPad` (a firmware PIN-pad node that
//   cbs-roku's PinPadButton/ThemePinPad build in init) so those widgets instantiate headlessly instead
//   of crashing on a missing `keyGrid` field. Built from the same lvcabral/brs-engine working tree as
//   the core bundle. MUST run before applyOnChange so the onChange string-patch lands on the fresh bundle.
function installSgBundle(pkgDir, version) {
  const vendored = path.join(__dirname, '..', 'vendor', 'brs-node', 'brs-sg.node.js');
  const target = path.join(pkgDir, 'bin', 'brs-sg.node.js');
  if (!fs.existsSync(vendored)) return;
  if (version !== VENDOR_BRS_NODE_VERSION) {
    console.warn(`[roku-test] vendored SceneGraph bundle is for brs-node ${VENDOR_BRS_NODE_VERSION} ` +
      `but ${version} is installed; skipping. DynamicPinPad-based widgets may crash headless. See docs/maintainers.`);
    return;
  }
  let cur = '', want = '';
  try { cur = fs.readFileSync(target, 'utf8'); } catch (e) { /* will copy */ }
  try { want = fs.readFileSync(vendored, 'utf8'); } catch (e) { return; }
  if (cur === want) {
    console.log('[roku-test] brs-node SceneGraph bundle already installed (up to date)');
    return;
  }
  fs.copyFileSync(vendored, target);
  console.log(`[roku-test] installed rebuilt brs-node ${version} SceneGraph bundle (extra built-in nodes)`);
}

function main() {
  const paths = [__dirname, path.join(__dirname, '..'), process.cwd()];
  let pkgDir, version = '?';
  try {
    const pkgJson = require.resolve('brs-node/package.json', { paths });
    version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
    pkgDir = path.dirname(pkgJson);
  } catch (e) {
    return; // brs-node not resolvable from here (e.g. hoisted elsewhere)
  }
  installSgBundle(pkgDir, version);
  // NOTE: the onChange synchronous-dispatch string-patch (applyOnChange) is retired. The forked
  // brs-engine now dispatches field observers synchronously natively (Field.notifyObservers, with a
  // re-entrancy guard for cyclic ContentNode cascades), so the patch is unnecessary — and its minified
  // find-string no longer exists in the fork bundle. Kept in this file for reference/history only.
  installTtsBundle(pkgDir, version);
}

main();
