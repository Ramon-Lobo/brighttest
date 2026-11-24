// Synthetic feature graphs for the cluster and digest tests (no bsc, no files).
// ---- synthetic graphs: { comps: [name | {name,task,dir}], files: [relpath | {rel,vendor}], edges: [[from,to,kind,conf?]] } --------
const tn = (cls) => ({ primary: { class: cls, rule: null, needs: [] }, alsoNeeds: [], uncertainty: [], notes: [], evidence: cls === 'unknown' ? 'none' : 'rule' })
function mk({ comps = [], files = [], edges = [], entry = 'S', classes = {} }) {
  const nodes = [{ id: 'file:manifest', kind: 'file', lang: 'manifest', vendor: false, spec: false }]
  if (entry) { nodes.push({ id: 'entry:main', kind: 'entry', file: 'source/main.brs' }, { id: 'file:source/main.brs', kind: 'file', lang: 'brs', vendor: false, spec: false, testability: tn('headless-unit') }) }
  for (const c of [{ name: 'S', scene: true }, ...comps].map((x) => (typeof x === 'string' ? { name: x } : x))) {
    const dir = c.dir || `components/${c.name.toLowerCase()}`
    nodes.push({ id: `comp:${c.name}`, kind: 'component', file: `${dir}/${c.name}.xml`, extends: 'Group', isScene: !!c.scene, isTask: !!c.task, testability: tn(classes[c.name] || 'headless-scene') })
    nodes.push({ id: `file:${dir}/${c.name}.xml`, kind: 'file', lang: 'xml', vendor: false, spec: false })
  }
  for (const f of files.map((x) => (typeof x === 'string' ? { rel: x } : x))) nodes.push({ id: `file:${f.rel}`, kind: 'file', lang: 'brs', vendor: !!f.vendor, spec: false, testability: tn(classes[f.rel] || 'headless-unit') })
  const E = edges.map(([from, to, kind, conf], i) => ({ from, to, kind, conf: conf || 'name', at: `x:${i + 1}` }))
  if (entry) E.push({ from: 'entry:main', to: 'comp:S', kind: 'entry', conf: 'name', at: 'source/main.brs:1' })
  return { app: 'Synth', hash: 'h', scan: { treeHash: 't' }, nodes, edges: E, resolution: { edgesTotal: E.length, byConf: {}, callSitesResolvedPct: 100 }, uncertainty: { counts: {}, total: 0, items: [], blindSpots: [] } }
}
module.exports = { mk }
