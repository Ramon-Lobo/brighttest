'use strict'
// Feature graph clustering and ordering (pure functions of the plain graph from lib/features/graph.js; no I/O).
//
//   tarjan(ids, adj)              -> { sccs: [[id]], of: Map id -> index }   (iterative; sccs come dependencies first)
//   dominators(order, preds, root)-> Map id -> idom id                        (iterative algorithm, Cooper-Harvey-Clark)
//   suggest(graph)                -> graph.suggested: { entry, cycles, clusters, shared, unreached, deps, ... }
//   orderFeatures(input, mode, opts) -> steps for 'leaf-first' or 'base-first' (generic input, easy to test)
//   orderSuggested(graph, suggested, mode, opts) -> orderFeatures over a graph's clusters
//
// Class comparisons use classRank from testability.js (never indexOf on a class name). A node whose class is `unknown`
// is a prediction gap: never scheduled as headless-testable, never part of "First tests".

const { classRank } = require('./testability')

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// Edge kinds that make one unit depend on another.
const DEP_KINDS = new Set(['extends', 'child', 'creates', 'runs-task', 'callfunc', 'observes', 'calls', 'script', 'import', 'entry'])
// Kinds by which a Scene reaches its screens.
const SCREEN_KINDS = new Set(['child', 'creates', 'observes', 'callfunc'])
const NO_DEP_CONF = new Set(['builtin', 'unresolved', 'dynamic'])

// ---- Tarjan (iterative, deterministic: ids and neighbours are visited in sorted order) -------------------------------
function tarjan(ids, adj) {
  const sorted = [...ids].sort(cmp)
  const index = new Map(); const low = new Map(); const on = new Set(); const stack = []
  const sccs = []; const of = new Map(); let counter = 0
  for (const start of sorted) {
    if (index.has(start)) continue
    const work = [{ v: start, i: 0, nb: null }]
    while (work.length) {
      const fr = work[work.length - 1]
      const v = fr.v
      if (fr.nb === null) {
        index.set(v, counter); low.set(v, counter); counter++; stack.push(v); on.add(v)
        fr.nb = [...(adj.get(v) || [])].sort(cmp)
      }
      let descended = false
      while (fr.i < fr.nb.length) {
        const w = fr.nb[fr.i++]
        if (!index.has(w)) { work.push({ v: w, i: 0, nb: null }); descended = true; break }
        if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
      }
      if (descended) continue
      if (low.get(v) === index.get(v)) {
        const comp = []; let w
        do { w = stack.pop(); on.delete(w); comp.push(w); of.set(w, sccs.length) } while (w !== v)
        sccs.push(comp.sort(cmp))
      }
      work.pop()
      if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p), low.get(v))) }
    }
  }
  return { sccs, of }
}

// ---- dominators ------------------------------------------------------------------------------------------------------
// succ: Map id -> ids. Returns Map id -> immediate dominator (the root maps to itself); only nodes reachable from root.
function dominators(succ, root) {
  const rpo = []; const seen = new Set([root])
  const work = [{ v: root, nb: [...(succ.get(root) || [])].sort(cmp), i: 0 }]
  while (work.length) {
    const fr = work[work.length - 1]
    if (fr.i < fr.nb.length) {
      const w = fr.nb[fr.i++]
      if (!seen.has(w)) { seen.add(w); work.push({ v: w, nb: [...(succ.get(w) || [])].sort(cmp), i: 0 }) }
    } else { rpo.push(fr.v); work.pop() }
  }
  rpo.reverse()
  const num = new Map(rpo.map((v, i) => [v, i]))
  const preds = new Map(rpo.map((v) => [v, []]))
  for (const v of rpo) for (const w of succ.get(v) || []) if (num.has(w)) preds.get(w).push(v)
  const idom = new Map([[root, root]])
  const inter = (a, b) => { while (a !== b) { while (num.get(a) > num.get(b)) a = idom.get(a); while (num.get(b) > num.get(a)) b = idom.get(b) } return a }
  let changed = true
  while (changed) {
    changed = false
    for (const v of rpo) {
      if (v === root) continue
      let nd = null
      for (const p of preds.get(v)) if (idom.has(p)) nd = nd === null ? p : inter(p, nd)
      if (nd !== null && idom.get(v) !== nd) { idom.set(v, nd); changed = true }
    }
  }
  return idom
}

// ---- helpers ---------------------------------------------------------------------------------------------------------
const slug = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const dirOf = (rel) => { const p = rel.split('/'); p.pop(); return p.slice(0, 2).join('/') || '.' }

function mixOf(nodes) {
  const mix = {}
  for (const n of nodes) { const c = n.testability && n.testability.primary && n.testability.primary.class; if (c) mix[c] = (mix[c] || 0) + 1 }
  return Object.fromEntries(Object.keys(mix).sort((a, b) => classRank(a) - classRank(b)).map((k) => [k, mix[k]]))
}

// ---- suggest -----------------------------------------------------------------------------------------------------------
function suggest(graph) {
  const nodes = graph.nodes; const byId = new Map(nodes.map((n) => [n.id, n]))
  const comps = nodes.filter((n) => n.kind === 'component')
  // ownership: a script under components/ referenced by exactly one component's XML belongs to that component
  const compOfXml = new Map(comps.map((c) => [`file:${c.file}`, c.id]))
  const owners = new Map()
  for (const e of graph.edges) if (e.kind === 'script' && e.to && compOfXml.has(e.from)) { if (!owners.has(e.to)) owners.set(e.to, new Set()); owners.get(e.to).add(compOfXml.get(e.from)) }
  const hasEntry = nodes.some((n) => n.id === 'entry:main')
  const unitOf = new Map() // node id -> unit id
  for (const c of comps) { unitOf.set(c.id, c.id); unitOf.set(`file:${c.file}`, c.id) }
  const members = new Map() // unit id -> node ids
  const addMember = (u, id) => { if (!members.has(u)) members.set(u, []); members.get(u).push(id) }
  for (const c of comps) { addMember(c.id, c.id); addMember(c.id, `file:${c.file}`) }
  if (hasEntry) { unitOf.set('entry:main', 'entry:main'); addMember('entry:main', 'entry:main'); unitOf.set('file:source/main.brs', 'entry:main'); if (byId.has('file:source/main.brs')) addMember('entry:main', 'file:source/main.brs') }
  for (const n of nodes) {
    if (n.kind !== 'file' || n.spec || n.lang === 'manifest' || unitOf.has(n.id)) continue
    const rel = n.id.slice(5); const o = owners.get(n.id)
    if (o && o.size === 1 && /^components\//i.test(rel)) { const u = [...o][0]; unitOf.set(n.id, u); addMember(u, n.id) } else { unitOf.set(n.id, n.id); addMember(n.id, n.id) }
  }
  const unitIds = [...members.keys()].sort(cmp)
  const unitVendor = (u) => { const f = u.startsWith('comp:') ? byId.get(`file:${byId.get(u).file}`) : byId.get(u); return !!(f && f.vendor) }
  const vendorUnits = new Set(unitIds.filter(unitVendor))
  const live = unitIds.filter((u) => !vendorUnits.has(u))
  // specs ride with the unit they cover; others, the manifest and unattached specs go to the app shell
  const specAt = new Map()
  for (const e of graph.edges) if (e.kind === 'spec-covers' && e.to && unitOf.has(e.to) && !specAt.has(e.from)) specAt.set(e.from, unitOf.get(e.to))
  const shellExtra = []
  for (const n of nodes) {
    if (n.kind !== 'file') continue
    if (n.spec) { if (specAt.has(n.id)) addMember(specAt.get(n.id), n.id); else shellExtra.push(n.id) } else if (n.lang === 'manifest') shellExtra.push(n.id)
  }

  // unit edges
  const uedge = new Map() // "from\0to" -> { from, to, kinds:Set, ambiguous }
  const scopesOf = new Map() // file unit -> Set(scopes) that use it
  const addScope = (u, s) => { if (!scopesOf.has(u)) scopesOf.set(u, new Set()); scopesOf.get(u).add(s) }
  for (const e of graph.edges) {
    if (!DEP_KINDS.has(e.kind) || NO_DEP_CONF.has(e.conf)) continue
    const from = unitOf.get(e.from); if (!from || vendorUnits.has(from)) continue
    const targets = e.to ? [e.to] : (e.candidates || [])
    const ambiguous = e.conf === 'ambiguous'
    for (const t of targets) {
      const to = unitOf.get(t); if (!to || to === from || vendorUnits.has(to)) continue
      const k = `${from}\0${to}`
      if (!uedge.has(k)) uedge.set(k, { from, to, kinds: new Set(), ambiguous: true })
      const ue = uedge.get(k); ue.kinds.add(e.kind); if (!ambiguous) ue.ambiguous = false
      if (e.kind === 'calls') for (const s of e.scopes || [from]) addScope(to, s)
      else if (e.kind === 'script' || e.kind === 'import') addScope(to, from)
    }
  }
  const succ = new Map(live.map((u) => [u, new Set()])); const pred = new Map(live.map((u) => [u, new Set()]))
  for (const { from, to } of uedge.values()) { succ.get(from).add(to); pred.get(to).add(from) }

  // 2. SCCs; cycles listed, then condensed
  const { sccs, of } = tarjan(live, succ)
  const cycles = sccs.filter((s) => s.length > 1).sort((a, b) => cmp(a[0], b[0]))
  const rep = (u) => sccs[of.get(u)][0]
  const cSucc = new Map(); const cPred = new Map()
  for (const s of sccs) { cSucc.set(s[0], new Set()); cPred.set(s[0], new Set()) }
  for (const { from, to } of uedge.values()) { const a = rep(from); const b = rep(to); if (a !== b) { cSucc.get(a).add(b); cPred.get(b).add(a) } }

  // 3. entry
  let rootId; let entry = null
  const entryEdge = graph.edges.find((e) => e.kind === 'entry' && e.to)
  if (hasEntry) {
    rootId = rep('entry:main')
    entry = { id: 'entry:main', scene: entryEdge && unitOf.has(entryEdge.to) ? unitOf.get(entryEdge.to) : null }
  } else {
    rootId = '<root>'
    const roots = sccs.map((s) => s[0]).filter((s) => cPred.get(s).size === 0).sort(cmp)
    cSucc.set(rootId, new Set(roots)); cPred.set(rootId, new Set())
    for (const r of roots) cPred.get(r).add(rootId)
  }
  const reach = new Set([rootId]); { const q = [rootId]; while (q.length) { const v = q.pop(); for (const w of cSucc.get(v)) if (!reach.has(w)) { reach.add(w); q.push(w) } } }
  const idom = dominators(cSucc, rootId)

  // heads: the screens, i.e. what the root Scene reaches by child/creates/observes/callfunc
  const sceneReps = new Set()
  if (hasEntry) { if (entry.scene) sceneReps.add(rep(entry.scene)) } else sceneReps.add(rootId)
  const isTaskComp = (u) => u.startsWith('comp:') && byId.get(u).isTask
  const headSet = new Set()
  for (const { from, to, kinds } of uedge.values()) {
    if (!sceneReps.has(rep(from)) || ![...kinds].some((k) => SCREEN_KINDS.has(k))) continue
    const t = rep(to)
    if (t === rootId || sceneReps.has(t) || !to.startsWith('comp:') || isTaskComp(to)) continue
    headSet.add(t)
  }
  if (!hasEntry) for (const r of cSucc.get(rootId)) if (sccs[of.get(r)].some((u) => u.startsWith('comp:') && !isTaskComp(u))) headSet.add(r)
  const heads = [...headSet].sort(cmp)

  // 4. shared: reached from 2+ screens (BFS that stops at other screens), in-degree, or a file used from 2+ scopes
  const reachedBy = new Map()
  for (const h of heads) {
    const seen = new Set([h]); const q = [h]
    while (q.length) { const v = q.pop(); for (const w of cSucc.get(v)) { if (seen.has(w) || headSet.has(w) || w === rootId) continue; seen.add(w); q.push(w); if (!reachedBy.has(w)) reachedBy.set(w, new Set()); reachedBy.get(w).add(h) } }
  }
  const compCount = comps.filter((c) => !vendorUnits.has(c.id)).length
  const inThreshold = Math.max(3, Math.ceil(compCount * 0.1))
  const sharedReason = new Map()
  for (const r of sccs.map((s) => s[0])) {
    if (!reach.has(r) || r === rootId || sceneReps.has(r) || headSet.has(r)) continue
    const members0 = sccs[of.get(r)]
    const nh = reachedBy.has(r) ? reachedBy.get(r).size : 0
    const indeg = new Set(); for (const p of cPred.get(r)) indeg.add(p)
    const scopes = new Set(); for (const u of members0) if (!u.startsWith('comp:') && scopesOf.has(u)) for (const s of scopesOf.get(u)) scopes.add(s)
    if (nh >= 2) sharedReason.set(r, { n: nh, text: `shared: used by ${nh} clusters` })
    else if (scopes.size >= 2) sharedReason.set(r, { n: scopes.size, text: `shared: used by ${scopes.size} scopes` })
    else if (indeg.size >= inThreshold) sharedReason.set(r, { n: indeg.size, text: `shared: in-degree ${indeg.size} (threshold ${inThreshold})` })
  }

  // 5. clusters
  const clusterOfRep = new Map(); const clusters = new Map()
  const mk = (id, name, kind, reason, extra) => { const c = { id, name, kind, reason, slug: slug(id), units: [], ...(extra || {}) }; clusters.set(id, c); return c }
  // The fixed cluster ids are reserved first, so a component named like one of them cannot take (or overwrite) its id.
  const usedSlugs = new Set(['app-shell', 'vendor', 'unreached'])
  const MAX_ID = 48
  // Cut to MAX_ID and strip a trailing '-' before checking uniqueness; suffixes stay inside MAX_ID.
  const uniq = (s) => {
    const base = String(s).slice(0, MAX_ID).replace(/-+$/, '') || 'feature'
    let o = base; let i = 2
    while (usedSlugs.has(o)) { const suf = `-${i++}`; o = `${base.slice(0, MAX_ID - suf.length).replace(/-+$/, '')}${suf}` }
    usedSlugs.add(o); return o
  }
  const headCluster = new Map()
  for (const h of heads) {
    const comp = sccs[of.get(h)].find((u) => u.startsWith('comp:')) || h
    const nm = comp.startsWith('comp:') ? comp.slice(5) : comp
    const id = uniq(slug(nm))
    headCluster.set(h, mk(id, nm, 'screen', `dominated-by ${comp}`, { head: comp }))
  }
  const shell = mk('app-shell', 'App shell', 'app-shell', hasEntry ? 'dominated only by the entry' : 'reached only from the roots')
  const vendorC = vendorUnits.size ? mk('vendor', 'Vendor code', 'vendor', 'vendor folder') : null
  const unreachedC = mk('unreached', 'Unreached code', 'shared', 'unreached: no path from the entry')
  const sharedC = new Map()
  const sharedFor = (r) => {
    const members0 = sccs[of.get(r)]; const u0 = members0[0]
    const dir = u0.startsWith('comp:') ? dirOf(byId.get(u0).file) : dirOf(u0.slice(5))
    const id = `shared:${dir}`
    if (!sharedC.has(id)) sharedC.set(id, mk(id, `Shared ${dir}`, 'shared', '', { usedBy: 0 }))
    const c = sharedC.get(id); c.usedBy = Math.max(c.usedBy, sharedReason.get(r).n)
    return c
  }
  // Nearest head on the dominator chain of each node, memoised: every node is resolved once, so the total work is linear
  // however deep the chain is (a walk per node would be quadratic on a long chain).
  const headOf = new Map()
  const headAncestor = (r) => {
    const path = []; let v = r; let found = null
    for (;;) {
      if (headOf.has(v)) { found = headOf.get(v); break }
      path.push(v)
      if (headSet.has(v)) { found = v; break }
      const p = idom.get(v)
      if (p === undefined || p === v) break
      v = p
    }
    for (const x of path) headOf.set(x, found)
    return found
  }
  for (const r of sccs.map((s) => s[0])) {
    let c
    if (vendorUnits.has(r)) c = vendorC
    else if (!reach.has(r)) c = unreachedC
    else if (r === rootId || sceneReps.has(r)) c = shell
    else if (headSet.has(r)) c = headCluster.get(r)
    else if (sharedReason.has(r)) c = sharedFor(r)
    else { const h = headAncestor(r); c = h ? headCluster.get(h) : shell }
    clusterOfRep.set(r, c)
  }
  for (const u of vendorUnits) clusterOfRep.set(u, vendorC)
  const clusterOfUnit = (u) => (vendorUnits.has(u) ? vendorC : clusterOfRep.get(rep(u)))
  for (const u of unitIds) clusterOfUnit(u).units.push(u)
  // reasons of shared clusters keep the strongest member reason text
  for (const c of sharedC.values()) { const t = [...sharedReason].filter(([r]) => clusterOfRep.get(r) === c).map(([, v]) => v.text); c.reason = t.includes(`shared: used by ${c.usedBy} clusters`) ? `shared: used by ${c.usedBy} clusters` : t.sort()[0] }

  const outClusters = [...clusters.values()].filter((c) => c.units.length || c === shell)
  for (const c of outClusters) {
    const ids = []; for (const u of c.units) ids.push(...members.get(u))
    if (c === shell) ids.push(...shellExtra)
    c.members = [...new Set(ids)].sort(cmp)
  }
  const nodesOfCluster = (c) => c.members.map((id) => byId.get(id)).filter(Boolean)
  for (const c of outClusters) {
    const ns = nodesOfCluster(c)
    c.files = ns.filter((n) => n.kind === 'file').length
    c.components = ns.filter((n) => n.kind === 'component').length
    c.classMix = mixOf(ns)
  }
  // cluster dependencies
  const deps = new Map()
  for (const { from, to, ambiguous } of uedge.values()) {
    const a = clusterOfUnit(from); const b = clusterOfUnit(to)
    if (!a || !b || a === b || a === vendorC || b === vendorC) continue
    const k = `${a.id}\0${b.id}`
    if (!deps.has(k)) deps.set(k, { from: a.id, to: b.id, ambiguous: true })
    if (!ambiguous) deps.get(k).ambiguous = false
  }
  const depList = [...deps.values()].sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to))
  for (const c of outClusters) {
    c.dependsOn = depList.filter((d) => d.from === c.id).map((d) => d.to)
    c.usedByClusters = depList.filter((d) => d.to === c.id).map((d) => d.from)
  }
  const order = (c) => (c.id === 'app-shell' ? 0 : c.kind === 'screen' ? 1 : c.id.startsWith('shared:') ? 2 : c.id === 'unreached' ? 3 : 4)
  const finalClusters = outClusters.filter((c) => c.members.length).sort((a, b) => order(a) - order(b) || cmp(a.id, b.id))
    .map((c) => { const { units, usedBy, ...rest } = c; void units; void usedBy; return rest })
  const sharedNodes = [...sharedReason].map(([r, v]) => ({ id: sccs[of.get(r)][0], cluster: clusterOfRep.get(r).id, reason: v.text })).sort((a, b) => cmp(a.id, b.id))
  const unreachedIds = unreachedC.units.slice().sort(cmp)
  return {
    entry,
    cycles,
    clusters: finalClusters,
    shared: sharedNodes,
    unreached: unreachedIds,
    deps: depList,
    thresholds: { sharedInDegree: inThreshold },
    uncertainty: unreachedIds.length ? { unreached: unreachedIds.length } : {},
  }
}

// ---- ordering --------------------------------------------------------------------------------------------------------
// input: { features: [{ id, shared, files, nodes: [{ id, class, rule?, alsoNeeds?: [class] }] }],
//          deps: [{ from, to, ambiguous? }], entry: featureId | null }
// opts.overrides: { nodeId: class } (an agent override moves a node out of "not classified").
function featureClass(f, ov) {
  let best = null
  for (const n of f.nodes || []) { const c = (ov && ov[n.id]) || n.class; if (c === 'unknown') continue; if (best === null || classRank(c) < classRank(best)) best = c }
  return best === null ? 'unknown' : best
}
function orderFeatures(input, mode, opts) {
  if (mode !== 'leaf-first' && mode !== 'base-first') throw new Error(`unknown order mode: ${mode}`)
  const ov = (opts && opts.overrides) || {}
  const feats = new Map(input.features.map((f) => [f.id, f]))
  const fsucc = new Map([...feats.keys()].map((k) => [k, new Set()]))
  const ambig = new Map()
  for (const d of input.deps) {
    if (!feats.has(d.from) || !feats.has(d.to) || d.from === d.to) continue
    fsucc.get(d.from).add(d.to); if (d.ambiguous) ambig.set(`${d.from}\0${d.to}`, true)
  }
  const { sccs, of } = tarjan([...feats.keys()], fsucc)
  const steps = sccs.map((members) => {
    const fs = members.map((id) => feats.get(id))
    const rank = Math.min(...fs.map((f) => classRank(featureClass(f, ov))))
    const ambiguous = members.some((a) => members.concat([...fsucc.get(a)]).some((b) => ambig.has(`${a}\0${b}`)))
    return { members, shared: fs.some((f) => !!f.shared), rank, files: fs.reduce((s, f) => s + (f.files || 0), 0), id: members[0], ambiguous, deps: new Set() }
  })
  for (let i = 0; i < steps.length; i++) for (const m of steps[i].members) for (const t of fsucc.get(m)) { const j = of.get(t); if (j !== i) steps[i].deps.add(j) }
  const tie = (a, b) => (b.shared - a.shared) || (a.rank - b.rank) || (a.files - b.files) || cmp(a.id, b.id)
  let seq = []
  if (mode === 'leaf-first') {
    const done = new Set(); const left = new Set(steps.map((_, i) => i))
    while (left.size) {
      const ready = [...left].filter((i) => [...steps[i].deps].every((d) => done.has(d))).map((i) => steps[i])
      ready.sort(tie)
      const pick = steps.indexOf(ready[0]); left.delete(pick); done.add(pick); seq.push(pick)
    }
  } else {
    // distance from the entry feature's step over dependency edges; unreached last; the entry step is step 1
    const entryStep = input.entry && of.has(input.entry) ? of.get(input.entry) : null
    const dist = new Map(); let q
    if (entryStep !== null) { dist.set(entryStep, 0); q = [entryStep] } else {
      const hasIn = new Set(); steps.forEach((s) => s.deps.forEach((d) => hasIn.add(d)))
      q = steps.map((_, i) => i).filter((i) => !hasIn.has(i)); q.forEach((i) => dist.set(i, 0))
    }
    for (let h = 0; h < q.length; h++) for (const d of steps[q[h]].deps) if (!dist.has(d)) { dist.set(d, dist.get(q[h]) + 1); q.push(d) }
    const dd = (i) => (dist.has(i) ? dist.get(i) : Infinity)
    seq = steps.map((_, i) => i).sort((a, b) => (entryStep !== null ? (b === entryStep) - (a === entryStep) : 0) || (dd(a) === dd(b) ? 0 : dd(a) < dd(b) ? -1 : 1) || tie(steps[a], steps[b]))
  }
  const placed = new Set()
  return seq.map((si, n) => {
    const s = steps[si]
    const fs = s.members.map((id) => feats.get(id)).sort((a, b) => (b.shared ? 1 : 0) - (a.shared ? 1 : 0) || classRank(featureClass(a, ov)) - classRank(featureClass(b, ov)) || (a.files || 0) - (b.files || 0) || cmp(a.id, b.id))
    const nodes = []; const notClassified = []; const proposedTests = []
    for (const f of fs) for (const nd of f.nodes || []) {
      const cls = ov[nd.id] || nd.class
      nodes.push({ id: nd.id, class: cls, ...(nd.rule ? { rule: nd.rule } : {}) })
      if (cls === 'unknown') notClassified.push({ id: nd.id, alsoNeeds: nd.alsoNeeds || [] })
      else proposedTests.push({ target: nd.id, lane: cls })
    }
    const byRank = (a, b) => classRank(a.class) - classRank(b.class) || cmp(a.id, b.id)
    nodes.sort(byRank); proposedTests.sort((a, b) => classRank(a.lane) - classRank(b.lane) || cmp(a.target, b.target)); notClassified.sort((a, b) => cmp(a.id, b.id))
    const firstTests = nodes.filter((x) => x.class === 'headless-unit' || x.class === 'headless-scene').map((x) => x.id)
    const stubbed = mode === 'base-first' ? [...new Set([...s.deps].flatMap((d) => steps[d].members).filter((m) => !placed.has(m) && !s.members.includes(m)))].sort(cmp) : []
    s.members.forEach((m) => placed.add(m))
    return {
      step: n + 1,
      features: fs.map((f) => f.id),
      ...(s.members.length > 1 ? { label: 'test together' } : {}),
      ...(s.ambiguous ? { flags: ['ambiguous'] } : {}),
      ...(mode === 'base-first' && n === 0 && input.entry ? { launchSmoke: { primary: 'e2e', fallback: 'headless-scene spec of the root Scene init with globalFields seeded' } } : {}),
      nodes, firstTests, proposedTests, notClassified, stubbed,
    }
  })
}

// Features of a suggested structure as orderFeatures input (vendor is not a feature; unreached is).
function featureInput(graph, suggested) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const features = suggested.clusters.filter((c) => c.kind !== 'vendor').map((c) => ({
    id: c.id, shared: c.id.startsWith('shared:'), files: c.files,
    nodes: c.members.map((id) => byId.get(id)).filter((n) => n && n.testability).map((n) => ({
      id: n.id, class: n.testability.primary.class, rule: n.testability.primary.rule || undefined,
      alsoNeeds: [...new Set(n.testability.alsoNeeds.map((a) => a.class))],
    })),
  }))
  return { features, deps: suggested.deps, entry: suggested.clusters.some((c) => c.id === 'app-shell') ? 'app-shell' : null }
}
function orderSuggested(graph, suggested, mode, opts) { return orderFeatures(featureInput(graph, suggested), mode, opts) }

module.exports = { tarjan, dominators, suggest, orderFeatures, orderSuggested, featureInput, featureClass, DEP_KINDS }
