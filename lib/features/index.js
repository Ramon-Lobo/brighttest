'use strict'
// `brighttest features` command: argument parsing, HELP, exit codes, output folder and its self-ignore.
//
//   run(argv, io) -> Promise<exitCode>      io.stdout / io.stderr (strings), defaults to the process streams
//
// Read-only on the project, like assess: no network, no device, no lease, no subprocess. Output goes to
// `<stagingDir>/features/` (default `.brighttest/features/`) or `--out`; that folder writes its own `.gitignore`
// when the project's .gitignore does not already cover it, so the project's own .gitignore is never edited.
const fs = require('node:fs')
const path = require('node:path')
const assess = require('../assess')

const EXIT = { OK: 0, INTERNAL: 1, USAGE: 2, INVALID: 3 }
const { UsageError } = assess
const SUBCOMMANDS = ['graph', 'check']

const HELP = `
brighttest features — map a Roku app's files, components and calls into a dependency graph

Usage: brighttest features graph [<dir>] [--out <dir>] [--json] [-c <config>]
       brighttest features check [<tree.json>] [--graph <graph.json>] [--json] [--partial]

  <dir>        project root (default: current directory)
  --out <dir>  where to write graph.json (default: <stagingDir>/features, i.e. .brighttest/features;
               refused inside source/ or components/)
  --json       print the brighttest-feature-graph/v1 JSON document instead of the short summary
  -c <file>    brighttest config to use instead of <dir>/brighttest.json

  The output folder gets a .gitignore containing * unless the project's own .gitignore already ignores .brighttest/,
  so generated files are not committed. The project's own .gitignore is never edited.
  Read-only on the project: no network, no device, no subprocess.
  Exit codes: 0 graph produced (findings never change it), 1 internal error, 2 usage error, missing <dir>,
  bad config or --out refused.

  check validates a brighttest-feature-tree/v1 document against its graph (rules V1-V9: shape, binding to this graph,
  every file assigned once, component and XML together, ids, overrides, proposed tests, plain text, recommended path).
  <tree.json>  the tree (default: <stagingDir>/features/tree.json)
  --graph <f>  the graph it was written for (default: graph.json next to the tree)
  --json       print the findings as JSON ({ ok, errors, warnings, findings[{severity, rule, code, pointer, message}] })
  --partial    allow files that are in no feature yet (incremental mapping)
  Read-only. Exit codes: 0 valid (warnings allowed), 1 internal error, 2 usage error or unreadable input,
  3 tree invalid or stale.
`

function parseArgs(argv) {
  const o = { sub: null, dir: null, json: false, out: null, config: null, help: false, graph: null, partial: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--json') o.json = true
    else if (a === '--partial') o.partial = true
    else if (a === '--graph') { const v = argv[++i]; if (!v || v.startsWith('-')) throw new UsageError('--graph needs a value'); o.graph = v }
    else if (a.startsWith('--graph=')) { o.graph = a.slice(8); if (!o.graph) throw new UsageError('--graph needs a value') }
    else if (a === '--out' || a === '-c' || a === '--config') {
      const v = argv[++i]
      if (!v || v.startsWith('-')) throw new UsageError(`${a} needs a value`)
      if (a === '--out') o.out = v; else o.config = v
    } else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--config=')) o.config = a.slice(9)
    else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`)
    else if (o.sub === null) o.sub = a
    else if (o.dir === null) o.dir = a
    else throw new UsageError(`unexpected argument ${a}`)
  }
  if (!o.help) {
    if (o.sub === null) throw new UsageError(`missing subcommand (${SUBCOMMANDS.join(', ')}); see: features --help`)
    if (!SUBCOMMANDS.includes(o.sub)) throw new UsageError(`unknown subcommand ${o.sub} (${SUBCOMMANDS.join(', ')})`)
  }
  return o
}

const within = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

// Writes `<outDir>/.gitignore` (`*`) unless the output sits outside the project, or sits under .brighttest/ which the
// project's .gitignore already ignores. Never touches an existing .gitignore that is not exactly ours, and never
// writes at the project root. Returns true when it wrote the file.
function selfIgnore(outDir, root) {
  if (!within(root, outDir)) return false
  if (path.resolve(outDir) === path.resolve(root)) return false
  const own = path.join(outDir, '.gitignore')
  let have = null
  try { have = fs.readFileSync(own, 'utf8') } catch (e) { /* none */ }
  if (have !== null) return false
  const dotBt = path.join(root, '.brighttest')
  if (within(dotBt, outDir)) {
    let text = null
    try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8') } catch (e) { /* none */ }
    if (text !== null && assess.gitignoreSection([{ rel: '.gitignore' }], new Map([['.gitignore', text]])).brighttest) return false
  }
  fs.writeFileSync(own, '*\n')
  return true
}

// Reads the config the way assess does (an explicit -c is resolved against the current directory); a missing or
// malformed file is a usage error. Returns { file, config } with config the parsed object ({} when there is none).
function readConfig(root, configArg) {
  const census = require('../instrument/census')
  const file = configArg ? path.resolve(configArg) : path.join(root, 'brighttest.json')
  const got = census.safeRead(file, configArg ? { followLink: true, skipName: true } : {})
  if (!got.buf) {
    if (configArg) throw new UsageError(`cannot read config ${path.basename(file)}: ${got.refused === 'missing' ? 'ENOENT' : got.refused}`)
    if (got.refused && got.refused !== 'missing') throw new UsageError(`cannot read config brighttest.json: ${got.refused}`)
    return { file: configArg ? file : null, config: {} }
  }
  let config
  try { config = JSON.parse(got.buf.toString('utf8')) } catch (e) { throw new UsageError(`cannot read config ${path.basename(file)}: invalid JSON`) }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UsageError(`config ${path.basename(file)} must be a JSON object`)
  return { file: configArg ? file : null, config }
}

function stagingDirOf(root, configFile) {
  try { return require('../config').loadConfig(root, configFile).stagingDir } catch (e) { return path.join(root, '.brighttest') }
}

function summary(g, outDir, wrote) {
  const L = [`brighttest features graph (${g.schema})`]
  const n = (k) => g.nodes.filter((x) => x.kind === k).length
  L.push(`app:         ${g.app}`)
  L.push(`nodes:       ${g.nodes.length} (${n('file')} files, ${n('component')} components)`)
  L.push(`edges:       ${g.resolution.edgesTotal}`)
  L.push(`uncertainty: ${g.uncertainty.total}`)
  L.push(`scan:        ${g.scan.files} files, tree ${String(g.scan.treeHash).slice(0, 12)}${g.scan.truncated ? ' (truncated)' : ''}`)
  if (wrote) L.push(`wrote:       ${wrote}`)
  return L.join('\n') + '\n'
}

async function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s))
  const stderr = io.stderr || ((s) => process.stderr.write(s))
  try {
    const o = parseArgs(argv)
    if (o.help) { stdout(HELP.trimStart()); return EXIT.OK }
    if (o.sub === 'check') {
      if (o.out || o.config) throw new UsageError('check does not take --out or -c')
      if (!o.dir) { // same config handling as `features graph`: a malformed brighttest.json is a usage error
        const root = path.resolve('.')
        o.stagingDir = stagingDirOf(root, readConfig(root, null).file)
      }
      return require('./check').runCheck(o, { stdout }, UsageError)
    }
    if (o.graph || o.partial) throw new UsageError('--graph and --partial belong to features check')
    const root = path.resolve(o.dir || '.')
    let st = null
    try { st = fs.statSync(root) } catch (e) { /* missing */ }
    if (!st || !st.isDirectory()) throw new UsageError(`${o.dir || '.'} is not a directory`)
    const { buildGraph } = require('./graph')
    const { file: configFile, config } = readConfig(root, o.config)
    const graph = await buildGraph(root, { config: configFile })
    const outArg = o.out || path.join(stagingDirOf(root, configFile), 'features')
    const baseRel = path.relative(root, require('../instrument/census').effectiveBase(root, config.rootDir)).split(path.sep).join('/') || '.'
    let outDir
    try { outDir = assess.checkOut(outArg, root, baseRel) } catch (e) {
      if (!o.out && e instanceof UsageError) throw new UsageError(`the staging directory ${outArg} is inside source/ or components/; set stagingDir in brighttest.json to a folder outside the app sources, or pass --out`)
      throw e
    }
    let existing = null
    try { existing = fs.statSync(outDir) } catch (e) { /* not there yet */ }
    if (existing && !existing.isDirectory()) throw new UsageError(`--out ${outArg} is an existing file; choose a directory`)
    try { fs.mkdirSync(outDir, { recursive: true }) } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOTDIR') throw new UsageError(`--out ${outArg} cannot be created: a path part is a file`)
      throw e
    }
    fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n')
    selfIgnore(outDir, root)
    stdout(o.json ? JSON.stringify(graph, null, 2) + '\n' : summary(graph, outDir, path.join(outDir, 'graph.json')))
    return EXIT.OK
  } catch (e) {
    if (e instanceof UsageError) { stderr(`[brighttest features] ${e.message}\n`); return EXIT.USAGE }
    stderr(`[brighttest features] internal error: ${e && e.message}\n`)
    return EXIT.INTERNAL
  }
}

module.exports = { run, parseArgs, selfIgnore, HELP, EXIT }
