#!/usr/bin/env node
// Empirical probe of a brs-node install against docs-model.json (from extract-docs.js).
// Generates BrightScript, runs it with the install's brs-cli (no device, no network targets), writes probe-raw.json.
//
// usage: node probe-api.js --install <dir containing node_modules/brs-node | brs-node package dir>
//                          [--model docs-model.json] [--out probe-raw.json] [--work <empty dir>] [--jobs 4] [--only globals,components,nodes]
//
// Method of detection (all verified against stock brs-node 2.7.0):
//   * CreateObject of an unknown class returns invalid and logs 'unknown classname'.
//   * obj.hasField(name) / getFieldType(name) for node fields.
//   * FindMemberFunction(obj, name) <> invalid  => method exists.
//   * Calling a member/global function with 8 `invalid` args raises "Type Mismatch ... function X(sig)" when it exists
//     (arity check runs before the body, so nothing executes) and "attempted on non-function" when it does not;
//     the message carries the emulated signature, which we record.
'use strict';
// Results must not depend on the machine: the engine reads the time zone and locale (dates, device info).
const PIN_ENV = { TZ: 'UTC', LC_ALL: 'C.UTF-8' };
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const argv = process.argv.slice(2); const A = {};
for (let i = 0; i < argv.length; i += 2) A[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!A.install) { console.error('need --install <brs-node install dir>'); process.exit(2); }
A.install = path.resolve(A.install);
const model = require(path.resolve(A.model || path.join(__dirname, 'docs-model.json')));
const OUT = A.out || path.join(__dirname, 'probe-raw.json');
const WORK = A.work || fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-probe-'));
const JOBS = +(A.jobs || 4);
const ONLY = (A.only || 'globals,components,nodes').split(',');
fs.mkdirSync(WORK, { recursive: true });

const cliCandidates = [path.join(A.install, 'node_modules/@ramonlobo/brs-node/bin/brs.cli.js'), path.join(A.install, 'node_modules/brs-node/bin/brs.cli.js'), path.join(A.install, 'bin/brs.cli.js')];
const CLI = cliCandidates.find((p) => fs.existsSync(p));
if (!CLI) { console.error('brs.cli.js not found under', A.install); process.exit(2); }
const pkgJson = path.join(path.dirname(CLI), '..', 'package.json');
const ENGINE = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const ARGS8 = 'invalid, invalid, invalid, invalid, invalid, invalid, invalid, invalid';
const HELPER = `
function bs(b as dynamic) as string
  if b = true then return "true"
  return "false"
end function
function pmsg(e as object) as string
  m = e.message
  if m = invalid then return "?"
  return m.Replace(chr(10), " / ").Replace(chr(13), "")
end function
sub pm(kind as string, name as string, status as string, extra = "" as string)
  print "@@P|" + kind + "|" + name + "|" + status + "|" + extra
end sub
`;

// Constructor arguments for components that need them (BrightScript expression strings).
const CTOR = {
  roArray: '(2, true)', roRegex: '("a(b)", "i")', roRegistrySection: '("probe")', roBitmap: '({ width: 16, height: 16, AlphaEnable: false })',
  roPath: '("pkg:/source/main.brs")', roAudioResource: '("select")', roTextureRequest: '("pkg:/images/x.png")',
  roSGNode: '("Group")', roScreen: '(false, 640, 480)', roInt: '(5)', roFloat: '(1.5)', roDouble: '(1.5)', roString: '', roBoolean: '(true)',
  roLongInteger: '(5)', roIntrinsicDouble: '(1.5)', roFunction: '', roInvalid: '',
};
const FALLBACK = { roSGNode: '("Node")' };

const DERIVE = {
  roRegion: 'bmp = CreateObject("roBitmap", { width: 16, height: 16, AlphaEnable: false })\n    obj = CreateObject("roRegion", bmp, 0, 0, 8, 8)',
  roSprite: 'bmp = CreateObject("roBitmap", { width: 16, height: 16, AlphaEnable: false })\n    reg = CreateObject("roRegion", bmp, 0, 0, 8, 8)\n    cmp = CreateObject("roCompositor")\n    obj = cmp.NewSprite(0, 0, reg)',
  roFont: 'fr = CreateObject("roFontRegistry")\n    obj = fr.GetDefaultFont()',
  roXMLList: 'x = CreateObject("roXMLElement")\n    x.Parse("<a><b/></a>")\n    obj = x.GetNamedElements("b")',
};
const BSLCORE = new Set(['asciitohex', 'hextoascii', 'hextointeger', 'dfnewbitmapset', 'dfdrawmessage', 'dfdrawimage', 'dfsetupdisplayregions', 'dfsetbackground', 'bslbrightscripterrorcodes', 'bslgeneralconstants', 'bsluniversalcontroleventcodes']);
function genGlobal(name) {
  const skip = { run: 1, stop: 1, end: 1 }; // variadic or flow-control: cannot be probed by arity
  if (skip[name.toLowerCase()]) return `sub main()\n  pm("global", ${q(name)}, "skipped", "effectful: not invoked")\nend sub\n` + HELPER;
  return `${BSLCORE.has(name.toLowerCase()) ? 'library "v30/bslCore.brs"\n' : ''}sub main()
  try
    r = ${name}(${ARGS8})
    pm("global", ${q(name)}, "present", "executed with 8 args (variadic?)")
  catch e
    pm("global", ${q(name)}, "caught", pmsg(e))
  end try
end sub
` + HELPER;
}

const IFLC = Object.fromEntries(Object.entries(model.interfaces).map(([k, v]) => [k.toLowerCase(), v]));
const ifaceByName = (n) => IFLC[n.toLowerCase()];
function ifaceMethodsFor(comp) {
  // interfaces the component documents + the methods those interfaces document
  const out = [];
  for (const iname of comp.interfaces) {
    const i = ifaceByName(iname); if (!i) { out.push({ iface: iname, method: null }); continue; }
    out.push({ iface: iname, method: null });
    for (const m of i.methods) out.push({ iface: iname, method: m.name });
  }
  for (const m of comp.directMethods || []) out.push({ iface: '(direct)', method: m.name });
  return out;
}

function genComponent(comp) {
  const n = comp.name; const a = CTOR[n] !== undefined ? CTOR[n] : '';
  const fb = FALLBACK[n] || '';
  const lines = [];
  lines.push('sub main()', '  obj = invalid');
  const create = (args, tag) => `  try
    obj = CreateObject(${q(n)}${args ? ', ' + args.slice(1, -1) : ''})
    if obj <> invalid then pm("create", ${q(n)}, "ok", ${q(tag)} + type(obj) + " | " + ${q(args || '()')})
  catch e
    pm("create", ${q(n)}, "exception", ${q(tag)} + pmsg(e))
  end try`;
  lines.push(create(a, 'args:'));
  if (a || fb) { lines.push('  if obj = invalid then'); lines.push(create(fb, 'noargs:').replace(/^/gm, '  ')); lines.push('  end if'); }
  if (DERIVE[n]) lines.push(`  if obj = invalid then
  try
    ${DERIVE[n]}
    if obj <> invalid then pm("create", ${q(n)}, "ok", "derived:" + type(obj))
  catch e
    pm("create", ${q(n)}, "exception", "derive:" + pmsg(e))
  end try
  end if`);
  lines.push(`  if obj = invalid then
    pm("create", ${q(n)}, "invalid")
    return
  end if`);
  for (const { iface, method } of ifaceMethodsFor(comp)) {
    if (method === null) {
      lines.push(`  try
    gi = GetInterface(obj, ${q(iface)})
    if gi <> invalid then pm("iface", ${q(n + '.' + iface)}, "present") else pm("iface", ${q(n + '.' + iface)}, "absent")
  catch e
    pm("iface", ${q(n + '.' + iface)}, "exception", pmsg(e))
  end try`);
    } else {
      const key = `${n}.${iface}.${method}`;
      lines.push(`  try
    ff = FindMemberFunction(obj, ${q(method)})
    fmf = "0"
    if ff <> invalid then fmf = "1"
  catch e
    fmf = "x"
  end try
  try
    obj.${method}(${ARGS8})
    pm("method", ${q(key)}, "present", "fmf=" + fmf + "; executed with 8 args")
  catch e
    pm("method", ${q(key)}, "caught", "fmf=" + fmf + "; " + pmsg(e))
  end try`);
    }
  }
  lines.push('end sub');
  return lines.join('\n') + '\n' + HELPER;
}

const SG_IFACE_PROBE_NODE = 'Node';
function genNode(node) {
  const n = node.name;
  const fields = new Map();
  for (const f of node.allFields) if (!fields.has(f.name.toLowerCase())) fields.set(f.name.toLowerCase(), f);
  for (const f of node.docOnlyFields || []) if (!fields.has(f.name.toLowerCase())) fields.set(f.name.toLowerCase(), f);
  const lines = ['sub main()', '  obj = invalid', `  try
    obj = CreateObject("roSGNode", ${q(n)})
  catch e
    pm("create", ${q(n)}, "exception", pmsg(e))
    return
  end try
  if obj = invalid then
    pm("create", ${q(n)}, "invalid")
    return
  end if
  st = "?"
  try
    st = obj.subtype()
  catch e
  end try
  pm("create", ${q(n)}, "ok", "subtype=" + st + " | " + type(obj))`];
  for (const par of node.extends) {
    lines.push(`  try
    pm("isSubtype", ${q(n + '>' + par)}, bs(obj.isSubtype(${q(par)})))
  catch e
    pm("isSubtype", ${q(n + '>' + par)}, "exception", pmsg(e))
  end try`);
  }
  for (const f of fields.values()) {
    if (!/^[A-Za-z_]\w*$/.test(f.name)) continue;
    lines.push(`  try
    pm("field", ${q(n + '.' + f.name)}, "p", bs(obj.hasField(${q(f.name)})) + "|" + obj.getFieldType(${q(f.name)}))
  catch e
    pm("field", ${q(n + '.' + f.name)}, "exception", pmsg(e))
  end try`);
  }
  // the node's own full field list (to find undocumented extras)
  lines.push(`  try
    ks = obj.getFields()
    s = ""
    for each k in ks
      s = s + k + ","
    end for
    pm("allfields", ${q(n)}, "ok", s)
  catch e
    pm("allfields", ${q(n)}, "exception", pmsg(e))
  end try`);
  if (n === SG_IFACE_PROBE_NODE) {
    for (const iname of node.interfaces) {
      const i = ifaceByName(iname); if (!i) continue;
      for (const m of i.methods) {
        const key = `roSGNode.${iname}.${m.name}`;
        lines.push(`  try
    ff = FindMemberFunction(obj, ${q(m.name)})
    fmf = "0"
    if ff <> invalid then fmf = "1"
  catch e
    fmf = "x"
  end try
  try
    obj.${m.name}(${ARGS8})
    pm("method", ${q(key)}, "present", "fmf=" + fmf + "; executed with 8 args")
  catch e
    pm("method", ${q(key)}, "caught", "fmf=" + fmf + "; " + pmsg(e))
  end try`);
      }
    }
  }
  lines.push('end sub');
  return lines.join('\n') + '\n' + HELPER;
}

// ---- runner ----
function run(file, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, file], { cwd: WORK, env: { ...process.env, FORCE_COLOR: '0', ...PIN_ENV } });
    let buf = ''; const kill = setTimeout(() => { buf += '\n@@TIMEOUT'; p.kill('SIGKILL'); }, 90000);
    p.stdout.on('data', (d) => (buf += d)); p.stderr.on('data', (d) => (buf += d));
    p.on('close', (code) => { clearTimeout(kill); resolve({ label, code, ms: Date.now() - t0, out: buf }); });
  });
}
function parse(out) {
  const recs = []; let cur = null; const diag = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@P|')) { const [, kind, name, status, ...rest] = line.split('|'); cur = { kind, name, status, extra: rest.join('|').trim(), diag: [] }; recs.push(cur); }
    else if (line.trim() && !/^-+ (Finished|Started)/.test(line) && !/^\s*$/.test(line)) { (cur ? cur.diag : diag).push(line.trim()); }
  }
  return { recs, diag };
}

(async () => {
  const jobs = [];
  const add = (cat, name, code) => { const f = path.join(WORK, `${cat}-${name.replace(/[^\w]/g, '_')}.brs`); fs.writeFileSync(f, code); jobs.push({ cat, name, f }); };
  if (ONLY.includes('globals')) {
    const names = new Set(Object.values(model.globals).map((g) => g.name));
    // names the docs list under other headings or which exist on devices but not in the docs' function tables
    ['GetLastRunRuntimeError', 'ObjFun', 'Eval', 'GetLastRunCompileError', 'CreateObject', 'AsciiToHex', 'HexToAscii', 'HexToInteger'].forEach((x) => names.add(x));
    for (const nme of names) add('globals', nme, genGlobal(nme));
  }
  if (ONLY.includes('components')) for (const c of Object.values(model.components)) add('components', c.name, genComponent(c));
  if (ONLY.includes('nodes')) for (const n of Object.values(model.nodes)) { if (/\s/.test(n.name)) continue; add('nodes', n.name, genNode(n)); }
  console.log(`engine ${ENGINE.name}@${ENGINE.version}; ${jobs.length} probe programs in ${WORK}`);
  const results = []; let next = 0, done = 0;
  const worker = async () => { while (next < jobs.length) { const j = jobs[next++]; const r = await run(j.f, j.cat + '/' + j.name); const p = parse(r.out); results.push({ cat: j.cat, name: j.name, code: r.code, ms: r.ms, timeout: /@@TIMEOUT/.test(r.out), recs: p.recs, diag: p.diag.slice(0, 8), rawTail: p.recs.length ? undefined : r.out.slice(-600) }); if (++done % 25 === 0) console.log(`  ${done}/${jobs.length}`); } };
  await Promise.all(Array.from({ length: JOBS }, worker));
  results.sort((a, b) => (a.cat + a.name).localeCompare(b.cat + b.name));
  fs.writeFileSync(OUT, JSON.stringify({ engine: { name: ENGINE.name, version: ENGINE.version }, node: process.version, ranAt: new Date().toISOString(), modelSources: model.sources, results }, null, 1));
  console.log('wrote', OUT);
})();
