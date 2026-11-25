'use strict'
// Digest, focus slice and skeleton tree for the feature graph. Pure functions of plain data.
//
//   buildDigest(graph, suggested, { budget, blockers }) -> string   (length <= budget; truncation is stated)
//   focusSlice(graph, suggested, clusterId, { max })    -> string   (<= 8,000 characters; throws on an unknown id)
//   buildSkeleton(graph, suggested)                     -> brighttest-feature-tree/v1 document (no proposed tests)

const { classRank } = require('./testability')

const DEFAULT_BUDGET = 48000
const FOCUS_MAX = 8000
const TOP_UNCERTAIN = 20
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const mixText = (mix) => Object.keys(mix || {}).sort((a, b) => classRank(a) - classRank(b)).map((k) => `${k} ${mix[k]}`).join(', ') || '-'
const cell = (s) => String(s).replace(/\|/g, '/').replace(/[\r\n]+/g, ' ')
const topFolder = (c) => {
  const n = new Map()
  for (const id of c.members || []) if (id.startsWith('file:') && id.includes('/')) { const k = id.slice(5).split('/').slice(0, 2).join('/'); n.set(k, (n.get(k) || 0) + 1) }
  return [...n].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map((x) => x[0])[0] || '(root)'
}
const list = (arr, max) => (arr.length <= max ? arr.join(', ') : `${arr.slice(0, max).join(', ')} and ${arr.length - max} more`)

function cut(text, max, note) {
  if (text.length <= max) return text
  const tail = `\n${note}\n`
  return text.slice(0, Math.max(0, max - tail.length)).replace(/\n[^\n]*$/, '') + tail
}

// Smallest cluster listing for tiny budgets. Tries, in order: every cluster id; the ids' folders (two levels) with counts;
// the folders rolled up one level with counts. The last listing is cut at a whole entry and ends with ", and N more".
function compactClusters(clusters, room) {
  const n = clusters.length
  const byFolder = (levels) => {
    const g = new Map()
    for (const c of clusters) { const k = topFolder(c).split('/').slice(0, levels).join('/'); g.set(k, (g.get(k) || 0) + 1) }
    return [...g].sort((a, b) => cmp(a[0], b[0])).map(([k, v]) => `${k} (${v})`)
  }
  const fit = (label, entries) => { const t = `${label}: ${entries.join(', ')}`; return t.length <= room ? t : null }
  const ids = clusters.map((c) => c.id)
  const whole = fit(`Clusters (${n})`, ids)
  if (whole) return whole.replace(/, /g, ' ')
  const label = `Clusters (${n}) rolled up by folder, cluster counts`
  for (const levels of [2, 1]) { const t = fit(label, byFolder(levels)); if (t) return t }
  // Partial rollup: keep the most whole entries that leave room for ", and N more" (N = folders left out).
  const entries = byFolder(1)
  for (let k = entries.length - 1; k >= 0; k--) {
    const t = `${label}: ${entries.slice(0, k).join(', ')}${k ? ', ' : ''}and ${entries.length - k} more`
    if (t.length <= room) return t
  }
  return `${label}: and ${entries.length} more`.slice(0, Math.max(0, room))
}

function clusterTable(clusters, full) {
  if (full) {
    const rows = ['| id | name | kind | files | components | depends on | used by | predicted classes |', '|---|---|---|---|---|---|---|---|']
    for (const c of clusters) rows.push(`| ${cell(c.id)} | ${cell(c.name)} | ${c.kind} | ${c.files} | ${c.components} | ${cell(list(c.dependsOn, 3) || '-')} | ${cell(list(c.usedByClusters, 3) || '-')} | ${cell(mixText(c.classMix))} |`)
    return rows.join('\n')
  }
  const groups = new Map()
  for (const c of clusters) { const k = topFolder(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c) }
  const rows = ['| folder | clusters | files | cluster ids |', '|---|---|---|---|']
  for (const k of [...groups.keys()].sort(cmp)) { const cs = groups.get(k); rows.push(`| ${cell(k)} | ${cs.length} | ${cs.reduce((s, c) => s + c.files, 0)} | ${cell(cs.map((c) => c.id).join(' '))} |`) }
  return rows.join('\n')
}

function buildDigest(graph, suggested, opts) {
  const budget = Math.max(200, Number((opts && opts.budget) || DEFAULT_BUDGET))
  const blockers = (opts && opts.blockers) || []
  const cl = suggested.clusters
  const unc = graph.uncertainty
  const head = [`# Feature graph digest: ${graph.app}`, '',
    `Graph ${graph.hash || '(unhashed)'} over tree ${graph.scan && graph.scan.treeHash ? graph.scan.treeHash : '(unknown)'}.`,
    `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${cl.length} suggested clusters.`,
    `Resolution: ${graph.resolution.edgesTotal} edges, call sites resolved ${graph.resolution.callSitesResolvedPct}%. This is how much of the app the graph can see.`,
    `Entry: ${suggested.entry ? `${suggested.entry.id}${suggested.entry.scene ? ` -> ${suggested.entry.scene}` : ''}` : 'none (roots are the nodes with no inbound edge)'}.`,
    ...(blockers.length ? ['', '## Assess blockers', ...blockers.slice(0, 10).map((b) => `- ${cell(typeof b === 'string' ? b : b.id || b.title || JSON.stringify(b))}`)] : [])].join('\n')
  const sections = (full) => {
    const out = []
    out.push(`## Clusters\n\n${clusterTable(cl, full)}`)
    if (!full) out.push('The cluster table is rolled up by folder to fit the budget; see graph.json for every cluster.')
    out.push(`## Shared nodes\n\n${suggested.shared.length ? [...suggested.shared.slice(0, 40).map((s) => `- ${s.id} (${s.cluster}): ${s.reason}`), ...(suggested.shared.length > 40 ? [`- ${suggested.shared.length - 40} more, see graph.json`] : [])].join('\n') : 'none'}`)
    out.push(`## Cycles\n\n${suggested.cycles.length ? [...suggested.cycles.slice(0, 20).map((c) => `- ${c.join(', ')}`), ...(suggested.cycles.length > 20 ? [`- ${suggested.cycles.length - 20} more, see graph.json`] : [])].join('\n') : 'none'}`)
    if (suggested.unreached.length) out.push(`## Unreached\n\n${suggested.unreached.length} nodes have no path from the entry (dead code, or reached only through dynamic edges): ${list(suggested.unreached, 10)}.`)
    const kinds = Object.keys(unc.counts).sort(cmp)
    const lines = [`## Uncertainty\n\n${unc.total} items. ${kinds.map((k) => `${k} ${unc.counts[k]}`).join(', ') || 'none'}.`]
    const items = unc.items.slice(0, TOP_UNCERTAIN)
    for (const i of items) lines.push(`- ${i.kind} at ${cell(i.at)}${i.detail ? `: ${cell(i.detail).slice(0, 120)}` : ''}`)
    if (unc.total > items.length) lines.push(`- ${unc.total - items.length} more, see graph.json`)
    out.push(lines.join('\n'))
    return out
  }
  const assemble = (full) => `${head}\n\n${sections(full).join('\n\n')}\n`
  let text = assemble(true)
  if (text.length <= budget) return text
  const note = `Truncated to fit the ${budget} character budget: later sections omitted, see graph.json for the full data.`
  const secs = sections(false)
  let out = head
  for (const s of secs) { if (out.length + s.length + 2 > budget - note.length - 4) break; out += `\n\n${s}` }
  if (out.length === head.length) out += `\n\n${compactClusters(cl, budget - note.length - 6 - head.length)}`
  return `${out}\n\n${note}\n`.slice(0, budget)
}

function focusSlice(graph, suggested, clusterId, opts) {
  const max = Math.min((opts && opts.max) || FOCUS_MAX, FOCUS_MAX)
  const c = suggested.clusters.find((x) => x.id === clusterId || x.slug === clusterId)
  if (!c) throw Object.assign(new Error(`unknown cluster: ${clusterId}. Known: ${suggested.clusters.map((x) => x.id).join(', ')}`), { code: 'unknown-cluster' })
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const inC = new Set(c.members)
  const out = [`# Focus: ${c.id} (${c.name})`, '', `Kind ${c.kind}. Reason: ${c.reason}.`, `${c.files} files, ${c.components} components. Predicted classes: ${mixText(c.classMix)}.`,
    `Depends on: ${c.dependsOn.join(', ') || 'none'}. Used by: ${c.usedByClusters.join(', ') || 'none'}.`, '', '## Members']
  for (const id of c.members) {
    const n = byId.get(id); const t = n && n.testability
    out.push(`- ${id}${t ? ` [${t.primary.class}${t.primary.rule ? ` ${t.primary.rule}` : ''}${t.alsoNeeds.length ? `; also ${[...new Set(t.alsoNeeds.map((a) => a.class))].join('/')}` : ''}]` : ''}`)
  }
  const crossing = graph.edges.filter((e) => inC.has(e.from) && e.to && !inC.has(e.to) && !String(e.to).startsWith('builtin:') && !String(e.to).startsWith('global:') && !String(e.to).startsWith('registry:'))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind))
  out.push('', '## Edges leaving the cluster')
  for (const e of crossing) out.push(`- ${e.from} -${e.kind}/${e.conf}-> ${e.to} (${e.at})`)
  if (!crossing.length) out.push('none')
  const unc = graph.uncertainty.items.filter((i) => inC.has(`file:${String(i.at).replace(/:\d+$/, '')}`))
  out.push('', '## Uncertainty here')
  for (const i of unc) out.push(`- ${i.kind} at ${i.at}${i.detail ? `: ${String(i.detail).slice(0, 120)}` : ''}`)
  if (!unc.length) out.push('none')
  const text = `${out.join('\n')}\n`
  return cut(text, max, `Truncated at ${max} characters; see graph.json for the rest.`)
}

// ---- skeleton --------------------------------------------------------------------------------------------------------
function riskOf(c, inCycle) {
  const mix = c.classMix || {}
  if (inCycle || (mix.unknown || 0) * 2 > Object.values(mix).reduce((a, b) => a + b, 0)) return 'high'
  return Object.keys(mix).some((k) => classRank(k) >= classRank('headless-fixtures')) ? 'medium' : 'low'
}
function buildSkeleton(graph, suggested) {
  const inCycle = new Set(suggested.cycles.flat())
  const features = []; const ignored = []; const used = new Set()
  const slugOf = (c) => { let s = (c.slug || c.id).slice(0, 48).replace(/-+$/, '') || 'feature'; let i = 2; const base = s; while (used.has(s)) s = `${base.slice(0, 44)}-${i++}`; used.add(s); return s }
  for (const c of suggested.clusters) {
    if (c.kind === 'vendor') { ignored.push({ members: c.members.filter((m) => m.startsWith('file:')), reason: 'vendor' }); continue }
    const cyc = c.members.some((m) => inCycle.has(m))
    features.push({
      id: slugOf(c), name: String(c.name).slice(0, 60), kind: c.kind,
      summary: `${c.reason}. ${c.files} files, ${c.components} components; predicted classes: ${mixText(c.classMix)}.`.slice(0, 400),
      members: c.members.slice(), risk: riskOf(c, cyc),
    })
  }
  return {
    schema: 'brighttest-feature-tree/v1',
    graph: { hash: graph.hash, treeHash: graph.scan && graph.scan.treeHash },
    provenance: { author: 'brighttest', createdFrom: 'graph.suggested' },
    features,
    ignored,
    paths: { recommended: 'leaf-first', reason: 'default: shared code is tested first so the screens that depend on it start from tested parts' },
  }
}

module.exports = { buildDigest, focusSlice, buildSkeleton, DEFAULT_BUDGET, FOCUS_MAX }
