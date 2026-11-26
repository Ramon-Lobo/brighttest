#!/usr/bin/env node
// Runs (1) language-feature cases from language-cases.js and (2) the SceneGraph behavior apps in behavior/*/ against a brs-node install.
// Section 3 records event-object shapes: roSGNodeEvent (getField/getData/getNode/getRoSGNode/getInfo, infoFields),
// onKeyEvent(key, press) payloads + bubbling order, and native-component events (itemFocused/itemSelected/focusedChild). Keys are injected through a
// pty (python3 stdlib) because brs-node's CLI only reads the keyboard when stdin is a TTY. No device, no ECP, no network. Skipped with a note if python3 is missing.
// usage: node probe-behavior.js --install <dir containing node_modules/brs-node> [--work <empty dir>] [--out behavior-raw.json]
'use strict';
// Results must not depend on the machine: the engine reads the time zone and locale (dates, device info).
const PIN_ENV = { TZ: 'UTC', LC_ALL: 'C.UTF-8' };
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, execFileSync } = require('child_process');
const argv = process.argv.slice(2); const A = {}; for (let i = 0; i < argv.length; i += 2) A[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!A.install) { console.error('need --install'); process.exit(2); }
A.install = path.resolve(A.install);
const WORK = A.work || fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-beh-')); fs.mkdirSync(WORK, { recursive: true });
const OUT = A.out || path.join(__dirname, 'behavior-raw.json');
const CLI = [path.join(A.install, 'node_modules/@ramonlobo/brs-node/bin/brs.cli.js'), path.join(A.install, 'node_modules/brs-node/bin/brs.cli.js'), path.join(A.install, 'bin/brs.cli.js')].find(fs.existsSync);
if (!CLI) { console.error('brs.cli.js not found'); process.exit(2); }
const ENGINE = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), '..', 'package.json'), 'utf8'));
const run = (file) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, file], { cwd: WORK, env: { ...process.env, FORCE_COLOR: '0', ...PIN_ENV } });
  let buf = ''; const k = setTimeout(() => { buf += '\n@@TIMEOUT'; p.kill('SIGKILL'); }, 120000);
  p.stdout.on('data', (d) => (buf += d)); p.stderr.on('data', (d) => (buf += d));
  p.on('close', () => { clearTimeout(k); resolve(buf); });
});
const EVENTS_APP = {
  'manifest': String.raw`title=ev
major_version=1
minor_version=0
build_version=0
`,
  'source/main.brs': String.raw`' Event-shape probe. Prints "@@B|events|<id>|<value>". Keys are injected by a pty driver (see probe-behavior.js).
sub main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.setMessagePort(port)
  scene = screen.CreateScene("EvScene")
  screen.show()
  g = screen.getGlobalNode()
  g.addFields({ evSeq: 0, phase: 1 })
  scene.callFunc("shapes")
  scene.findNode("leaf").setFocus(true)
  emit("ready", "1")
  ' phase 1: keys land on leaf -> mid -> scene
  t0 = CreateObject("roTimespan")
  while t0.TotalMilliseconds() < 20000 and not scene.phase1done
    msg = wait(100, port)
  end while
  emit("phase1done", scene.phase1done)
  g.phase = 2
  ' phase 2: native components consume keys and raise events on the port
  lst = scene.findNode("lst") : btn = scene.findNode("btn")
  lst.observeField("itemFocused", port) : lst.observeField("itemSelected", port) : lst.observeField("itemUnfocused", port)
  btn.observeField("buttonSelected", port)
  scene.observeField("focusedChild", port)
  lst.setFocus(true)
  emit("phase2", "1")
  n = 0
  t0 = CreateObject("roTimespan")
  while t0.TotalMilliseconds() < 20000 and not scene.phase2done
    msg = wait(100, port)
    if type(msg) = "roSGNodeEvent" then
      n = n + 1
      d = msg.getData()
      emit("p2.ev" + n.ToStr(), msg.getField() + "|data=" + s(d) + "|tdata=" + type(d) + "|node=" + msg.getRoSGNode().subtype() + "|id=" + msg.getNode() + "|info=" + s(msg.getInfo()))
      if msg.getField() = "itemSelected" then btn.setFocus(true)
    else if msg <> invalid then
      emit("p2.ev" + n.ToStr(), "other:" + type(msg))
    end if
  end while
  emit("p2.event_count", n)
  emit("done", "1")
end sub
function s(v as dynamic) as string
  t = type(v)
  if t = "roString" or t = "String" then return v
  if t = "Integer" or t = "roInt" or t = "roInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" or t = "LongInteger" or t = "roLongInteger" then return v.ToStr()
  if t = "Boolean" or t = "roBoolean" then
    if v then return "true"
    return "false"
  end if
  if v = invalid then return "invalid"
  if t = "roSGNode" then return "node<" + v.subtype() + ":" + v.id + ">"
  if t = "roAssociativeArray" or t = "roArray" then return FormatJson(v)
  return "<" + t + ">"
end function
sub emit(id as string, v as dynamic)
  print "@@B|events|" + id + "|" + s(v).Replace(chr(10), "\n")
end sub
`,
  'components/EvScene.xml': String.raw`<?xml version="1.0" encoding="utf-8" ?>
<component name="EvScene" extends="Scene">
  <script type="text/brightscript" uri="pkg:/components/EvScene.brs" />
  <interface>
    <field id="phase1done" type="boolean" value="false" />
    <field id="phase2done" type="boolean" value="false" />
    <field id="aaF" type="assocarray" />
    <field id="arrF" type="array" />
    <field id="nodeF" type="node" />
    <field id="intF" type="integer" />
    <field id="strF" type="string" />
    <function name="shapes" />
  </interface>
  <children>
    <EvMid id="mid">
      <EvLeaf id="leaf" />
    </EvMid>
    <LabelList id="lst" translation="[600,100]" />
    <Button id="btn" text="B" translation="[600,400]" />
  </children>
</component>
`,
  'components/EvScene.brs': String.raw`sub init()
  c = CreateObject("roSGNode", "ContentNode")
  for i = 1 to 3
    k = c.createChild("ContentNode") : k.title = "i" + i.ToStr()
  end for
  m.top.findNode("lst").content = c
end sub
function onKeyEvent(key as string, press as boolean) as boolean
  logKey("scene", key, press, invalid)
  if press and key = "fastforward" then m.top.phase1done = true
  if press and key = "options" and m.global.phase = 2 then m.top.phase2done = true
  return false
end function
sub logKey(who, key, press, rv)
  g = m.global
  g.evSeq = g.evSeq + 1
  print "@@B|events|key." + Right("00" + g.evSeq.ToStr(), 3) + "." + who + "|key=" + key + "|press=" + tb(press) + "|tkey=" + type(key) + "|tpress=" + type(press) + "|len=" + key.Len().ToStr()
end sub
function tb(v) as string
  if type(v) = "Boolean" then
    if v then return "true"
    return "false"
  end if
  return "<" + type(v) + ">"
end function
sub cbShape(ev)
  d = ev.getData()
  info = ev.getInfo()
  t = type(d)
  ds = "?"
  if t = "roAssociativeArray" or t = "roArray" then
    ds = FormatJson(d)
  else if t = "roSGNode" then
    ds = d.subtype()
  else if d = invalid then
    ds = "invalid"
  else
    ds = d.ToStr()
  end if
  print "@@B|events|shape." + ev.getField() + "|evtype=" + type(ev) + "|tdata=" + t + "|data=" + ds + "|getNode=" + ev.getNode() + "|rosg=" + type(ev.getRoSGNode()) + "|infoType=" + type(info) + "|info=" + FormatJson(info)
end sub
function shapes()
  m.top.observeField("intF", "cbShape") : m.top.observeField("strF", "cbShape")
  m.top.observeField("aaF", "cbShape") : m.top.observeField("arrF", "cbShape") : m.top.observeField("nodeF", "cbShape")
  m.top.observeFieldScoped("intF", "cbShape")
  m.top.intF = 7
  m.top.strF = "x"
  m.top.aaF = { a: 1, b: [1, 2] }
  m.top.arrF = [1, "two", 3.5]
  m.top.nodeF = CreateObject("roSGNode", "Group")
  ' infoFields (3rd arg of observeField)
  m.top.unobserveField("intF")
  m.top.unobserveFieldScoped("intF")
  r = m.top.observeField("intF", "cbShape", ["strF", "intF"])
  print "@@B|events|shape.infoFields_ret|" + tb(r)
  m.top.intF = 8
  ' interface of the event object
  p = CreateObject("roMessagePort")
  n = CreateObject("roSGNode", "Node")
  n.addField("f", "integer", false)
  n.observeField("f", p)
  n.f = 1
  e = p.GetMessage()
  mem = ""
  for each nm in ["getField", "getData", "getNode", "getRoSGNode", "getInfo", "isSGNodeEvent", "GetInt", "GetString"]
    if FindMemberFunction(e, nm) <> invalid then mem = mem + nm + ","
  end for
  print "@@B|events|shape.members|" + mem
  print "@@B|events|shape.msgtype|" + type(e) + "|valid=" + type(e.getData())
  try
    print "@@B|events|shape.tostr|" + e.ToStr()
  catch ex
    print "@@B|events|shape.tostr|EXC:" + ex.message
  end try
  print "@@B|events|shape.members_on_event|" + type(FindMemberFunction(e, "getData"))
  ei = GetInterface(e, "ifSGNodeEvent")
  print "@@B|events|shape.ifSGNodeEvent|" + type(ei)
  return invalid
end function
`,
  'components/EvMid.xml': String.raw`<?xml version="1.0" encoding="utf-8" ?>
<component name="EvMid" extends="Group">
  <script type="text/brightscript" uri="pkg:/components/EvMid.brs" />
</component>
`,
  'components/EvMid.brs': String.raw`function onKeyEvent(key as string, press as boolean) as boolean
  g = m.global
  g.evSeq = g.evSeq + 1
  b = "false" : if press then b = "true"
  print "@@B|events|key." + Right("00" + g.evSeq.ToStr(), 3) + ".mid|key=" + key + "|press=" + b
  return false
end function
`,
  'components/EvLeaf.xml': String.raw`<?xml version="1.0" encoding="utf-8" ?>
<component name="EvLeaf" extends="Group">
  <script type="text/brightscript" uri="pkg:/components/EvLeaf.brs" />
</component>
`,
  'components/EvLeaf.brs': String.raw`function onKeyEvent(key as string, press as boolean) as boolean
  g = m.global
  g.evSeq = g.evSeq + 1
  b = "false" : if press then b = "true"
  print "@@B|events|key." + Right("00" + g.evSeq.ToStr(), 3) + ".leaf|key=" + key + "|press=" + b
  if key = "up" then return true
  return false
end function
`,
};
const EVENTS_DRIVER = String.raw`import os, pty, sys, time, select, signal
# usage: drive.py <node> <cli> <zip> <cwd> <out> ; sends key sequences at markers
node, cli, zp, cwd, out = sys.argv[1:6]
P1 = [b'\x1b[A', b'\x1b[B', b'\x1b[D', b'\r', b'\x1b[3~', b'\x7f', b'\x1b[F', b'\x1b[2~', b'a', b'\x1b[6~']   # up down left select back replay play options lit_a fwd(ends phase 1)
P2 = [b'\x1b[B', b'\r', b'\r', b'\x1b[2~']  # list down, list select (moves focus to button), button select, info (ends)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.environ['FORCE_COLOR'] = '0'
    os.execv(node, [node, cli, zp])
buf = b''; sent = {'1': False, '2': False}; deadline = time.time() + 60
log = []
def count(): return buf.count(b'@@B|events|key.') + buf.count(b'@@B|events|p2.')
def pump(secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return
            if d: buf += d
def send(keys):
    # the engine drops some TTY keys under timing jitter: wait for an observable effect, resend once, and record it
    for k in keys:
        before = count(); tries = 0
        while True:
            try: os.write(fd, k)
            except OSError: log.append('write failed (child gone) at %r' % k); return
            tries += 1; pump(1.2)
            if count() > before or tries >= 2: break
        pump(0.3)
        log.append('%r tries=%d delivered=%s' % (k, tries, count() > before))
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
    if b'@@B|events|ready' in buf and not sent['1']: sent['1'] = True; time.sleep(0.5); send(P1)
    if b'@@B|events|phase2' in buf and not sent['2']: sent['2'] = True; time.sleep(0.5); send(P2)
    if b'@@B|events|done' in buf: time.sleep(0.3); break
try: os.kill(pid, signal.SIGKILL)
except OSError: pass
try: os.waitpid(pid, 0)
except OSError: pass
open(out, 'wb').write(buf)
open(out + '.sends', 'w').write('\n'.join(log))
`;
(async () => {
  const lang = require('./language-cases.js'); const results = { engine: { name: ENGINE.name, version: ENGINE.version }, ranAt: new Date().toISOString(), language: [], behavior: {} };
  const jobs = lang.map((c) => async () => {
    const f = path.join(WORK, `lang-${c.id}.brs`);
    fs.writeFileSync(f, `sub main()\n  r = invalid\n${c.code}\n  print "@@L|${c.id}|" + tos(r)\nend sub\nfunction tos(v as dynamic) as string\n  if v = invalid then return "invalid"\n  t = type(v)\n  if t = "roString" or t = "String" then return v\n  return v.ToStr()\nend function\n`);
    const out = await run(f);
    const m = out.match(new RegExp(`@@L\\|${c.id}\\|(.*)`));
    const status = m ? 'ran' : /Syntax Error|compile error/i.test(out) ? 'syntax-error' : 'crash';
    const actual = m ? m[1].trim() : null;
    results.language.push({ id: c.id, feature: c.feature, expect: c.expect, expectSrc: c.src, status, actual, match: c.expect === null ? null : actual === c.expect, diag: m ? undefined : out.split('\n').filter((l) => /error|Error|Mismatch/.test(l)).slice(0, 2).join(' / ') });
  });
  let next = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (next < jobs.length) await jobs[next++](); }));
  results.language.sort((a, b) => a.id.localeCompare(b.id));
  const bdir = path.join(__dirname, 'behavior');
  for (const app of fs.readdirSync(bdir)) {
    const zip = path.join(WORK, app + '.zip'); try { fs.rmSync(zip); } catch (e) {}
    execFileSync('zip', ['-qr', zip, '.'], { cwd: path.join(bdir, app) });
    const out = await run(zip); fs.writeFileSync(path.join(WORK, app + ".out.txt"), out);
    const recs = {}; const diag = [];
    for (const l of out.replace(/\r/g, '').split('\n')) { const m = l.match(/^@@B\|[^|]*\|([^|]*)\|(.*)$/); if (m) recs[m[1]] = m[2]; else if (/ERROR|WARNING|Warning|Error/.test(l)) diag.push(l.trim()); }
    results.behavior[app] = { complete: 'done' in recs, count: Object.keys(recs).length, values: recs, diag: diag.slice(0, 60) };
  }
  // ---- 3. event-object shapes (key injection via pty) ----
  results.events = { skipped: 'python3 not found' };
  try {
    execFileSync('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore' });
    const eroot = path.join(WORK, 'events-app'); fs.rmSync(eroot, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(EVENTS_APP)) { const f = path.join(eroot, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
    const ezip = path.join(WORK, 'events.zip'); try { fs.rmSync(ezip); } catch (e) {}
    execFileSync('zip', ['-qr', ezip, '.'], { cwd: eroot });
    const drv = path.join(WORK, 'drive-keys.py'); fs.writeFileSync(drv, EVENTS_DRIVER);
    const eout = path.join(WORK, 'events.out.txt');
    try { execFileSync('python3', ['-I', drv, process.execPath, CLI, ezip, WORK, eout], { timeout: 90000, stdio: 'ignore', env: { ...process.env, ...PIN_ENV } }); } catch (e) { /* driver kills the child; partial output is still parsed */ }
    const raw = fs.existsSync(eout) ? fs.readFileSync(eout, 'utf8') : '';
    const recs = {}; const keys = []; const diag = [];
    for (const l of raw.replace(/\r/g, '').split('\n')) {
      const m = l.match(/^@@B\|events\|([^|]*)\|(.*)$/);
      if (m) { recs[m[1]] = m[2]; const k = m[1].match(/^key\.(\d+)\.(\w+)$/); if (k) { const f = Object.fromEntries(m[2].split('|').map((p) => p.split('=')).filter((p) => p.length === 2)); keys.push({ seq: +k[1], node: k[2], ...f }); } }
      else if (/ERROR|WARNING|Warning|Error|pkg:\//.test(l)) diag.push(l.trim());
    }
    const sends = fs.existsSync(eout + '.sends') ? fs.readFileSync(eout + '.sends', 'utf8').split('\n').filter(Boolean) : [];
    results.events = { sends, complete: 'done' in recs, count: Object.keys(recs).length, keyEventsSeen: keys.length, keyEvents: keys, values: recs, diag: diag.slice(0, 40), note: 'keys sent: up down left select back replay play options lit_a fwd (phase 1, bubbling leaf>mid>scene); down select select options (phase 2, LabelList/Button)' };
  } catch (e) { results.events = { skipped: String(e.message).split('\n')[0] }; }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  const l = results.language; console.log(`language: ${l.length} cases, ${l.filter((x) => x.status !== 'ran').length} did not run, ${l.filter((x) => x.match === false).length} mismatch vs expected; behavior apps: ${Object.entries(results.behavior).map(([k, v]) => k + ':' + v.count + (v.complete ? '' : ' INCOMPLETE')).join(', ')} -> ${OUT}; events: ${results.events.skipped ? 'skipped (' + results.events.skipped + ')' : results.events.count + ' records, ' + results.events.keyEventsSeen + ' key events' + (results.events.complete ? '' : ' INCOMPLETE')}`);
})();
