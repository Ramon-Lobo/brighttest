'use strict'
// Testability for the feature graph: the purity fixed point over `calls` (rule U1/U2) and the rule table of the design
// (3.5: U1 U2 S1 S2 F1-F6 T1 D1-D5 X1 E1-E3). Pure functions of plain data; no file or process access.
//
//   computePurity(fns) -> Map id -> { pure, why[], clock }
//   classify(ctx)      -> Map nodeId -> { primary{class,rule,at?,needs[]}, alsoNeeds[], uncertainty[], notes[], evidence }
//
// The output is a prediction (evidence 'rule'); a device claim never comes from rules alone (D7): no node gets the
// class `device` as its primary class.

const CLASS_ORDER = ['headless-unit', 'headless-scene', 'headless-fixtures', 'device', 'e2e']
const NEED_ORDER = ['F5', 'F4', 'F1', 'F6', 'S2']
const PLATFORM = new Set(['rodeviceinfo', 'roappinfo', 'roinput', 'roaudioguide', 'rohdmistatus', 'rocecstatus', 'roappmanager', 'rosystemlog'])
const lc = (s) => String(s || '').toLowerCase()
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const atLine = (at) => { const m = /:(\d+)$/.exec(at || ''); return m ? Number(m[1]) : 0 }
const atCmp = (a, b) => cmp((a || '').replace(/:\d+$/, ''), (b || '').replace(/:\d+$/, '')) || atLine(a) - atLine(b)

// ---- purity -------------------------------------------------------------------------------------------------------
// fns: Map id -> { why: [local reasons the function is not pure], clock: bool (reads the clock), calls: [{ name, ids[] }] }
// A call lists every candidate callee (more than one when the call is ambiguous); all of them must be pure. Greatest fixed
// point: every function starts pure and loses purity when a reason or an impure callee shows up, so two functions that
// call each other and are otherwise pure are both pure, and one impure member makes the whole cycle impure.
function computePurity(fns) {
  const pure = new Map(); const why = new Map(); const clock = new Map()
  for (const [id, f] of fns) { pure.set(id, f.why.length === 0); why.set(id, new Set(f.why)); clock.set(id, !!f.clock) }
  let changed = true
  while (changed) {
    changed = false
    for (const [id, f] of fns) {
      for (const c of f.calls) {
        const bad = c.ids.length === 0 || c.ids.some((x) => !pure.get(x))
        const reason = `calls impure ${c.name}`
        if (bad && !why.get(id).has(reason)) { why.get(id).add(reason); pure.set(id, false); changed = true }
      }
    }
  }
  changed = true
  while (changed) {
    changed = false
    for (const [id, f] of fns) {
      if (!pure.get(id) || clock.get(id)) continue
      if (f.calls.some((c) => c.ids.some((x) => clock.get(x)))) { clock.set(id, true); changed = true }
    }
  }
  const out = new Map()
  for (const [id] of fns) out.set(id, { pure: pure.get(id), why: [...why.get(id)].sort(), clock: pure.get(id) && clock.get(id) })
  return out
}

// ---- rules --------------------------------------------------------------------------------------------------------
function newRec() { return { needs: [], also: [], unc: [], notes: [] } }
const first = (arr) => arr.slice().sort((a, b) => atCmp(a.at, b.at))[0]

// Add one alsoNeeds entry; the earliest trigger site is kept for a repeated (class, aspect, rule).
function also(rec, cls, aspect, rule, at) {
  const hit = rec.also.find((a) => a.class === cls && a.aspect === aspect && a.rule === rule)
  if (hit) { if (at && (!hit.at || atCmp(at, hit.at) < 0)) hit.at = at; return }
  rec.also.push({ class: cls, aspect, rule, ...(at ? { at } : {}) })
}
function need(rec, name, rule, at) {
  const hit = rec.needs.find((n) => n.need === name && n.rule === rule)
  if (hit) { if (at && (!hit.at || atCmp(at, hit.at) < 0)) hit.at = at; return }
  rec.needs.push({ need: name, rule, ...(at ? { at } : {}) })
}

// Triggers that come from BrightScript sites (lines), shared by file and component records.
// s: per-file sites { createClasses[{cls,line}], waits[], certs[], focus[], launchArgs[], keyHandlerLine, registry[{name,line}], globalInit[{name,line}] }
function applySites(rec, rel, s, setUrl, notCovered) {
  const at = (l) => `${rel}:${l}`
  for (const c of s.createClasses || []) {
    const k = lc(c.cls)
    if (k === 'rochannelstore') need(rec, 'store', 'F4', at(c.line))
    if (PLATFORM.has(k)) also(rec, 'device', 'platform-values', 'D3', at(c.line))
    if (k === 'roinput') also(rec, 'e2e', 'launch-params', 'E3', at(c.line))
    if (k === 'rodatetime' || k === 'rotimespan') { /* clock reads are U2 on the function, not D1 */ }
  }
  for (const r of s.registry || []) need(rec, 'registry', 'F6', at(r.line))
  for (const w of s.waits || []) also(rec, 'device', 'wall-clock', 'D1', at(w.line))
  for (const w of s.certs || []) also(rec, 'device', 'tls', 'D2', at(w.line))
  for (const f of s.focus || []) also(rec, 'e2e', 'focus-and-keys', 'E1', at(f.line))
  if (s.keyHandlerLine) also(rec, 'e2e', 'focus-and-keys', 'E1', at(s.keyHandlerLine))
  for (const a of s.launchArgs || []) also(rec, 'e2e', 'launch-params', 'E3', at(a.line))
  for (const u of setUrl) if (u.file === rel && u.covered) need(rec, 'net', 'F1', at(u.line))
  for (const n of notCovered) if (n.file === rel) { also(rec, 'device', 'network', 'F2', at(n.line)); rec.unc.push({ rule: 'F2', at: at(n.line), detail: n.reason }) }
}

function finish(rec, base) {
  rec.needs.sort((a, b) => NEED_ORDER.indexOf(a.rule) - NEED_ORDER.indexOf(b.rule) || atCmp(a.at, b.at))
  let cls = base.class; let rule = base.rule; let at = base.at
  if (rec.needs.length && CLASS_ORDER.indexOf(cls) < CLASS_ORDER.indexOf('headless-fixtures')) { cls = 'headless-fixtures'; if (!base.keepRule) { rule = rec.needs[0].rule; at = rec.needs[0].at } }
  if (base.minClass && CLASS_ORDER.indexOf(cls) < CLASS_ORDER.indexOf(base.minClass)) cls = base.minClass
  rec.also.sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || cmp(a.aspect, b.aspect) || cmp(a.rule, b.rule))
  rec.unc.sort((a, b) => cmp(a.rule, b.rule) || atCmp(a.at, b.at) || cmp(a.detail || '', b.detail || ''))
  const seen = new Set(); rec.unc = rec.unc.filter((u) => { const k = `${u.rule}|${u.at}|${u.detail}`; if (seen.has(k)) return false; seen.add(k); return true })
  return { primary: { class: cls, rule: rule || null, ...(at ? { at } : {}), needs: rec.needs }, alsoNeeds: rec.also, uncertainty: rec.unc, notes: rec.notes, evidence: 'rule' }
}

// ctx: { nodes, edges, sites: Map rel -> sites, compFiles: Map compId -> { xml, files[] }, setUrl[], notCovered[],
//        seeded: Set(lower-case global field names), uncertainty[{kind,at,detail}], entryTargets: Set(compId) }
function classify(ctx) {
  const out = new Map()
  const setUrl = ctx.setUrl || []; const notCovered = ctx.notCovered || []
  const sitesOf = (rel) => ctx.sites.get(rel) || {}
  const pureFn = (n) => (n.functions || []).filter((f) => f.pure)
  const unc = ctx.uncertainty || []

  // ---- file nodes (functions only)
  for (const n of ctx.nodes) {
    if (n.kind !== 'file' || n.spec || !(n.lang === 'brs' || n.lang === 'bs') || !(n.functions || []).length) continue
    const rel = n.id.slice(5)
    const rec = newRec()
    applySites(rec, rel, sitesOf(rel), setUrl, notCovered)
    const pf = pureFn(n).sort((a, b) => a.line - b.line)
    const plain = pf.find((f) => !f.clock)
    const trig = plain || pf[0]
    let base
    if (trig) base = { class: 'headless-unit', rule: plain ? 'U1' : 'U2', at: `${rel}:${trig.line}` }
    else base = { class: /^components\//i.test(rel) ? 'headless-scene' : 'headless-unit', rule: null }
    if (!plain && pf[0]) rec.notes.push({ rule: 'U2', text: 'inject the clock: the function reads the date or time' })
    out.set(n.id, finish(rec, base))
  }

  // ---- component nodes
  for (const n of ctx.nodes) {
    if (n.kind !== 'component') continue
    const info = ctx.compFiles.get(n.id) || { xml: n.file, files: [] }
    const rec = newRec()
    const task = n.isTask && !n.unresolvedRoot
    for (const rel of info.files) applySites(rec, rel, sitesOf(rel), setUrl, notCovered)
    const own = (e) => e.from === n.id || info.files.some((rel) => e.from === `file:${rel}`)
    for (const e of ctx.edges) {
      if (!own(e)) continue
      if ((e.kind === 'child' || e.kind === 'creates') && e.to === null && e.conf === 'unresolved') rec.unc.push({ rule: 'X1', at: e.at, detail: e.detail })
      if ((e.kind === 'child' || e.kind === 'creates') && e.to) {
        const t = lc(e.to)
        if (t === 'builtin:video' || t === 'builtin:audio') { need(rec, 'media', 'F5', e.at); also(rec, 'device', 'playback', 'F5', e.at) }
        if (t === 'builtin:timer' || t === 'builtin:animation') also(rec, 'device', 'wall-clock', 'D1', e.at)
      }
    }
    if (n.unresolvedRoot) rec.unc.push({ rule: 'X1', at: n.file, detail: `base type unknown: ${n.unresolvedRoot}` })
    for (const u of unc) {
      if (u.kind === 'component-library' && u.at.startsWith(`${info.xml}:`)) { rec.unc.push({ rule: 'D5', at: u.at, detail: u.detail }); also(rec, 'e2e', 'runtime-load', 'D5', u.at) }
      if (u.kind === 'inline-cdata' && u.at.startsWith(`${info.xml}:`)) { rec.unc.push({ rule: 'D4', at: u.at, detail: u.detail }); also(rec, 'device', 'instrumentation', 'D4', u.at) }
    }
    if (ctx.entryTargets && ctx.entryTargets.has(n.id)) also(rec, 'e2e', 'launch', 'E2', n.file)
    const hasS1 = !task && !n.unresolvedRoot && !!n.interface && ((n.interface.fields || []).length > 0 || (n.interface.functions || []).length > 0)
    let base
    if (task) { base = { class: pureFnInFiles(ctx, info) ? 'headless-unit' : 'headless-scene', rule: 'T1', at: n.file, keepRule: true }; also(rec, 'device', 'task-timing', 'T1', n.file) } else if (hasS1) { base = { class: 'headless-scene', rule: 'S1', at: n.file } } else { base = { class: 'headless-scene', rule: null } }
    if (hasS1) {
      const reads = info.files.flatMap((rel) => (sitesOf(rel).globalInit || []).map((g) => ({ ...g, rel })))
      if (reads.length) {
        const f = first(reads.map((g) => ({ ...g, at: `${g.rel}:${g.line}` })))
        need(rec, 'state', 'S2', f.at)
        for (const g of reads) if (g.name === null || !(ctx.seeded && ctx.seeded.has(lc(g.name)))) also(rec, 'device', 'unseeded-global', 'S2', `${g.rel}:${g.line}`)
      }
    }
    if (!task && rec.needs.some((x) => x.rule === 'F1')) rec.notes.push({ rule: 'F3', text: 'BTNet from a scene render thread is not verified; use config fixtures' })
    if (n.unresolvedRoot) rec.notes.push({ rule: 'X1', text: 'base type unknown' })
    base.minClass = (n.unresolvedRoot || rec.unc.some((u) => u.rule === 'X1')) ? 'headless-scene' : undefined
    out.set(n.id, finish(rec, base))
  }

  // ---- entry node: the main loop is only covered by a launch smoke
  for (const n of ctx.nodes) {
    if (n.kind !== 'entry') continue
    const rec = newRec()
    const rel = n.file
    for (const a of (sitesOf(rel).launchArgs || [])) also(rec, 'e2e', 'launch-params', 'E3', `${rel}:${a.line}`)
    for (const c of (sitesOf(rel).createClasses || [])) if (lc(c.cls) === 'roinput') also(rec, 'e2e', 'launch-params', 'E3', `${rel}:${c.line}`)
    out.set(n.id, finish(rec, { class: 'e2e', rule: 'E2', at: rel, keepRule: true }))
  }
  return out
}
function pureFnInFiles(ctx, info) {
  return info.files.some((rel) => { const n = ctx.nodes.find((x) => x.id === `file:${rel}`); return n && (n.functions || []).some((f) => f.pure) })
}

module.exports = { computePurity, classify, CLASS_ORDER }
