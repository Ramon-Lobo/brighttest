'use strict';
// brighttest studio — Phase 0/1 client. Mirrors the device screenshot and overlays the resolved sgnodes
// tree (absolute coords from /api/tree). Hover a box to preview, click to pin; the remote pad drives the
// device so you can navigate and watch the overlay follow.

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const overlay = $('#overlay');
const shot = $('#shot');
let nodes = [];
let scene = { w: 1920, h: 1080 };
let pinned = null;       // path of the clicked node
let hovering = false;    // pause tree refresh while inspecting
let runHighlight = null; // selector of the step currently running (highlighted during a flow run)
let currentFlow = null;  // rel path of the open flow file

const TREE_MS = 300;   // the tree read is ~18ms — poll it fast so focus/boxes feel instant
const SHOT_MS = 900;   // the screenshot is ~1.1s — poll it on its own slower lane
let treeBusy = false, shotBusy = false, lastSig = '';

async function loadDevice() {
  try {
    const info = await (await fetch('/api/device')).json();
    $('#device').textContent = `${info.model || '?'} · fw ${info.firmware || '?'}`;
  } catch { $('#device').textContent = 'device error'; }
}

// One screenshot fetch (blob → object URL), guarded so we never stack requests.
async function grabShot() {
  if (shotBusy) return;
  shotBusy = true;
  try {
    const blob = await (await fetch('/api/screenshot?t=' + Date.now())).blob();
    const url = URL.createObjectURL(blob);
    const prev = shot.src;
    shot.src = url;
    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
  } catch {} finally { shotBusy = false; }
}

// One tree fetch, guarded; only re-render when the tree actually changed (avoids flicker under the cursor).
async function grabTree() {
  if (treeBusy) return;
  treeBusy = true;
  try {
    const data = await (await fetch('/api/tree')).json();
    if (data.error) { $('#status').textContent = data.error; return; }
    scene = data.scene; nodes = data.nodes;
    $('#status').textContent = `${nodes.length} nodes`;
    const sig = nodes.map((n) => n.path + (n.focused ? 'F' : '') + (n.abs ? `${n.abs.x},${n.abs.y}` : '')).join('|');
    if (sig !== lastSig) { lastSig = sig; if (!hovering) render(); }
  } catch { $('#status').textContent = 'tree error'; } finally { treeBusy = false; }
}

function drawable(n) {
  return n.abs && n.abs.w > 0 && n.abs.h > 0 && n.visible !== false &&
    ($('#showAll').checked || n.id || n.text || n.focusable || n.focused);
}

function render() {
  overlay.setAttribute('viewBox', `0 0 ${scene.w} ${scene.h}`);
  overlay.innerHTML = '';
  for (const n of nodes) {
    if (!drawable(n)) continue;
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', n.abs.x); r.setAttribute('y', n.abs.y);
    r.setAttribute('width', n.abs.w); r.setAttribute('height', n.abs.h);
    if (n.id) r.classList.add('id');
    if (n.focused) r.classList.add('focused');
    if (n.path === pinned || (runHighlight && nodeMatches(n, runHighlight))) r.classList.add('hot');
    r.addEventListener('mouseenter', () => { hovering = true; showDetail(n); });
    r.addEventListener('mouseleave', () => { hovering = false; });
    r.addEventListener('click', (e) => { e.stopPropagation(); pinned = n.path; showDetail(n); render(); });
    const t = document.createElementNS(SVGNS, 'title');
    t.textContent = `${n.subtype}${n.id ? '#' + n.id : ''}${n.text ? ' "' + n.text + '"' : ''}`;
    r.appendChild(t);
    overlay.appendChild(r);
  }
}

// Stable selector preview: id → text → subtype (mirrors the CLI's bestSelector).
function selectorFor(n) {
  if (n.id) return `{ id: ${n.id} }`;
  if (n.text) return `{ text: ${JSON.stringify(n.text)} }`;
  return `{ subtype: ${n.subtype} }`;
}

function showDetail(n) {
  const rows = [];
  const add = (k, v) => rows.push(`<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`);
  add('subtype', escapeHtml(n.subtype));
  if (n.id) add('id', escapeHtml(n.id));
  if (n.text != null) add('text', escapeHtml(JSON.stringify(n.text)));
  add('children', n.childCount);
  if (n.focused) add('focused', 'true');
  if (n.abs) add('abs', `{${n.abs.x}, ${n.abs.y}, ${n.abs.w}, ${n.abs.h}}`);
  for (const [k, v] of Object.entries(n.attrs || {})) {
    if (['name', 'text', 'bounds', 'visible', 'focused'].includes(k)) continue;
    add(k, escapeHtml(String(v)));
  }
  const sel = selectorFor(n);
  const inner = sel.slice(2, -2); // "id: foo" — reuse inside assertText
  const asserts = [`- assertVisible: ${sel}`];
  if (n.text) asserts.push(`- assertText: { ${inner}, equals: ${JSON.stringify(n.text)} }`);
  if (n.focused) asserts.push(`- assertFocused: ${sel}`);
  $('#detail').innerHTML =
    `<div class="title">${escapeHtml(n.subtype)}${n.id ? ' #' + escapeHtml(n.id) : ''}${n.text ? ' "' + escapeHtml(n.text) + '"' : ''}</div>` +
    `<table>${rows.join('')}</table>` +
    `<div class="assert"><div class="k">add assertion to flow</div>${asserts.map((a, i) => `<button class="addstep" data-i="${i}">+ ${escapeHtml(a)}</button>`).join('')}</div>`;
  $('#detail').querySelectorAll('.addstep').forEach((b) => b.addEventListener('click', () => addStepToFlow(asserts[+b.dataset.i])));
}

function nodeMatches(n, sel) {
  return (!sel.id || n.id === sel.id) && (!sel.text || n.text === sel.text) && (!sel.subtype || n.subtype === sel.subtype);
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function press(key) {
  await fetch('/api/keypress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  // Nudge both lanes right away: the tree (fast) shows the new focus almost immediately; the screenshot
  // needs the device to render the frame first, so give it a beat.
  setTimeout(grabTree, 100);
  setTimeout(grabShot, 300);
}

document.querySelectorAll('#remote button').forEach((b) => b.addEventListener('click', () => press(b.dataset.key)));
document.addEventListener('keydown', (e) => {
  const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Select', Backspace: 'Back' };
  if (map[e.key]) { e.preventDefault(); press(map[e.key]); }
});
$('#showAll').addEventListener('change', () => { lastSig = ''; render(); });

// ---- flows: browse / edit / save the real project files, and run them (M3 + M4) ----
function flowMsg(m, err) { const el = $('#flowMsg'); el.textContent = m; el.style.color = err ? '#ff6b6b' : '#8a8c99'; }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

async function loadFlows() {
  try {
    const { files } = await (await fetch('/api/flows')).json();
    const sel = $('#flowSelect'); const cur = sel.value;
    sel.innerHTML = '<option value="">— select a flow —</option>' +
      files.map((f) => `<option value="${escapeAttr(f.rel)}">${escapeHtml(f.name)}</option>`).join('');
    if (cur) sel.value = cur;
  } catch {}
}

async function openFlow(rel) {
  $('#runSteps').innerHTML = ''; flowMsg('');
  if (!rel) { currentFlow = null; $('#flowText').value = ''; return; }
  try {
    const { text } = await (await fetch('/api/flow?file=' + encodeURIComponent(rel))).json();
    currentFlow = rel; $('#flowText').value = text || '';
  } catch { flowMsg('could not open ' + rel, true); }
}

function newFlow() {
  let name = prompt('New flow file name (saved under flows/):', 'new.e2e.yaml');
  if (!name) return;
  if (!/\.e2e\.ya?ml$/i.test(name)) name += '.e2e.yaml';
  currentFlow = name;
  $('#flowText').value = 'appId: dev\nsteps:\n  - launch\n';
  $('#runSteps').innerHTML = '';
  const sel = $('#flowSelect');
  if (![...sel.options].some((o) => o.value === name)) sel.add(new Option(name, name));
  sel.value = name;
  flowMsg('new (unsaved)');
}

function addStepToFlow(line) {
  const ta = $('#flowText');
  if (!currentFlow && !ta.value) { flowMsg('open or create a flow first (＋)', true); return; }
  let t = ta.value; if (t && !t.endsWith('\n')) t += '\n';
  ta.value = t + '  ' + line + '\n';
  ta.scrollTop = ta.scrollHeight;
  flowMsg('added — unsaved');
}

async function saveFlow() {
  if (!currentFlow) { flowMsg('name a flow first (＋)', true); return; }
  try {
    const j = await (await fetch('/api/flow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: currentFlow, text: $('#flowText').value }) })).json();
    if (j.error) flowMsg('save failed: ' + j.error, true);
    else { flowMsg('saved ✓ ' + j.rel); loadFlows(); }
  } catch (e) { flowMsg('save failed: ' + e.message, true); }
}

function runFlow() {
  if (!currentFlow) { flowMsg('save the flow first', true); return; }
  const btn = $('#flowRun'); btn.disabled = true;
  const ol = $('#runSteps'); ol.innerHTML = '';
  let lis = [];
  const es = new EventSource('/api/run?file=' + encodeURIComponent(currentFlow));
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'start') {
      lis = d.steps.map((s) => { const li = document.createElement('li'); li.innerHTML = `<span class="mark">·</span>${s.index + 1}. ${escapeHtml(s.op)}`; ol.appendChild(li); return li; });
    } else if (d.type === 'step') {
      const li = lis[d.index]; if (!li) return;
      if (d.status === 'running') { li.className = 'running'; li.querySelector('.mark').textContent = '▶'; runHighlight = d.selector; if (!hovering) render(); }
      else if (d.status === 'pass') { li.className = 'pass'; li.innerHTML = `<span class="mark">✓</span>${d.index + 1}. ${escapeHtml(d.op)} <span class="k">${escapeHtml(d.detail || '')}</span>`; }
      else if (d.status === 'fail') { li.className = 'fail'; li.innerHTML = `<span class="mark">✗</span>${d.index + 1}. ${escapeHtml(d.op)} — ${escapeHtml(d.error || '')}`; }
    } else if (d.type === 'error') { flowMsg('run error: ' + d.error, true); runHighlight = null; es.close(); btn.disabled = false; }
    else if (d.type === 'done') { flowMsg(d.ok ? 'run passed ✓' : 'run failed ✗', !d.ok); runHighlight = null; if (!hovering) render(); es.close(); btn.disabled = false; }
  };
  es.onerror = () => { es.close(); btn.disabled = false; };
}

$('#flowSelect').addEventListener('change', (e) => openFlow(e.target.value));
$('#flowNew').addEventListener('click', newFlow);
$('#flowReload').addEventListener('click', loadFlows);
$('#flowSave').addEventListener('click', saveFlow);
$('#flowRun').addEventListener('click', runFlow);

// Self-scheduling loops: each waits for its own fetch to finish before scheduling the next, so requests
// never pile up (the old bug). Tree runs fast; screenshot runs on its slower lane, independently.
async function treeLoop() { if ($('#live').checked) await grabTree(); setTimeout(treeLoop, TREE_MS); }
async function shotLoop() { if ($('#live').checked) await grabShot(); setTimeout(shotLoop, SHOT_MS); }

loadDevice();
loadFlows();
treeLoop();
shotLoop();
