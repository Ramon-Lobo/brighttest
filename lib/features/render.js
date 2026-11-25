'use strict'
// `features render`: one self-contained HTML report from a validated feature tree and its graph. Pure string
// templating: no file, process or network access in `renderReport` (the command wiring `runRender` reads and writes).
//
//   renderReport(tree, graph, opts) -> { html, warnings[], css, js, csp }
//     opts: { check?: validate() result (its warnings show in the header), ci?: assess ci section | null,
//             assess?: { path, blockers[] } | null, currentTreeHash?: string, rowCap?, maxBytes?, version? }
//   runRender(o, ctx, UsageError) -> Promise<exitCode>
//
// Every string that reaches the page goes through esc() and every attribute is quoted. The CSS and the one script are
// constants per version, so the CSP hashes (and the output for the same graph and tree) are deterministic. The script
// only adds convenience (filter, expand and collapse all, path tabs, theme toggle): the page is complete without it.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const S = require('./schema')
const { classRank, CLASS_ORDER, PRIMARY_CLASSES } = require('./testability')
const { orderFeatures, suggest, DEP_KINDS } = require('./cluster')
const { buildSkeleton } = require('./digest')
const { validate } = require('./check')
const overlay = require('./overlay')

const ROW_CAP = 500
const MAX_BYTES = 8 * 1024 * 1024
const CLASSES = [...CLASS_ORDER, 'unknown']
const NO_DEP_CONF = new Set(['builtin', 'unresolved', 'dynamic'])
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
const nodeAnchor = (id) => `n-${sha1(id).slice(0, 10)}`
const featAnchor = (id) => (S.SLUG_RE.test(String(id)) ? `f-${id}` : `n-${sha1(id).slice(0, 10)}`)
const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} bytes`)
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`

// ---- themes (the single source for the CSS custom properties; the contrast test reads the generated CSS) -----------
const THEMES = {
  light: {
    '--bg': '#ffffff', '--fg': '#1b1f24', '--muted': '#4a5560', '--link': '#0b5cad', '--surface': '#f3f5f8', '--border': '#8b95a1',
    '--c-headless-unit-bg': '#d5eedb', '--c-headless-unit-fg': '#0f4a1c',
    '--c-headless-scene-bg': '#d3e9f4', '--c-headless-scene-fg': '#0a405a',
    '--c-headless-fixtures-bg': '#e2dff6', '--c-headless-fixtures-fg': '#31256f',
    '--c-device-bg': '#fde5c4', '--c-device-fg': '#6a3800',
    '--c-e2e-bg': '#f7d6e2', '--c-e2e-fg': '#7a1a3d',
    '--c-unknown-bg': '#ffffff', '--c-unknown-fg': '#3a434d',
    '--r-low-bg': '#e4f2e8', '--r-low-fg': '#17491f',
    '--r-medium-bg': '#fff1c7', '--r-medium-fg': '#5a4100',
    '--r-high-bg': '#fbd9d9', '--r-high-fg': '#7a1212',
    '--rec-bg': '#1b1f24', '--rec-fg': '#ffffff',
    '--warn-bg': '#fff1c7', '--warn-fg': '#4d3700',
  },
  dark: {
    '--bg': '#12161b', '--fg': '#e6e9ed', '--muted': '#a9b3be', '--link': '#7db7f0', '--surface': '#1b2129', '--border': '#6b7683',
    '--c-headless-unit-bg': '#1c3d27', '--c-headless-unit-fg': '#c5ecd0',
    '--c-headless-scene-bg': '#183748', '--c-headless-scene-fg': '#c3e3f4',
    '--c-headless-fixtures-bg': '#2d2a4f', '--c-headless-fixtures-fg': '#d8d4f7',
    '--c-device-bg': '#4a3412', '--c-device-fg': '#fbdca8',
    '--c-e2e-bg': '#4a1f33', '--c-e2e-fg': '#f6cfdf',
    '--c-unknown-bg': '#12161b', '--c-unknown-fg': '#c9d0d8',
    '--r-low-bg': '#1c3d27', '--r-low-fg': '#c5ecd0',
    '--r-medium-bg': '#4a3d12', '--r-medium-fg': '#fbe9a8',
    '--r-high-bg': '#4d1d1d', '--r-high-fg': '#f8cccc',
    '--rec-bg': '#e6e9ed', '--rec-fg': '#12161b',
    '--warn-bg': '#4a3d12', '--warn-fg': '#fbe9a8',
  },
}
// Text-on-background pairs the contrast test measures in both themes (all must reach WCAG AA, 4.5:1).
const CONTRAST_PAIRS = [
  ['--fg', '--bg'], ['--muted', '--bg'], ['--link', '--bg'], ['--fg', '--surface'], ['--muted', '--surface'], ['--link', '--surface'],
  ...CLASSES.map((c) => [`--c-${c}-fg`, `--c-${c}-bg`]),
  ['--r-low-fg', '--r-low-bg'], ['--r-medium-fg', '--r-medium-bg'], ['--r-high-fg', '--r-high-bg'],
  ['--rec-fg', '--rec-bg'], ['--warn-fg', '--warn-bg'],
]

const block = (sel, vars) => `${sel}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`
const CSS = `
${block(':root', THEMES.light)}
${block(':root[data-theme=light]', THEMES.light)}
@media (prefers-color-scheme: dark){${block(':root:not([data-theme=light])', THEMES.dark)}}
${block(':root[data-theme=dark]', THEMES.dark)}
*{box-sizing:border-box}
html{color-scheme:light dark}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header,nav,main{max-width:1180px;margin:0 auto;padding:0 20px}
header{padding-top:20px;padding-bottom:8px;border-bottom:1px solid var(--border)}
main{padding-top:8px;padding-bottom:48px}
h1{font-size:1.7rem;margin:.2em 0}
h2{font-size:1.3rem;margin:1.8em 0 .5em;padding-top:.4em;border-top:1px solid var(--border)}
h3{font-size:1.1rem;margin:1.3em 0 .4em}
h4{font-size:1rem;margin:1.1em 0 .3em;color:var(--muted)}
a{color:var(--link)}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible,.scroll:focus-visible{outline:3px solid var(--link);outline-offset:2px}
.skip{position:absolute;left:-999px;top:0;background:var(--bg);color:var(--fg);padding:8px 12px;z-index:10}
.skip:focus{left:8px;top:8px}
nav{padding-top:8px;padding-bottom:8px}
nav ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px}
#tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
#tools[hidden]{display:none}
#tools input{font:inherit;padding:4px 8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:4px}
#tools button{font:inherit;padding:4px 10px;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:4px;cursor:pointer}
#tools button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.badge{display:inline-block;padding:0 .5em;border-radius:.8em;border:1px solid var(--border);font-size:.82rem;line-height:1.5;white-space:nowrap;margin:0 .15em}
${CLASSES.map((c) => `.c-${c}{background:var(--c-${c}-bg);color:var(--c-${c}-fg)}`).join('\n')}
.c-unknown{border-style:dashed}
.r-low{background:var(--r-low-bg);color:var(--r-low-fg)}
.r-medium{background:var(--r-medium-bg);color:var(--r-medium-fg)}
.r-high{background:var(--r-high-bg);color:var(--r-high-fg)}
.rec{background:var(--rec-bg);color:var(--rec-fg)}
.banner{background:var(--warn-bg);color:var(--warn-fg);border:1px solid var(--border);border-radius:6px;padding:8px 14px;margin:10px 0}
.banner ul{margin:.3em 0 0;padding-left:1.2em}
.muted{color:var(--muted)}
.scroll{overflow-x:auto;margin:.5em 0}
table{border-collapse:collapse;width:100%;font-size:.93rem}
caption{text-align:left;color:var(--muted);padding:4px 0}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
thead th{background:var(--surface)}
tbody th{font-weight:600;background:var(--surface)}
td.n,th.n{text-align:right}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:.5em 0}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0;overflow-wrap:anywhere}
ul.tree,ul.tree ul{list-style:none;margin:.2em 0;padding-left:1.4em}
ul.tree{padding-left:0}
ul.tree details{margin:.2em 0}
summary{cursor:pointer}
article{border:1px solid var(--border);border-radius:6px;padding:4px 16px 12px;margin:14px 0;background:var(--surface)}
article h3{margin-top:.6em}
ol.steps>li{margin:.8em 0}
ol.steps ul{margin:.2em 0}
section[hidden]{display:none}
@media (prefers-reduced-motion: no-preference){html{scroll-behavior:smooth}}
@media print{.skip,nav,#tools{display:none}body{background:#fff;color:#000}details:not([open])>*:not(summary){display:block}a{color:#000}article{break-inside:avoid}}
`
const JS = `
(function () {
  var d = document, r = d.documentElement;
  function theme() { var m = /theme=(dark|light)/.exec(location.hash); if (m) r.setAttribute('data-theme', m[1]); }
  theme(); addEventListener('hashchange', theme);
  var bar = d.getElementById('tools');
  if (!bar) return;
  function el(tag, text, attrs) { var e = d.createElement(tag); if (text) e.textContent = text; for (var k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; }
  var q = el('input', '', { type: 'search', id: 'filter', 'aria-label': 'Filter features' });
  var lab = el('label', 'Filter features ', { 'for': 'filter' });
  var count = el('span', '', { role: 'status', 'class': 'muted' });
  function items() { return Array.prototype.slice.call(d.querySelectorAll('[data-f]')); }
  q.addEventListener('input', function () {
    var t = q.value.toLowerCase(), shown = 0, all = items();
    all.forEach(function (e) { var ok = !t || e.textContent.toLowerCase().indexOf(t) >= 0; e.hidden = !ok; if (ok && e.tagName === 'ARTICLE') shown++; });
    count.textContent = t ? shown + ' features match' : '';
  });
  function all(open) { Array.prototype.forEach.call(d.querySelectorAll('#tree details'), function (x) { x.open = open; }); }
  var ex = el('button', 'Expand all', { type: 'button' }), co = el('button', 'Collapse all', { type: 'button' });
  ex.addEventListener('click', function () { all(true); }); co.addEventListener('click', function () { all(false); });
  var th = el('button', 'Toggle theme', { type: 'button' });
  th.addEventListener('click', function () {
    var cur = r.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    r.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });
  bar.appendChild(lab); bar.appendChild(q); bar.appendChild(count); bar.appendChild(ex); bar.appendChild(co);
  var paths = Array.prototype.slice.call(d.querySelectorAll('[data-path]'));
  if (paths.length) {
    var tabs = [['both', 'Both paths'], ['leaf-first', 'Leaf-first'], ['base-first', 'Base-first']].map(function (p) {
      var b = el('button', p[1], { type: 'button', 'aria-pressed': p[0] === 'both' ? 'true' : 'false' });
      b.addEventListener('click', function () {
        tabs.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        paths.forEach(function (s) { s.hidden = p[0] !== 'both' && s.getAttribute('data-path') !== p[0]; });
      });
      return b;
    });
    tabs.forEach(function (b) { bar.appendChild(b); });
  }
  bar.appendChild(th);
  bar.hidden = false;
})();
`
const sha256b64 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64')
const cspFor = (css, js) => `default-src 'none'; style-src 'sha256-${sha256b64(css)}'; script-src 'sha256-${sha256b64(js)}'; img-src data:; base-uri 'none'; form-action 'none'`

// ---- CI mapping (design: one row per class; the commands come from docs/guide/ci.md) -----------------------------
const CI_DOC = 'docs/guide/ci.md'
const GATE_SECTION = 'GitHub Actions — headless gate (with coverage)'
const DEVICE_SECTION = 'Device lane — fidelity check (optional)'
const LEASE = 'takes the lease itself; set BRIGHTTEST_AGENT=ci:<run id> and BRIGHTTEST_LEASE_WAIT, use a concurrency group, exit 75 on timeout (ci.md, Sharing the device with local agents)'
const CI_ROWS = {
  'headless-unit': { runner: 'hosted (plain runner)', job: 'fast gate', cmd: 'npx brighttest --no-sgnode --junit reports/unit.xml', lease: 'none' },
  'headless-scene': { runner: 'hosted', job: 'headless gate', cmd: 'npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml', lease: 'none' },
  'headless-fixtures': { runner: 'hosted', job: 'headless gate', cmd: 'npx brighttest --coverage --lcov coverage/lcov.info --junit reports/junit.xml', lease: 'none' },
  device: { runner: "self-hosted runner on the device's network", job: 'nightly device job', cmd: 'npx brighttest --cross-check --host "$ROKU_HOST" --password "$ROKU_PASSWORD"', lease: LEASE },
  e2e: { runner: 'self-hosted', job: 'e2e job', cmd: 'npx brighttest e2e run flows/...', lease: LEASE },
  unknown: { runner: 'none', job: 'classify first', cmd: 'none: classify the node first (a human or the agent), then pick its job', lease: 'none' },
}
const label = (c) => (c === 'unknown' ? 'not classified' : c)
const badge = (c) => `<span class="badge c-${esc(c)}"${c === 'unknown' ? ' title="unknown"' : ''}>${esc(label(c))}</span>`
const riskBadge = (r) => (['low', 'medium', 'high'].includes(r) ? `<span class="badge r-${r}">risk: ${r}</span>` : '')
const code = (s) => `<code>${esc(s)}</code>`

// ---- model -------------------------------------------------------------------------------------------------------
function buildModel(tree, graph, opts = {}) {
  const nodes = new Map()
  for (const n of graph.nodes || []) if (n && typeof n.id === 'string') nodes.set(n.id, n)
  const features = (Array.isArray(tree.features) ? tree.features : []).filter(isObj).map((f, i) => ({ ...f, idx: i, members: (Array.isArray(f.members) ? f.members : []).filter((m) => typeof m === 'string') }))
  const owner = new Map() // node id -> feature index | 'ignored'
  features.forEach((f) => f.members.forEach((m) => { if (!owner.has(m)) owner.set(m, f.idx) }))
  const ignoredSet = new Set()
  for (const g of Array.isArray(tree.ignored) ? tree.ignored : []) if (isObj(g) && Array.isArray(g.members)) for (const m of g.members) if (typeof m === 'string') { ignoredSet.add(m); if (!owner.has(m)) owner.set(m, 'ignored') }
  const overrides = new Map() // node id -> { class, reason, evidence }
  for (const f of features) for (const o of (f.testability && Array.isArray(f.testability.overrides)) ? f.testability.overrides : []) if (isObj(o) && typeof o.node === 'string' && CLASS_ORDER.includes(o.class)) overrides.set(o.node, o)
  const ruleClass = (n) => (n && n.testability && n.testability.primary && n.testability.primary.class) || 'unknown'
  const effClass = (id) => { const n = nodes.get(id); if (!n || !n.testability) return null; return overrides.has(id) ? overrides.get(id).class : ruleClass(n) }
  const evidenceOf = (id) => {
    const base = baseEvidence(id)
    const ran = overlay.evidenceText(opts.overlay, id)
    return ran ? (base === 'none' ? ran : `${base}; ${ran}`) : base
  }
  const baseEvidence = (id) => {
    const n = nodes.get(id); const o = overrides.get(id)
    if (o) return ruleClass(n) === 'unknown' ? 'agent judgement' : `override${o.evidence ? ` (evidence: ${o.evidence})` : ''}`
    return (n && n.testability && n.testability.evidence === 'none') || ruleClass(n) === 'unknown' ? 'none' : 'rule'
  }
  const classified = (f) => f.members.filter((m) => nodes.has(m) && nodes.get(m).testability)
  const mixOf = (ids) => { const mix = Object.fromEntries(CLASSES.map((c) => [c, 0])); for (const id of ids) { const c = effClass(id); if (c) mix[c]++ } return mix }
  for (const f of features) { f.nodeIds = classified(f); f.mix = mixOf(f.nodeIds) }
  // feature dependencies, computed from the graph edges (never authored)
  const dep = new Map(features.map((f) => [f.idx, new Map()])) // idx -> Map(idx -> ambiguous)
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!e || !DEP_KINDS.has(e.kind) || NO_DEP_CONF.has(e.conf)) continue
    const a = owner.get(e.from)
    if (typeof a !== 'number') continue
    const targets = e.to ? [e.to] : (Array.isArray(e.candidates) ? e.candidates : [])
    for (const t of targets) {
      const b = owner.get(t)
      if (typeof b !== 'number' || b === a) continue
      const m = dep.get(a); if (!m.has(b)) m.set(b, true)
      if (e.conf !== 'ambiguous') m.set(b, false)
    }
  }
  const usedBy = new Map(features.map((f) => [f.idx, new Set()]))
  for (const [a, m] of dep) for (const b of m.keys()) usedBy.get(b).add(a)
  return { nodes, features, owner, overrides, ruleClass, effClass, evidenceOf, dep, usedBy, ignoredSet }
}

function orderInput(M, tree, graph) {
  const feats = M.features.map((f) => ({
    id: f.id, shared: f.kind === 'shared', files: f.members.filter((m) => (M.nodes.get(m) || {}).kind === 'file').length,
    nodes: f.nodeIds.map((id) => { const n = M.nodes.get(id); return { id, class: M.ruleClass(n), rule: (n.testability.primary && n.testability.primary.rule) || undefined, alsoNeeds: [...new Set((Array.isArray(n.testability.alsoNeeds) ? n.testability.alsoNeeds : []).filter(isObj).map((a) => a.class))] } }),
  }))
  const ids = new Set(feats.map((f) => f.id))
  const idOf = (i) => M.features[i].id
  const deps = []
  for (const [a, m] of M.dep) for (const [b, amb] of m) if (ids.has(idOf(a)) && ids.has(idOf(b))) deps.push({ from: idOf(a), to: idOf(b), ambiguous: amb })
  const entryNode = (graph.nodes || []).find((n) => n && n.id === 'entry:main')
  const entryOwner = entryNode ? M.owner.get('entry:main') : undefined
  const shell = M.features.find((f) => f.kind === 'app-shell')
  const entry = typeof entryOwner === 'number' ? idOf(entryOwner) : shell ? shell.id : null
  const overrides = {}; for (const [k, v] of M.overrides) overrides[k] = v.class
  return { input: { features: feats, deps, entry }, overrides }
}

// ---- HTML pieces -------------------------------------------------------------------------------------------------
function table(caption, head, rows, opts = {}) {
  const cap = opts.cap || ROW_CAP
  const shown = rows.slice(0, cap)
  const th = head.map((h, i) => `<th scope="col"${opts.numeric && opts.numeric.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')
  const body = shown.map((r) => `<tr>${r.map((c, i) => (i === 0 && opts.rowHeader ? `<th scope="row">${c}</th>` : `<td${opts.numeric && opts.numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`)).join('')}</tr>`).join('\n')
  const more = rows.length > cap ? `<p class="muted">${rows.length - cap} more in graph.json</p>` : ''
  return `<div class="scroll" role="region" tabindex="0" aria-label="${esc(caption)}"><table><caption>${esc(caption)}</caption><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table></div>${more}`
}
const mixText = (mix) => CLASSES.filter((c) => mix[c]).map((c) => `${label(c)} ${mix[c]}`).join(', ') || 'no classified nodes'
const featLink = (M, i) => `<a href="#${esc(featAnchor(M.features[i].id))}">${esc(M.features[i].name)}</a>`
const nodeRef = (id) => `<a href="#${esc(nodeAnchor(id))}">${code(id)}</a>`
const sections = [['summary', 'Summary'], ['tree', 'Feature tree'], ['panels', 'Feature details'], ['paths', 'Test paths'], ['matrix', 'Headless versus device'], ['ci', 'CI checklist'], ['uncertainty', 'Uncertainty'], ['method', 'Method and provenance']]

function summarySection(M, tree, graph, opts, totals) {
  const nf = [...M.nodes.values()].filter((n) => n.kind === 'file').length
  const nc = [...M.nodes.values()].filter((n) => n.kind === 'component').length
  const res = graph.resolution || {}
  const rec = tree.paths && S.PATHS.includes(tree.paths.recommended) ? tree.paths : null
  const L = []
  L.push('<section id="summary" aria-labelledby="h-summary"><h2 id="h-summary">Summary</h2>')
  L.push('<dl class="kv">')
  L.push(`<dt>Features</dt><dd>${M.features.length}</dd>`)
  L.push(`<dt>Graph</dt><dd>${plural(nf, 'file')}, ${plural(nc, 'component')}, ${plural(res.edgesTotal || 0, 'edge')}</dd>`)
  L.push(`<dt>Call sites resolved</dt><dd>${esc(res.callSitesResolvedPct === undefined ? 'unknown' : res.callSitesResolvedPct + '%')}</dd>`)
  if (res.sites) L.push(`<dt>Unresolved sites</dt><dd>${esc(`${res.sites.callfunc.unresolved} of ${plural(res.sites.callfunc.sites, 'callFunc site')}, ${res.sites.observes.unresolved} of ${plural(res.sites.observes.sites, 'observeField site')}`)}</dd>`)
  L.push(`<dt>Class mix</dt><dd>${CLASSES.filter((c) => totals.mix[c]).map((c) => `${badge(c)} ${totals.mix[c]}`).join(' ') || 'no classified nodes'}</dd>`)
  L.push(`<dt>Headless-testable</dt><dd>${totals.headless} nodes (unit, scene, fixtures)</dd>`)
  L.push(`<dt>Needs a device</dt><dd>${totals.device} nodes (device, e2e)</dd>`)
  if (opts.overlay) {
    const st = opts.overlay.stats
    const lv = { 'ran-headless': 0, 'ran-device': 0 }
    for (const [id, v] of opts.overlay.nodes) if (M.nodes.has(id)) { if (v['ran-headless'] > 0) lv['ran-headless']++; if (v['ran-device'] > 0) lv['ran-device']++ }
    L.push(`<dt>Run evidence</dt><dd><span class="badge">ran-headless</span> ${plural(lv['ran-headless'], 'node')}, <span class="badge">ran-device</span> ${plural(lv['ran-device'], 'node')} (${plural(st.junitFiles, 'JUnit file')}, ${plural(st.lcovFiles, 'LCOV file')}; ${plural(st.mapped, 'case')} mapped to a spec, ${st.unmapped} not mapped)</dd>`)
  }
  if (rec) L.push(`<dt>Recommended path</dt><dd><span class="badge rec">recommended</span> ${esc(rec.recommended)}: ${esc(rec.reason)}</dd>`)
  if (opts.assess) {
    L.push(`<dt>Assess path</dt><dd>${esc(opts.assess.path)}</dd>`)
    const b = opts.assess.blockers || []
    L.push(`<dt>Assess blockers</dt><dd>${b.length ? `<ul>${b.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : 'none'}</dd>`)
  }
  L.push('</dl>')
  if (totals.mix.unknown > 0) L.push(`<p class="banner" role="note">${totals.mix.unknown} nodes not classified: the agent or a human must classify them.</p>`)
  L.push('</section>')
  return L.join('\n')
}

function treeSection(M) {
  const seen = new Set()
  const li = (i, first) => {
    const f = M.features[i]
    seen.add(i)
    const kids = [...M.dep.get(i).keys()].sort((a, b) => a - b)
    const kidHtml = kids.map((k) => {
      if (seen.has(k)) return `<li>&rarr; ${featLink(M, k)}${M.features[k].kind === 'shared' ? ' (shared)' : ''}, see above</li>`
      return li(k, false)
    }).join('')
    const inner = `<p>${esc(f.summary || '')}</p><p><a href="#${esc(featAnchor(f.id))}">Open the details panel</a></p>${kidHtml ? `<p class="muted">Depends on:</p><ul>${kidHtml}</ul>` : ''}`
    return `<li data-f="${esc(featAnchor(f.id))}"><details${first ? ' open' : ''}><summary>${esc(f.name)} ${f.kind ? `<span class="badge">${esc(f.kind)}</span>` : ''}${riskBadge(f.risk)} ${CLASSES.filter((c) => f.mix[c]).map((c) => badge(c)).join('')}</summary>${inner}</details></li>`
  }
  const roots = M.features.filter((f) => M.usedBy.get(f.idx).size === 0).map((f) => f.idx)
  const entryFirst = roots.sort((a, b) => (M.features[b].kind === 'app-shell') - (M.features[a].kind === 'app-shell') || a - b)
  const parts = []
  for (const r of entryFirst) if (!seen.has(r)) parts.push(li(r, true))
  for (const f of M.features) if (!seen.has(f.idx)) parts.push(li(f.idx, true)) // cycles with no outside root
  return `<section id="tree" aria-labelledby="h-tree"><h2 id="h-tree">Feature tree</h2><p class="muted">Each feature is listed once. A dependency already shown is a link.</p><ul class="tree">${parts.join('\n')}</ul></section>`
}

function panel(M, tree, graph, f, opts, ruleSteps) {
  const cap = opts.rowCap
  const inF = new Set(f.members)
  const L = []
  const aid = featAnchor(f.id)
  L.push(`<article id="${esc(aid)}" data-f="${esc(aid)}" aria-labelledby="h-${esc(aid)}">`)
  L.push(`<h3 id="h-${esc(aid)}">${esc(f.name)}</h3>`)
  L.push(`<p>${f.kind ? `<span class="badge">${esc(f.kind)}</span>` : ''}${riskBadge(f.risk)} ${CLASSES.filter((c) => f.mix[c]).map((c) => `${badge(c)} ${f.mix[c]}`).join(' ')}</p>`)
  L.push(`<p>${esc(f.summary || '')}</p>`)
  if (f.notes) L.push(`<p class="muted">${esc(f.notes)}</p>`)
  // node testability
  L.push('<h4>Members and testability</h4>')
  const rows = f.members.map((m) => {
    const n = M.nodes.get(m)
    const c = M.effClass(m)
    const prim = n && n.testability && n.testability.primary
    const needs = prim && Array.isArray(prim.needs) ? prim.needs.map((x) => `${x.need}${x.rule ? ` (${x.rule})` : ''}`) : []
    const also = n && n.testability && Array.isArray(n.testability.alsoNeeds) ? n.testability.alsoNeeds.filter(isObj).map((a) => `${a.class}${a.aspect ? ` (${a.aspect})` : ''}`) : []
    const notes = n && n.testability && Array.isArray(n.testability.notes) ? n.testability.notes : []
    const ov = M.overrides.get(m)
    return [`<span id="${esc(nodeAnchor(m))}">${code(m)}</span>`, c ? badge(c) : '<span class="muted">n/a</span>', c ? esc(M.overrides.has(m) ? 'override' : (prim && prim.rule) || 'none') : '', c ? esc(M.evidenceOf(m)) : '', esc([...needs, ...also].join(', ')),
      esc([...(c === 'unknown' ? ['not classified: no rule fired and no override'] : []), ...(ov ? [ov.reason] : []), ...notes].join('; '))]
  })
  L.push(table(`Members of ${f.name}`, ['Node', 'Class', 'Rule', 'Evidence', 'Needs and also needs', 'Notes'], rows, { cap, rowHeader: true }))
  // dependencies
  L.push('<h4>Depends on and used by</h4>')
  const drows = []
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!e || !DEP_KINDS.has(e.kind) || e.conf === 'builtin') continue
    const fromIn = inF.has(e.from)
    const targets = e.to ? [e.to] : (Array.isArray(e.candidates) && e.candidates.length ? e.candidates : [null])
    for (const t of targets) {
      const toIn = t !== null && inF.has(t)
      let dir = null; let other = null
      if (fromIn && !toIn) { dir = 'depends on'; other = t } else if (!fromIn && toIn) { dir = 'used by'; other = e.from }
      if (!dir) continue
      const ow = other === null ? undefined : M.owner.get(other)
      const where = other === null ? `<span class="muted">${esc(e.conf)}</span>` : typeof ow === 'number' ? featLink(M, ow) : ow === 'ignored' ? 'ignored' : '<span class="muted">outside the tree</span>'
      drows.push([dir, other === null ? '<span class="muted">(no single target)</span>' : code(other), where, esc(e.kind), esc(e.conf), esc(e.at || '')])
    }
  }
  drows.sort((a, b) => cmp(a.join('\u0000'), b.join('\u0000')))
  L.push(drows.length ? table(`Dependencies of ${f.name}`, ['Direction', 'Node', 'Feature', 'Edge', 'Confidence', 'At'], drows, { cap }) : '<p class="muted">No dependencies on other features.</p>')
  // specs
  const specs = f.members.filter((m) => (M.nodes.get(m) || {}).spec)
  const covers = new Map()
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) if (e && e.kind === 'spec-covers' && e.to && inF.has(e.to)) { if (!covers.has(e.from)) covers.set(e.from, new Set()); covers.get(e.from).add(e.to) }
  const specIds = [...new Set([...specs, ...covers.keys()])].sort(cmp)
  L.push('<h4>Existing specs</h4>')
  L.push(specIds.length ? `<ul>${specIds.map((s) => `<li>${code(s)}${covers.has(s) ? ` covers ${[...covers.get(s)].sort(cmp).map(code).join(', ')}` : ''}</li>`).join('')}</ul>` : '<p class="muted">None found in the graph.</p>')
  // proposed tests
  L.push('<h4>Proposed tests</h4>')
  const pt = Array.isArray(f.proposedTests) ? f.proposedTests.filter(isObj) : []
  if (pt.length) {
    L.push(table(`Proposed tests for ${f.name}`, ['Target', 'Lane', 'Needs', 'Title', 'Why'], pt.map((t) => {
      const unclassified = M.effClass(t.target) === 'unknown'
      return [typeof t.target === 'string' ? code(t.target) : '', typeof t.lane === 'string' ? badge(t.lane) : '', esc(Array.isArray(t.needs) ? t.needs.join(', ') : ''), esc(t.title || ''), esc(`${t.why || ''}${unclassified ? ' (node not classified: the lane is a guess)' : ''}`)]
    }), { cap: S.CAPS.proposedTestsPerFeature }))
  } else L.push('<p class="muted">None authored. The test paths below list what the rules suggest for each step.</p>')
  // overrides
  const ovs = [...M.overrides].filter(([id]) => inF.has(id))
  if (ovs.length) L.push(`<h4>Overrides</h4><ul>${ovs.map(([id, o]) => `<li>${code(id)} set to ${badge(o.class)}: ${esc(o.reason || '')}${o.evidence ? ` (evidence: ${esc(o.evidence)})` : ' (agent judgement)'}</li>`).join('')}</ul>`)
  // CI jobs
  const jobs = CLASSES.filter((c) => f.mix[c])
  L.push('<h4>CI jobs</h4>')
  L.push(jobs.length ? `<p>${jobs.map((c) => `${badge(c)} ${esc(CI_ROWS[c].job)}`).join('; ')}</p>` : '<p class="muted">No classified nodes.</p>')
  // uncertainty
  const items = ((graph.uncertainty && Array.isArray(graph.uncertainty.items)) ? graph.uncertainty.items : []).filter((u) => isObj(u) && typeof u.at === 'string' && inF.has(`file:${u.at.replace(/:\d+$/, '')}`))
  if (items.length) L.push(`<h4>Uncertainty here</h4><ul>${items.slice(0, 10).map((u) => `<li>${esc(u.kind)} at ${code(u.at)}${u.detail ? `: ${esc(String(u.detail).slice(0, 160))}` : ''}</li>`).join('')}${items.length > 10 ? `<li class="muted">${items.length - 10} more in graph.json</li>` : ''}</ul>`)
  void tree; void ruleSteps
  L.push('</article>')
  return L.join('\n')
}

const PATH_TABLE = [
  ['Order', 'reverse topological order of the condensed feature graph; shared first, then cheaper class, fewer files', 'from the entry: the app shell, then features by distance from the entry'],
  ['First tests', 'characterization unit specs on pure functions of the leaves, then scene specs', 'launch smoke (an e2e flow if a device is available, else a headless spec of the root Scene init), then one scene spec per screen'],
  ['Dependencies below the step', 'already tested', 'stubbed with test doubles; network and store faked'],
  ['Device needed early?', 'no; device and e2e steps come last', 'yes, if the launch smoke is a flow (the headless fallback is listed)'],
  ['Best when', 'a big shared core has no tests, refactors are planned, or there is no device', 'the product wants journey coverage fast, a device is available, or the code is screen-heavy'],
  ['Risk', 'slow to show user-visible value', 'stubs hide integration bugs until the lower layers get tests'],
]
function pathsSection(M, tree, graph, opts) {
  const { input, overrides } = orderInput(M, tree, graph)
  const rec = tree.paths && tree.paths.recommended
  const L = ['<section id="paths" aria-labelledby="h-paths"><h2 id="h-paths">Test paths</h2>']
  L.push(table('Leaf-first compared with base-first', ['', 'Leaf-first (bottom-up)', 'Base-first (top-down)'], PATH_TABLE.map((r) => r.map(esc)), { rowHeader: true }))
  L.push('<p class="muted">The same steps are listed twice below. Without JavaScript both paths are shown in sequence.</p>')
  const byFeature = new Map(M.features.map((f) => [f.id, f]))
  for (const mode of S.PATHS) {
    const steps = orderFeatures(input, mode, { overrides })
    const title = mode === 'leaf-first' ? 'Leaf-first (bottom-up)' : 'Base-first (top-down)'
    L.push(`<section id="path-${mode}" data-path="${mode}" aria-labelledby="h-path-${mode}"><h3 id="h-path-${mode}">${title}${rec === mode ? ' <span class="badge rec">recommended</span>' : ''}</h3>`)
    if (rec === mode && tree.paths.reason) L.push(`<p>${esc(tree.paths.reason)}</p>`)
    if (!steps.length) L.push('<p class="muted">No features.</p>')
    L.push('<ol class="steps">')
    for (const s of steps) {
      const fs = s.features.map((id) => byFeature.get(id)).filter(Boolean)
      const classes = [...new Set(s.nodes.map((n) => n.class))].sort((a, b) => classRank(a) - classRank(b))
      const mix = Object.fromEntries(CLASSES.map((c) => [c, s.nodes.filter((n) => n.class === c).length]))
      const authored = []
      const rule = []
      for (const f of fs) {
        const own = Array.isArray(f.proposedTests) ? f.proposedTests.filter(isObj) : []
        if (own.length) authored.push(...own.map((t) => ({ target: t.target, lane: t.lane, title: t.title })))
        else { const inF = new Set(f.members); rule.push(...s.proposedTests.filter((t) => inF.has(t.target)).map((t) => ({ target: t.target, lane: t.lane }))) }
      }
      const tests = [...authored, ...rule]
      L.push(`<li><strong>Step ${s.step}</strong>: ${fs.map((f) => featLink(M, f.idx)).join(', ')}${s.label ? ` <span class="badge">${esc(s.label)}</span>` : ''}${(s.flags || []).map((x) => ` <span class="badge">${esc(x)}</span>`).join('')}`)
      L.push('<ul>')
      if (s.launchSmoke) L.push(`<li>Launch smoke: ${esc(s.launchSmoke.primary)} flow if a device is available; otherwise ${esc(s.launchSmoke.fallback)}.</li>`)
      L.push(`<li>Nodes: ${esc(mixText(mix))}</li>`)
      if (s.firstTests.length) L.push(`<li>First tests: ${s.firstTests.slice(0, 8).map(nodeRef).join(', ')}${s.firstTests.length > 8 ? ` and ${s.firstTests.length - 8} more` : ''}</li>`)
      if (tests.length) L.push(`<li>Proposed tests${authored.length ? ' (from the tree)' : ' (from the rules)'}: ${tests.slice(0, 12).map((t) => `${typeof t.target === 'string' ? nodeRef(t.target) : ''} ${typeof t.lane === 'string' ? badge(t.lane) : ''}${t.title ? ' ' + esc(t.title) : ''}`).join('; ')}${tests.length > 12 ? `; ${tests.length - 12} more` : ''}</li>`)
      const runnable = classes.filter((c) => c !== 'unknown')
      if (runnable.length) L.push(`<li>Command and CI job: ${[...new Set(runnable.map((c) => `${code(CI_ROWS[c].cmd)} (${esc(CI_ROWS[c].job)})`))].join('; ')}</li>`)
      if (mode === 'base-first' && s.stubbed.length) L.push(`<li>Stub: ${s.stubbed.slice(0, 8).map((id) => code(id)).join(', ')}${s.stubbed.length > 8 ? ` and ${s.stubbed.length - 8} more` : ''} (test doubles; network and store faked)</li>`)
      if (s.notClassified.length) L.push(`<li>Not classified: needs the agent or a human: ${s.notClassified.slice(0, 8).map((n) => `${nodeRef(n.id)}${n.alsoNeeds.length ? ` (also needs ${esc(n.alsoNeeds.join(', '))})` : ''}`).join(', ')}${s.notClassified.length > 8 ? ` and ${s.notClassified.length - 8} more` : ''}</li>`)
      L.push('<li>Done when: the new specs fail when the behaviour is broken, then pass.</li>')
      L.push('</ul></li>')
    }
    L.push('</ol></section>')
  }
  void opts
  L.push('</section>')
  return L.join('\n')
}

function matrixSection(M, totals) {
  const head = ['Feature', 'Headless total', 'Device total', ...CLASS_ORDER, 'Not classified']
  const sum = (mix, cs) => cs.reduce((a, c) => a + mix[c], 0)
  const rows = M.features.map((f) => [`<a href="#${esc(featAnchor(f.id))}">${esc(f.name)}</a>`, String(sum(f.mix, ['headless-unit', 'headless-scene', 'headless-fixtures'])), String(sum(f.mix, ['device', 'e2e'])), ...CLASSES.map((c) => String(f.mix[c]))])
  rows.push(['All features', String(totals.headless), String(totals.device), ...CLASSES.map((c) => String(totals.mix[c]))])
  return `<section id="matrix" aria-labelledby="h-matrix"><h2 id="h-matrix">Headless versus device</h2><p class="muted">Node counts by effective class. Nodes that are not classified are counted only in their own column, never in a headless or device total.</p>${table('Node counts per feature and class', head, rows, { rowHeader: true, numeric: head.map((_, i) => i).slice(1) })}</section>`
}

function ciSection(M, opts, totals) {
  const ci = opts.ci
  const items = []
  const needDevice = M.features.filter((f) => f.mix.device + f.mix.e2e > 0).length
  if (!ci || !isObj(ci)) items.push(`No CI information was available for this run. Add the headless gate job (${CI_DOC}, section '${GATE_SECTION}').`)
  else {
    const systems = Array.isArray(ci.systems) ? ci.systems : []
    const gha = systems.includes('github-actions')
    if (!systems.length) items.push(`No CI configuration found. Add the headless gate job (${CI_DOC}, section '${GATE_SECTION}').`)
    else items.push(`${systems.join(', ')} found${ci.runsBrighttest ? ' and it already runs brighttest: check it uses the commands below' : ` but nothing runs brighttest. Add the headless gate job (${CI_DOC}, section '${GATE_SECTION}')`}.`)
    const nv = Array.isArray(ci.nodeVersions) ? ci.nodeVersions : []
    if (nv.length && ci.nodeOk === false) items.push(`Node ${nv.join('/')} found: ${gha ? "set `node-version: '22'`" : 'use Node 22 or newer'}.`)
    else if (nv.length) items.push(`Node ${nv.join('/')} found: new enough.`)
    else if (systems.length) items.push(`No Node version is pinned: ${gha ? "set `node-version: '22'`" : 'use Node 22 or newer'}.`)
  }
  const unit = M.features.filter((f) => f.mix['headless-unit'] > 0).length
  if (unit) items.push(`${plural(unit, 'feature has', 'features have')} pure-function nodes: run the fast gate (${CI_ROWS['headless-unit'].cmd}) on every push.`)
  if (totals.headless) items.push(`${totals.headless} headless-testable nodes: run the headless gate (${CI_ROWS['headless-scene'].cmd}).`)
  const sh = ci && ci.selfHosted
  items.push(needDevice
    ? `${needDevice} of ${M.features.length} features have a device or e2e node: ${sh ? `a self-hosted runner is already configured, so add the nightly device job (${CI_DOC}, sections '${DEVICE_SECTION}' and 'Sharing the device with local agents')` : 'add the nightly device job only when you have a self-hosted runner on the device network'}.`
    : `No feature has a device or e2e node: no self-hosted runner is needed for this tree.`)
  if (totals.mix.unknown > 0) items.push(`${totals.mix.unknown} nodes not classified: classify first. No CI job is suggested for them until the agent or a human gives them a class.`)
  items.push('This report does not generate workflow files: copy the templates from the CI guide so there is one source.')
  const rows = CLASSES.map((c) => [badge(c), esc(CI_ROWS[c].runner), esc(CI_ROWS[c].job), code(CI_ROWS[c].cmd), esc(CI_ROWS[c].lease)])
  return `<section id="ci" aria-labelledby="h-ci"><h2 id="h-ci">CI checklist</h2><p>Get the tests running in CI:</p><ol>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>${table('CI job per class', ['Class', 'Runner', 'Job', 'Command', 'Lease'], rows, { rowHeader: true })}<p class="muted">Commands and sections are from ${esc(CI_DOC)}.</p></section>`
}

function uncertaintySection(M, graph) {
  const u = graph.uncertainty || {}
  const counts = Object.entries(u.counts || {}).sort((a, b) => cmp(a[0], b[0]))
  const items = Array.isArray(u.items) ? u.items.filter(isObj) : []
  const deviceAspects = new Map()
  for (const n of M.nodes.values()) if (n.testability) for (const a of Array.isArray(n.testability.alsoNeeds) ? n.testability.alsoNeeds.filter(isObj) : []) if (a.class === 'device') deviceAspects.set(a.aspect || 'device', (deviceAspects.get(a.aspect || 'device') || 0) + 1)
  const L = ['<section id="uncertainty" aria-labelledby="h-uncertainty"><h2 id="h-uncertainty">Uncertainty</h2>']
  L.push(counts.length ? table('Uncertainty by kind', ['Kind', 'Count'], counts.map(([k, v]) => [esc(k), String(v)]), { rowHeader: true, numeric: [1] }) : '<p>The graph reports no uncertainty.</p>')
  if (items.length) L.push(`<h3 id="h-unc-items">Top items</h3><ul>${items.slice(0, 20).map((i) => `<li>${esc(i.kind)} at ${code(i.at)}${i.detail ? `: ${esc(String(i.detail).slice(0, 160))}` : ''}</li>`).join('')}${(u.total || 0) > 20 ? `<li class="muted">${u.total - 20} more in graph.json</li>` : ''}</ul>`)
  L.push('<h3 id="h-device">What cannot be known without a device</h3>')
  L.push('<p>Static analysis predicts the lane of each node. These need a device to confirm:</p><ul>')
  for (const [k, v] of [...deviceAspects].sort((a, b) => cmp(a[0], b[0]))) L.push(`<li>${esc(k)}: ${plural(v, 'node')} with a device-only aspect</li>`)
  for (const b of Array.isArray(u.blindSpots) ? u.blindSpots : []) L.push(`<li>${esc(typeof b === 'string' ? b : JSON.stringify(b))}</li>`)
  L.push('<li>Real wall-clock timing, rendering, key handling and platform behaviour that the headless engine does not emulate.</li></ul>')
  L.push('</section>')
  return L.join('\n')
}

function methodSection(M, tree, graph) {
  const aj = [...M.overrides].filter(([id]) => M.ruleClass(M.nodes.get(id)) === 'unknown').map(([id]) => id)
  const prov = isObj(tree.provenance) ? tree.provenance : {}
  return `<section id="method" aria-labelledby="h-method"><h2 id="h-method">Method and provenance</h2>
<p>Rules: the graph, the edges, the call confidence and each node's predicted class come from a deterministic analysis of the project files (rule ids are in the member tables). Agent judgement: the grouping into features, the names and summaries, the risk, the proposed tests and any class override are written by ${esc(prov.author || 'an author')} and validated against the graph. Feature dependencies are computed from graph edges and are never authored.</p>
<dl class="kv"><dt>Tree author</dt><dd>${esc(prov.author || 'unknown')}</dd><dt>Created from</dt><dd>${esc(prov.createdFrom || 'unknown')}</dd><dt>Tree schema</dt><dd>${esc(tree.schema || '')}</dd><dt>Graph schema</dt><dd>${esc(graph.schema || '')}</dd><dt>Overrides</dt><dd>${M.overrides.size}</dd><dt>Overrides on unclassified nodes (agent judgement)</dt><dd>${aj.length}</dd></dl></section>`
}

function renderReport(tree, graph, opts = {}) {
  const o = { ...opts, rowCap: opts.rowCap ?? ROW_CAP, maxBytes: opts.maxBytes ?? MAX_BYTES }
  const M = buildModel(tree, graph, o)
  const totals = { mix: Object.fromEntries(CLASSES.map((c) => [c, 0])), headless: 0, device: 0 }
  for (const f of M.features) for (const c of CLASSES) totals.mix[c] += f.mix[c]
  totals.headless = totals.mix['headless-unit'] + totals.mix['headless-scene'] + totals.mix['headless-fixtures']
  totals.device = totals.mix.device + totals.mix.e2e
  const version = o.version || require('../../package.json').version
  const csp = cspFor(CSS, JS)
  const warnings = []

  const banners = []
  if (o.currentTreeHash && graph.scan && o.currentTreeHash !== graph.scan.treeHash) banners.push('<p class="banner" role="note"><strong>The code changed since the graph was written.</strong> The project tree hash no longer matches the graph: run features graph again and re-map before trusting this report.</p>')
  if (graph.scan && graph.scan.truncated) banners.push('<p class="banner" role="note">The scan hit a file or size cap: the graph covers only part of the tree.</p>')
  const fw = o.check && Array.isArray(o.check.findings) ? o.check.findings.filter((x) => x.severity === 'warning') : []
  if (fw.length) banners.push(`<div class="banner" role="note"><strong>${plural(fw.length, 'warning')} from the tree check</strong><ul>${fw.slice(0, 10).map((x) => `<li>${esc(x.rule)} ${esc(x.code)}: ${esc(x.message)}</li>`).join('')}${fw.length > 10 ? `<li>${fw.length - 10} more</li>` : ''}</ul></div>`)
  const prov = isObj(tree.provenance) ? tree.provenance : {}
  const header = `<header>
<h1>Feature tree: ${esc(graph.app || 'app')}</h1>
<dl class="kv"><dt>brighttest</dt><dd>${esc(version)}</dd><dt>Graph hash</dt><dd><code>${esc(graph.hash || '')}</code></dd><dt>Project tree hash</dt><dd><code>${esc((graph.scan && graph.scan.treeHash) || '')}</code></dd><dt>Tree author</dt><dd>${esc(prov.author || 'unknown')}</dd></dl>
${banners.join('\n')}
</header>`
  const nav = `<nav aria-label="Report sections"><ul>${sections.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}</ul><div id="tools" hidden></div></nav>`
  const main = [
    summarySection(M, tree, graph, o, totals),
    treeSection(M),
    `<section id="panels" aria-labelledby="h-panels"><h2 id="h-panels">Feature details</h2>\n${M.features.map((f) => panel(M, tree, graph, f, o)).join('\n')}</section>`,
    pathsSection(M, tree, graph, o),
    matrixSection(M, totals),
    ciSection(M, o, totals),
    uncertaintySection(M, graph),
    methodSection(M, tree, graph),
  ].join('\n')
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Feature tree: ${esc(graph.app || 'app')}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the report</a>
${header}
${nav}
<main id="main">
${main}
</main>
<script>${JS}</script>
</body>
</html>
`
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > o.maxBytes) warnings.push(`the report is ${fmtBytes(bytes)}, over the ${fmtBytes(o.maxBytes)} limit; it may be slow to open`)
  return { html, warnings, css: CSS, js: JS, csp }
}

// ---- command -----------------------------------------------------------------------------------------------------
const MAX_INPUT = 32 * 1024 * 1024
function readJson(file, what, UsageError) {
  let st
  try { st = fs.statSync(file) } catch (e) { throw new UsageError(`cannot read ${what} ${file}: ${e.code || e.message}`) }
  if (!st.isFile()) throw new UsageError(`${what} ${file} is not a file`)
  if (st.size > MAX_INPUT) throw new UsageError(`${what} ${file} is larger than ${MAX_INPUT} bytes`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new UsageError(`${what} ${file} is not valid JSON`) }
}
const ANSI_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
const clean = (s) => String(s).replace(ANSI_RE, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')

// A graph read from disk can be edited by hand (and keep a valid hash): reject shapes the renderer cannot walk.
function graphShapeProblem(g) {
  const bad = (m) => `malformed graph: ${m}`
  if (g.nodes.some((n) => !isObj(n) || typeof n.id !== 'string')) return bad('every node must be an object with a string id')
  if (g.edges !== undefined && g.edges.some((e) => !isObj(e))) return bad('every edge must be an object')
  if (g.uncertainty !== undefined) {
    const u = g.uncertainty
    if (!isObj(u)) return bad('uncertainty must be an object')
    if (u.items !== undefined && (!Array.isArray(u.items) || u.items.some((i) => !isObj(i)))) return bad('uncertainty.items must be an array of objects')
    if (u.counts !== undefined && !isObj(u.counts)) return bad('uncertainty.counts must be an object')
    if (u.blindSpots !== undefined && !Array.isArray(u.blindSpots)) return bad('uncertainty.blindSpots must be an array')
  }
  for (const n of g.nodes) {
    const t = n.testability
    if (t === undefined) continue
    if (!isObj(t) || !isObj(t.primary)) return bad(`${n.id} has a malformed testability`)
    if (t.primary.class !== undefined && !PRIMARY_CLASSES.includes(t.primary.class)) return bad('unknown testability class') // same rule as features check
    for (const k of ['alsoNeeds', 'notes']) if (t[k] !== undefined && !Array.isArray(t[k])) return bad(`${n.id} testability.${k} must be an array`)
    if (t.primary.needs !== undefined && !Array.isArray(t.primary.needs)) return bad(`${n.id} testability.primary.needs must be an array`)
    for (const k of ['alsoNeeds']) if ((t[k] || []).some((x) => !isObj(x))) return bad(`${n.id} testability.${k} must hold objects`)
    if ((t.primary.needs || []).some((x) => !isObj(x))) return bad(`${n.id} testability.primary.needs must hold objects`)
  }
  return null
}

const real = (p) => { try { return fs.realpathSync(p) } catch (e) { return null } }
// The project that owns a file: the nearest ancestor folder holding a manifest.
function projectOf(file) {
  let cur = path.dirname(path.resolve(file))
  for (;;) {
    if (fs.existsSync(path.join(cur, 'manifest'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) }

// Writes the report next to its final name and renames it, so a failure never leaves a half-written file.
function writeAtomic(file, html) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try { fs.writeFileSync(tmp, html, { flag: 'wx' }); fs.renameSync(tmp, file) } catch (e) { try { fs.unlinkSync(tmp) } catch (e2) { /* none */ } throw e }
}

// o: { dir (tree file), graph, out, auto }; ctx: { root, stagingDir, baseRel, stdout, stderr, selfIgnore, rowCap?, maxBytes?, writeReport? (test hook) }
async function runRender(o, ctx, UsageError) {
  const assess = require('../assess')
  if (o.auto && o.dir) throw new UsageError('--auto renders the generated skeleton tree; drop <tree.json> or drop --auto')
  const featuresDir = path.join(ctx.stagingDir, 'features')
  const treeFile = o.dir ? path.resolve(o.dir) : o.auto ? null : path.join(featuresDir, 'tree.json')
  const graphFile = o.graph ? path.resolve(o.graph) : path.join(treeFile ? path.dirname(treeFile) : featuresDir, 'graph.json')
  const outFile = o.out ? path.resolve(o.out) : path.join(path.dirname(treeFile || graphFile), 'report.html')
  const outDir = path.dirname(outFile)
  // refuse the output location before reading anything or writing anything
  assess.checkOut(outFile, ctx.root, ctx.baseRel)
  // also the project that owns the output path itself, and the ones that own the inputs, whichever folder this runs from
  for (const owner of new Set([outFile, treeFile, graphFile].filter(Boolean).map(projectOf).filter((x) => x && x !== ctx.root))) assess.checkOut(outFile, owner, '.')
  if (!o.out) for (const d of ['source', 'components']) if (fs.existsSync(path.join(outDir, d))) throw new UsageError(`the default output folder ${outDir} holds ${d}/ (it looks like an app root); pass --out with a file outside the app sources`)
  let lst = null
  try { lst = fs.lstatSync(outFile) } catch (e) { /* not there yet */ }
  if (lst) {
    if (lst.isSymbolicLink()) throw new UsageError(`--out ${o.out || outFile} is a symbolic link; refusing to write through it`)
    if (lst.isDirectory()) throw new UsageError(`--out ${o.out || outFile} is an existing directory; give a file name`)
    if (!lst.isFile()) throw new UsageError(`--out ${o.out || outFile} is not a regular file`)
    const ro = real(outFile)
    for (const input of [treeFile, graphFile]) if (input && ro && ro === real(input)) throw new UsageError(`--out ${o.out || outFile} is the same file as an input; choose another name`)
    const fd = fs.openSync(outFile, 'r'); const head = Buffer.alloc(512)
    const n = fs.readSync(fd, head, 0, 512, 0); fs.closeSync(fd)
    if (n > 0 && !/^<!DOCTYPE html>/i.test(head.toString('utf8', 0, n))) throw new UsageError(`--out ${o.out || outFile} exists and is not an HTML report; refusing to overwrite it`)
  }

  if (treeFile && !fs.existsSync(treeFile) && !o.dir) throw new UsageError(`no tree at ${treeFile}: write one (see the mapping skill), or use --auto to render the generated skeleton`)
  const graph = readJson(graphFile, 'graph', UsageError)
  if (!isObj(graph) || graph.schema !== S.GRAPH_SCHEMA || !Array.isArray(graph.nodes)) throw new UsageError(`graph ${graphFile} is not a ${S.GRAPH_SCHEMA} document`)
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) throw new UsageError(`graph ${graphFile} is malformed: edges must be an array`)
  const shape = graphShapeProblem(graph)
  if (shape) throw new UsageError(`graph ${graphFile} is ${shape}`)
  const tree = treeFile ? readJson(treeFile, 'tree', UsageError) : buildSkeleton(graph, suggest(graph))
  const check = validate(tree, graph, { partial: false })
  if (!check.ok) {
    const L = [`brighttest features render: the tree is not valid (${check.errors} error${check.errors === 1 ? '' : 's'}); nothing was written`]
    for (const f of check.findings.filter((x) => x.severity === 'error').slice(0, 30)) L.push(`  error ${f.rule} ${f.code} ${clean(f.pointer || '/')}: ${clean(f.message)}`)
    L.push('Run features check for the full list.')
    ctx.stderr(L.join('\n') + '\n')
    return S.EXIT.invalid
  }
  // project facts (the CI section and the staleness banner): best effort, read-only, from the current directory.
  // From a folder that is not a Roku project both are skipped.
  let ci = null; let assessInfo = null; let currentTreeHash
  try {
    const { report } = await assess.assess(ctx.root, { config: ctx.configFile || undefined })
    if (report.recommendation.path !== 'not-a-roku-app') {
      ci = report.ci; currentTreeHash = report.scan.treeHash
      assessInfo = { path: report.recommendation.path, blockers: report.recommendation.blockers }
    }
  } catch (e) { /* the report is still complete without them */ }
  let ov = null
  if ((o.junit && o.junit.length) || (o.lcov && o.lcov.length)) {
    const readText = (f, what) => { // reuse readJson's size and type checks, then read the text
      const st = (() => { try { return fs.statSync(f) } catch (e) { throw new UsageError(`cannot read ${what} ${f}: ${e.code || e.message}`) } })()
      if (!st.isFile()) throw new UsageError(`${what} ${f} is not a file`)
      if (st.size > MAX_INPUT) throw new UsageError(`${what} ${f} is larger than ${MAX_INPUT} bytes`)
      try { return (ctx.readFile || fs.readFileSync)(f, 'utf8') } catch (e) { throw new UsageError(`cannot read ${f}: ${e.code || e.message}`) }
    }
    const junits = (o.junit || []).map((f) => {
      try { return { file: f, ...overlay.parseJunit(readText(path.resolve(f), '--junit file')) } } catch (e) { if (e instanceof UsageError) throw e; throw new UsageError(`--junit ${f} is not a JUnit report`) }
    })
    const lcovs = (o.lcov || []).map((f) => ({ file: f, records: overlay.parseLcov(readText(path.resolve(f), '--lcov file')) }))
    for (const l of lcovs) if (!l.records.length) throw new UsageError(`--lcov ${l.file} has no SF: records`)
    ov = overlay.buildOverlay(graph, junits, lcovs, { root: ctx.root })
    if (ov.stats.unmapped) ctx.stderr(`[brighttest features] warning: ${ov.stats.unmapped} of ${ov.stats.cases} JUnit cases map to no spec in the graph and were ignored${ov.stats.ambiguous ? ` (${ov.stats.ambiguous} matched a @suite title that more than one spec uses)` : ''}\n`)
    if (ov.stats.lcovDropped) ctx.stderr(`[brighttest features] warning: ${ov.stats.lcovDropped} LCOV records point outside the project and were ignored\n`)
  }
  const r = renderReport(tree, graph, { check, ci, overlay: ov, assess: assessInfo, currentTreeHash, rowCap: ctx.rowCap, maxBytes: ctx.maxBytes })
  try { fs.mkdirSync(outDir, { recursive: true }) } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOTDIR') throw new UsageError(`--out ${o.out} cannot be created: a path part is a file`)
    throw e
  }
  try { (ctx.writeReport || writeAtomic)(outFile, r.html) } catch (e) {
    if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT'].includes(e.code)) throw new UsageError(`cannot write ${o.out || outFile}: ${e.code === 'ENOSPC' || e.code === 'EDQUOT' ? 'no space left on the device' : e.code === 'EROFS' ? 'read-only file system' : 'permission denied'} (${e.code})`)
    throw e
  }
  // only the staging features folder gets the self-ignore; a tree's own folder (often tracked) is never touched
  if (!o.out && ctx.selfIgnore && inside(path.resolve(ctx.stagingDir), outDir)) ctx.selfIgnore(outDir, ctx.root)
  for (const w of r.warnings) ctx.stderr(`[brighttest features] warning: ${w}\n`)
  ctx.stdout(`brighttest features render: ${plural(tree.features.length, 'feature')}${o.auto ? ' (generated skeleton)' : ''}\nwrote:       ${outFile}\n`)
  return S.EXIT.ok
}

module.exports = { renderReport, runRender, esc, THEMES, CONTRAST_PAIRS, CSS, JS, cspFor, ROW_CAP, MAX_BYTES, CI_ROWS }
