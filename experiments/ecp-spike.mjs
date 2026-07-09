// ECP spike — confirms the primitives an E2E lane would use, against a real device.
//   node experiments/ecp-spike.mjs <device-ip> [app-id]
// Reads: device-info, active-app, sgnodes tree. Acts: launch, keypress. Prints a schema-agnostic summary
// of the SceneGraph tree (tag/subtype counts, ids, focused node) and whether a keypress moves focus.
// Non-shipping: this dir is not in package.json "files".

const IP = process.argv[2] || '192.168.2.210';
const APP = process.argv[3] || 'dev';
const BASE = `http://${IP}:8060`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, text: await r.text() }; }
async function post(p) { const r = await fetch(`${BASE}${p}`, { method: 'POST' }); return r.status; }

// crude, schema-agnostic XML introspection
function summarizeTree(xml) {
  const tags = {};
  for (const m of xml.matchAll(/<([A-Za-z][\w.:-]*)\b/g)) {
    const t = m[1];
    if (t === 'sgnodes' || t === '?xml') continue;
    tags[t] = (tags[t] || 0) + 1;
  }
  const ids = [...xml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const focused = [...xml.matchAll(/<([^>]*\bfocused="true"[^>]*)>/g)].map((m) => m[1].slice(0, 160));
  const texts = [...xml.matchAll(/\btext="([^"]{1,40})"/g)].map((m) => m[1]).slice(0, 8);
  return { total: Object.values(tags).reduce((a, b) => a + b, 0), tags, ids, focused, texts };
}

function focusSignature(xml) {
  // A stable-ish fingerprint of "what is focused" so we can detect a change after a keypress.
  const m = [...xml.matchAll(/<([^>]*\bfocused="true"[^>]*)>/g)].map((x) => x[1]);
  return m.join('\n');
}

async function fetchSgnodes() {
  // Try roots first (lighter), fall back to all.
  let r = await get('/query/sgnodes/roots');
  if (r.text.includes('<status>FAILED')) return r;
  return r;
}

(async () => {
  console.log(`# ECP spike → ${IP}\n`);

  const info = (await get('/query/device-info')).text;
  const fw = (info.match(/<software-version>([^<]+)/) || [])[1];
  const model = (info.match(/<model-name>([^<]+)/) || [])[1];
  console.log(`device: ${model} · firmware ${fw}`);

  console.log(`\nlaunching app '${APP}'…`);
  console.log('  /launch ->', await post(`/launch/${APP}`));

  // Wait for the channel to become the active app and for sgnodes to succeed.
  let sg = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    sg = await get('/query/sgnodes/all');
    if (!sg.text.includes('<status>FAILED')) break;
    if (i === 0 || i === 5) console.log(`  waiting for channel UI… (${sg.text.match(/<error>([^<]*)/)?.[1] || sg.status})`);
  }

  if (!sg || sg.text.includes('<status>FAILED')) {
    console.log('\n[!] sgnodes still FAILED after launch:\n', sg?.text?.slice(0, 200));
    return;
  }

  const before = summarizeTree(sg.text);
  console.log(`\n=== sgnodes tree (read the screen) — ${sg.text.length} bytes ===`);
  console.log(`total nodes: ${before.total}`);
  console.log(`distinct subtypes: ${Object.keys(before.tags).length}`);
  console.log('top subtypes:', Object.entries(before.tags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t}×${n}`).join(', '));
  console.log(`nodes with id=: ${before.ids.length}${before.ids.length ? '  e.g. ' + [...new Set(before.ids)].slice(0, 12).join(', ') : ''}`);
  console.log(`focused node(s): ${before.focused.length ? '\n  ' + before.focused.join('\n  ') : 'none reported'}`);
  console.log(`sample text= values: ${before.texts.join(' | ') || '(none)'}`);

  // Act: press Down, re-read, detect focus change.
  const sigBefore = focusSignature(sg.text);
  console.log('\n=== act: keypress Down, then re-read focus ===');
  await post('/keypress/Down');
  await sleep(700);
  const after = await get('/query/sgnodes/all');
  const sigAfter = focusSignature(after.text);
  console.log(`focus changed after Down: ${sigBefore !== sigAfter ? 'YES' : 'no (may be at an edge / non-focus screen)'}`);
  if (sigBefore !== sigAfter) {
    console.log('  before:', (sigBefore.split('\n')[0] || '').slice(0, 120));
    console.log('  after :', (sigAfter.split('\n')[0] || '').slice(0, 120));
  }

  // Leave the device where we found it-ish.
  await post('/keypress/Up');
  console.log('\n# done');
})().catch((e) => console.error('ERROR', e.message));
