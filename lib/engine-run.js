'use strict';
// Runs BrightScript files on the brs-node engine through its API so a `deviceInfo` customization can be passed
// (the engine's CLI has no flag for it). Used by the SceneGraph-off headless path only.
//   node lib/engine-run.js <brs-node main> <deviceInfo JSON | -> [-r <root>] <files...>
// Prints the app's output to stdout / stderr like `brs-cli -n`; exit code 1 when the engine reports an error.
const path = require('path');

async function main(argv) {
  const [engineMain, infoJson, ...rest] = argv;
  const custom = infoJson && infoJson !== '-' ? JSON.parse(infoJson) : undefined;
  let root;
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-r') root = rest[++i]; else files.push(rest[i]);
  }
  const brs = require(path.resolve(engineMain));
  if (custom && custom.connectionInfo) custom.connectionInfo = { ...brs.DefaultDeviceInfo.connectionInfo, ...custom.connectionInfo };
  // Sized like the CLI's: the engine indexes control slots and the data buffer well past the first few.
  const sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (brs.DataBufferIndex + brs.DataBufferSize));
  new Int32Array(sharedBuffer).fill(-1);
  brs.registerCallback((msg) => {
    if (typeof msg !== 'string') return;
    const kind = msg.split(',')[0];
    const text = msg.slice(kind.length + 1);
    if (kind === 'print') process.stdout.write(text);
    else if (kind === 'warning') console.warn(text.trimEnd());
    else if (kind === 'error') { console.error(text.trimEnd()); process.exitCode = 1; }
  }, sharedBuffer);
  const payload = await brs.createPayloadFromFiles(files, custom, undefined, root);
  if (payload.manifest && payload.manifest.set) payload.manifest.set('splash_min_time', '0'); // no 1.6 s splash wait
  await brs.executeFile(payload, {}, true);
}

// No process.exit() on success: it can truncate piped stdout; the exit code is set and the loop drains.
main(process.argv.slice(2)).then(() => {
  // the engine may leave workers or handles behind; exit once stdout has flushed
  process.stdout.write('', () => process.exit(process.exitCode || 0));
}, (e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exitCode = 1;
  process.stderr.write('', () => process.stdout.write('', () => process.exit(1)));
});
