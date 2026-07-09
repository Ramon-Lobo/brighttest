// Poll sgnodes until the render thread is idle enough to answer, save the first good tree, and print its
// real schema (element tags + attribute names). node experiments/capture-tree.mjs <ip> <out.xml>
const IP = process.argv[2] || '192.168.2.210';
const OUT = process.argv[3] || '/tmp/tree-ok.xml';
const fs = await import('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let xml = null;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://${IP}:8060/query/sgnodes/all`);
    const t = await r.text();
    if (!t.includes('<status>FAILED')) { xml = t; break; }
  } catch (e) { /* transient */ }
  await sleep(800);
}
if (!xml) { console.log('never got a non-FAILED sgnodes response in ~32s'); process.exit(0); }

fs.writeFileSync(OUT, xml);
console.log(`captured ${xml.length} bytes → ${OUT}\n`);

// element tag histogram
const tags = {};
for (const m of xml.matchAll(/<([A-Za-z][\w.:-]*)[\s>]/g)) tags[m[1]] = (tags[m[1]] || 0) + 1;
// attribute-name histogram (multiline-safe)
const attrs = {};
for (const m of xml.matchAll(/\b([A-Za-z_][\w-]*)=/g)) attrs[m[1]] = (attrs[m[1]] || 0) + 1;

console.log('attribute names present:', Object.entries(attrs).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', '));
console.log('\ntop element tags:', Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}×${n}`).join(', '));
console.log('\n=== first 2200 chars ===\n' + xml.slice(0, 2200));
