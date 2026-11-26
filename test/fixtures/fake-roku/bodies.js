'use strict';
// Response bodies for the fake Roku. Shapes follow real-device captures, but every identifier is a
// synthetic placeholder: no real serials, device ids, MACs or LAN addresses (192.0.2.0/24 is TEST-NET-1).
const SERIAL = 'FAKE-SERIAL-0001';
const DEVICE_ID = 'FAKE-DEVICE-ID-0001';
const UDN = '00000000-0000-0000-0000-000000000000';
const IP = '192.0.2.10';

const XML = '<?xml version="1.0" encoding="UTF-8" ?>\n';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function deviceInfo({ limited = false, developerEnabled = true, softwareVersion = '16.0.4', softwareBuild = '853', modelName = 'Ultra', modelNumber = '0000XX' } = {}) {
  return XML + `<device-info>
	<udn>${UDN}</udn>
	<serial-number>${SERIAL}</serial-number>
	<device-id>${DEVICE_ID}</device-id>
	<advertising-id>FAKE-ADVERTISING-ID</advertising-id>
	<vendor-name>Fake</vendor-name>
	<model-name>${modelName}</model-name>
	<model-number>${modelNumber}</model-number>
	<is-tv>false</is-tv>
	<ui-resolution>1080p</ui-resolution>
	<wifi-mac>00:00:5E:00:53:01</wifi-mac>
	<network-type>ethernet</network-type>
	<friendly-device-name>Fake Roku</friendly-device-name>
	<default-device-name>${modelName} - ${SERIAL}</default-device-name>
	<software-version>${softwareVersion}</software-version>
	<software-build>${softwareBuild}</software-build>
	<ecp-setting-mode>${limited ? 'limited' : 'permissive'}</ecp-setting-mode>
	<language>en</language>
	<country>US</country>
	<locale>en_US</locale>
	<power-mode>PowerOn</power-mode>
	<developer-enabled>${developerEnabled}</developer-enabled>
</device-info>
`;
}

function activeApp(kind) {
  const inner = {
    dev: '<app id="dev" type="appl" version="1.0.0">Fake Channel</app>',
    roku: '<app>Roku</app>',
    'native-ui': '<app id="native-ui" type="appl" version="1.0.0">Native UI</app>',
    'dynamic-menu': '<app id="dynamic-menu" type="home" version="1.0.0">Dynamic Menu</app>',
  }[kind] || '<app>Roku</app>';
  return XML + `<active-app>\n\t${inner}\n</active-app>\n`;
}

function apps() {
  return XML + `<apps>
	<app id="1001" type="appl" version="1.0.0">Fake Streaming App</app>
	<app id="dev" type="appl" version="1.0.0">Fake Channel</app>
</apps>
`;
}

// A node model: { sn, type, attrs, children }. Rendered recursively.
function buildTree(kind, agentText, { focusIndex = 0, lateNode = null, netBody = null } = {}) {
  let sn = 0;
  const mk = (type, attrs = {}, children = []) => ({ sn: ++sn, type, attrs, children });
  if (kind === 'facade') return mk('OsdOverlay', { name: 'osd', bounds: '{0, 0, 1920, 1080}' });
  const scene = mk('MainScene', { extends: 'Scene', focused: 'true', bounds: '{0, 0, 1920, 1080}' });
  if (kind === 'dialog-root') {
    scene.type = 'SystemDialog';
    scene.attrs.extends = 'Group';
    scene.children.push(mk('Label', { name: 'title', text: 'System dialog' }));
    return scene;
  }
  scene.children.push(mk('Rectangle', { name: 'bg', color: '#101010ff', bounds: '{0, 0, 1920, 1080}' }));
  scene.children.push(mk('Label', { name: '__bt_agent', text: agentText, bounds: '{0, 0, 10, 10}' }));
  if (netBody !== null && netBody !== undefined) scene.children.push(mk('Label', { name: 'netBody', text: netBody, bounds: '{0, 10, 10, 10}' }));
  const total = { 'large-3k': 3000, 'large-6k': 6000 }[kind];
  if (total) {
    const queue = [scene];
    let made = 3; // scene + bg + agent label
    let qi = 0;
    while (made < total) {
      const parent = queue[qi];
      for (let i = 0; i < 10 && made < total; i++, made++) {
        const c = mk(i % 3 === 0 ? 'LayoutGroup' : 'Rectangle', { name: `n${sn + 1}` });
        parent.children.push(c);
        queue.push(c);
      }
      qi++;
    }
  } else if (kind === 'grid') {
    // Focusable grid: 3 columns x 2 rows, ids item1..item6; the focused item carries focused="true".
    const items = [];
    for (let i = 0; i < 6; i++) {
      const x = 100 + (i % 3) * 300, y = 100 + Math.floor(i / 3) * 200;
      items.push(mk('Poster', { name: `item${i + 1}`, focused: String(i === focusIndex), bounds: `{${x}, ${y}, 250, 150}` }));
    }
    scene.children.push(mk('MarkupGrid', { name: 'grid', focused: 'false', bounds: '{100, 100, 900, 350}' }, items));
  } else {
    const home = mk('Group', { name: 'home', focused: 'false' }, [
      mk('Label', { name: 'title', text: 'Home' }),
      mk('Poster', { name: 'hero', uri: 'pkg:/images/hero.png' }),
    ]);
    scene.children.push(home);
  }
  if (lateNode) scene.children.push(mk('Label', { name: lateNode, text: 'late' }));
  return scene;
}

function countNodes(n) { return 1 + n.children.reduce((a, c) => a + countNodes(c), 0); }

function renderNode(n, depth = 2) {
  const attrs = Object.entries({ ...n.attrs, _sn: n.sn }).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const pad = '\t'.repeat(depth);
  if (!n.children.length) return `${pad}<${n.type}${attrs} />\n`;
  return `${pad}<${n.type}${attrs}>\n${n.children.map((c) => renderNode(c, depth + 1)).join('')}${pad}</${n.type}>\n`;
}

function sgnodesAll(root) {
  return XML + `<sgnodes>\n\t<channel-id>dev</channel-id>\n\t<channel-title>Fake Channel</channel-title>\n\t<All_Nodes node-count="${countNodes(root)}">\n${renderNode(root, 2)}\t</All_Nodes>\n</sgnodes>\n`;
}

function sgnodesRoots(root) {
  return XML + `<sgnodes>\n\t<Root_Nodes node-count="1">\n\t\t<${root.type} extends="${root.attrs.extends || 'Group'}" _sn="${root.sn}" />\n\t</Root_Nodes>\n</sgnodes>\n`;
}

function find(n, id) {
  if (String(n.sn) === String(id) || n.attrs.name === id) return n;
  for (const c of n.children) { const r = find(c, id); if (r) return r; }
  return null;
}

function sgnodesNode(root, id) {
  const hit = find(root, id);
  if (!hit) return XML + '<sgnodes>\n\t<status>FAILED</status>\n\t<error>node not found</error>\n</sgnodes>\n';
  // Real shape (RAW-SHAPE-PROBE, fw 15.3.4 and 16.0.4): <Nodes_Nodes> holds a Default row plus the one
  // matched node, FLAT: it carries children="N" but no child elements.
  const attrs = Object.entries({ ...hit.attrs, _sn: hit.sn, children: hit.children.length }).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return XML + `<sgnodes>\n\t<status>OK</status>\n\t<Nodes_Nodes node-id="${esc(id)}" node-count="2">\n\t\t<Default extends="Node" />\n\t\t<${hit.type}${attrs} />\n\t</Nodes_Nodes>\n</sgnodes>\n`;
}

const sgnodesFailed = () => XML + '<sgnodes>\n\t<status>FAILED</status>\n</sgnodes>\n';

function appUi(root, dialog) {
  return XML + `<app-ui>\n\t<status>OK</status>\n\t<topscreen>\n\t\t<plugin id="dev" name="Fake Channel" />\n\t\t<screen type="${dialog ? 'SGDialog' : 'SGScreen'}" focused="true">\n${renderNode(root, 3)}\t\t</screen>\n\t</topscreen>\n</app-ui>\n`;
}

const installPage = (text) => `<html><head><title>Development Application Installer</title></head><body><h1>Development Application Installer</h1><p>${text}</p></body></html>\n`;

const SGPERF_REPORT = [
  'thread node calls: create     0 + op     1  @ 100.0% rendezvous',
  'thread node calls: create  1201 + op   902  @   0.0% rendezvous',
].join('\r\n');

const CHANPERF = 'channel: mem=28460KiB{anon=7288,file=20992,shared=180,swap=0},%cpu=0{user=0,sys=0}';

const consoleBanner = ({ modelName = 'Ultra', softwareVersion = '16.0.4', softwareBuild = '853' } = {}) =>
  `${SERIAL} (Roku ${modelName} - ${softwareVersion}.${softwareBuild})\r\n>`;
const CONSOLE_BANNER = consoleBanner();

// Scripted Rooibos run output (the markers lib/reporter.js parses). kind: 'pass' | 'fail'.
function rooibosTranscript(kind) {
  const fail = kind === 'fail';
  const lines = [
    '[Rooibos Result]: starting fake run',
    '> SUITE: FakeSuite >>>>>>>>>>>>>>>>>>>>',
    '  Location: file://pkg:/source/tests/FakeSuite.spec.bs:3',
    '>>>> It: adds numbers',
    '<<<< END It: adds numbers (PASS)',
    '  Location: file://pkg:/source/tests/FakeSuite.spec.bs:9',
    '>>>> It: subtracts numbers',
    `<<<< END It: subtracts numbers (${fail ? 'FAIL' : 'PASS'})`,
    '[START TEST REPORT]',
    '|--FakeSuite : ....... ' + (fail ? 'FAIL' : 'PASS'),
    '|  |--adds numbers : ....... PASS',
    '|  |--subtracts numbers : ....... ' + (fail ? 'FAIL' : 'PASS'),
  ];
  if (fail) lines.push('|  |    Error Message: Expected 3 but got 4');
  lines.push(
    '  Total: 2', `  Passed: ${fail ? 1 : 2}`, '  Crashed: 0', `  Failed: ${fail ? 1 : 0}`, '  Ignored: 0',
    `  RESULT: ${fail ? 'Fail' : 'Success'}`, '[END TEST REPORT]', `[Rooibos Result]: ${fail ? 'FAIL' : 'PASS'}`
  );
  return lines;
}

// ---- Perf ECP queries (read-only): /query/chanperf, /query/r2d2-bitmaps, /query/graphics-frame-rate ----
// Shapes follow the captures in test/studio-perf.test.js (including the firmware's "sytem-memory" spelling).
// All numbers are placeholders. Counters (proc-stat) grow a little per call so deltas are non-zero.
function perfFailed(root, error) {
  return XML + `<${root}><status>FAILED</status><error>${esc(error)}</error></${root}>`;
}
function chanperfOk(n = 0) {
  return XML + `<chanperf><timestamp>${1000 + n}</timestamp><plugin>
<cpu-percent><duration-seconds>1.000000</duration-seconds><user>${(8 + (n % 3) * 0.5).toFixed(1)}</user><sys>0.3</sys></cpu-percent>
<proc-stat><utime>${16000 + n * 10}</utime><stime>${700 + n}</stime><cutime>0</cutime><cstime>0</cstime><minflt>${90000 + n * 100}</minflt><majflt>${2800 + n}</majflt><starttime>1000</starttime><state>S</state><clk-tck>100</clk-tck></proc-stat>
<memory><used>${61956096 + n * 4096}</used><res>61956096</res><anon>39653376</anon><swap>0</swap><file>22122496</file><shared>180224</shared><limit>859832320</limit></memory>
</plugin><status>OK</status></chanperf>`;
}
// `count` bitmaps; bitmap 0 is the largest and carries `firstName` (raw text, XML-escaped here, control and
// bidi characters left as given); the others are pkg:/images/fake-NNNN.png with shrinking sizes.
function r2d2Ok({ count = 3, firstName = null } = {}) {
  const bitmaps = [];
  for (let i = 0; i < count; i++) {
    const name = i === 0 && firstName !== null ? firstName : `pkg:/images/fake-${String(i).padStart(4, '0')}.png`;
    const w = Math.max(1, 1920 - i), h = Math.max(1, 1080 - i);
    bitmaps.push(`<bitmap><width>${w}</width><height>${h}</height><size>${w * h * 4}</size><name>${esc(name)}</name></bitmap>`);
  }
  return XML + `<r2d2-bitmaps><timestamp>1</timestamp><channel-id>dev</channel-id><graphics-instances>
<rographics><sytem-memory><used>1255248</used></sytem-memory><texture-memory><used>130191360</used><available>109808640</available><max>240000000</max></texture-memory>
${bitmaps.join('\n')}
</rographics></graphics-instances></r2d2-bitmaps>`;
}
const frameRateOk = () => XML + '<graphics-frame-rate><timestamp>1</timestamp><frame-rate>59.5</frame-rate></graphics-frame-rate>';

const DEBUG_HISTORY = [
  '------ Compiling dev \'Fake Channel\' ------',
  '------ Running dev \'Fake Channel\' main ------',
  'FakeApp: scene created',
  'FakeApp: catalog loaded items=3',
];

const DEBUG_CRASH = [
  'BRIGHTSCRIPT: ERROR: roSGNode.setField: Type Mismatch. (runtime error &h18) in pkg:/components/Home.brs(42)',
  '------ Runtime Error: Type Mismatch. (runtime error &h18) in pkg:/components/Home.brs(42)',
  'Backtrace:',
  '#0  Function onKey(key as String, press as Boolean) As Boolean',
  '   file/line: pkg:/components/Home.brs(42)',
  'Local Variables:',
  'key                 roString refcnt=1 val:"OK"',
  'Brightscript Debugger> ',
];

module.exports = {
  SERIAL, DEVICE_ID, IP, deviceInfo, activeApp, apps, buildTree, sgnodesAll, sgnodesRoots, sgnodesNode,
  sgnodesFailed, appUi, installPage, SGPERF_REPORT, CHANPERF, CONSOLE_BANNER, consoleBanner, rooibosTranscript, DEBUG_HISTORY, DEBUG_CRASH,
  perfFailed, chanperfOk, r2d2Ok, frameRateOk,
};
