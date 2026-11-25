'use strict'
// brighttest assess (ADOPT-05a): a read-only, offline, in-process assessment of a Roku project.
// Contract: docs/guide/assess.md. Includes the secret scan (key name + file:line only, never a value) and the
// risky-pattern scan (ADOPT-05b); `scans` records that each ran and how many files it looked at.
//
// It never: touches the network, a device or the lease, spawns a process, opens `.env*`, key or cert files, or the
// device cache (stat only for `devices`), or writes anything except under `--out`.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const engines = require('./engines')

const SCHEMA = 'brighttest-assess/v1'
const EXIT = { OK: 0, INTERNAL: 1, USAGE: 2 }
const MAX_FILES = 20000
const MAX_BYTES = 2 * 1024 * 1024
const GREENFIELD_MAX_COMPONENTS = 5 // a manifest with fewer components than this and no specs is greenfield
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.brighttest', 'coverage', 'reports', 'certs'])
const SENSITIVE_FILE = /(^\.env($|\.))|\.(pem|p12|pkg|key)$|^id_rsa/i
const ENV_DIR = /^\.env($|\.)/i // folders named .env* are never entered; other secret-looking names apply to files only
const CI_FILES = { Jenkinsfile: 'jenkins', '.gitlab-ci.yml': 'gitlab-ci', 'azure-pipelines.yml': 'azure-pipelines', 'bitbucket-pipelines.yml': 'bitbucket-pipelines' }
const MANIFEST_KEYS = ['bs_const', 'splash_min_time', 'rsg_version', 'supports_input_launch', 'bsprof_enable']
const LARGE_GLOBAL_FIELDS = 20 // more distinct m.global fields than this is reported once as `large-global`
const SPEC_RE = /\.spec\.(bs|brs)$/i

const HELP = `
brighttest assess — read-only, offline assessment of a Roku project

Usage: brighttest assess [<dir>] [--json] [--out <dir>] [-c <config>]

  <dir>        project root (default: current directory)
  --json       print the brighttest-assess/v1 JSON document instead of the human summary
  --out <dir>  also write assess.json, assess.md, census.json, census.md there (refused inside source/ or components/)
  -c <file>    brighttest config to use instead of <dir>/brighttest.json

  Reads only manifest, bsconfig*.json, package.json, package-lock.json, brighttest*.json, .gitignore, CI files and
  BrightScript/XML sources. Never opens .env*, key or cert files or the device cache. No network, no device, no
  subprocess. Without --out nothing is written.
  Exit codes: 0 report produced (findings never change it; a non-Roku dir is 0 with path "not-a-roku-app"),
  1 internal error, 2 usage error, missing <dir>, bad config or --out refused.
`

class UsageError extends Error {}

function parseArgs(rest) {
  const o = { dir: null, json: false, out: null, config: null, help: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--json') o.json = true
    else if (a === '--out' || a === '-c' || a === '--config') {
      const v = rest[++i]
      if (!v || v.startsWith('-')) throw new UsageError(`${a} needs a value`)
      if (a === '--out') o.out = v; else o.config = v
    } else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--config=')) o.config = a.slice(9)
    else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`)
    else if (o.dir === null) o.dir = a
    else throw new UsageError(`unexpected argument ${a}`)
  }
  return o
}

// ---- scan --------------------------------------------------------------------------------------------------------
// Lists files under root (posix relative paths, sorted), skipping SKIP_DIRS at any depth and sensitive names entirely.
// Only the root `.git/` is skipped (its `.gitignore` sibling at the root is a plain file, so it is still listed).
function scan(root) {
  const files = []
  const stats = { skippedSensitive: 0, overCap: 0, truncated: false }
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    let entries
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch (e) { continue }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (ENV_DIR.test(e.name)) { stats.skippedSensitive++; continue } if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(r); continue }
      if (!e.isFile()) continue
      if (SENSITIVE_FILE.test(e.name)) { stats.skippedSensitive++; continue }
      if (files.length >= MAX_FILES) { stats.truncated = true; stack.length = 0; break }
      let size = 0
      try { size = fs.statSync(path.join(root, r)).size } catch (err) { continue }
      if (size > MAX_BYTES) { stats.overCap++; stats.truncated = true; continue }
      files.push({ rel: r, size })
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, ...stats }
}

const READ_RE = /(^|\/)(manifest|package\.json|package-lock\.json|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml)$|(^|\/)(bsconfig|brighttest)[^/]*\.json$|\.(brs|bs|xml)$|^\.gitignore$|^\.github\/workflows\/[^/]+\.ya?ml$/i

function readTree(root, files) {
  const text = new Map()
  const lines = []
  for (const f of files) {
    let h = '-'
    if (READ_RE.test(f.rel)) {
      let buf = null
      buf = require('./instrument/census').safeRead(path.join(root, f.rel)).buf || null // refused or unreadable: size only
      if (buf) { h = crypto.createHash('sha256').update(buf).digest('hex'); text.set(f.rel, buf.toString('utf8')) }
    }
    lines.push(`${f.rel}\t${f.size}\t${h}`)
  }
  return { text, treeHash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') }
}

function parseJsonLoose(s) {
  try { return JSON.parse(s) } catch (e) { /* jsonc */ }
  const noComments = s.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'))
}
const tryJson = (s) => { try { return parseJsonLoose(s) } catch (e) { return null } }

// ---- sections ----------------------------------------------------------------------------------------------------
function hostSection(pkg) {
  const required = (pkg.engines && pkg.engines.node) || '>=22'
  const min = parseInt((/(\d+)/.exec(required) || [])[1], 10) || 22
  const major = parseInt(process.versions.node.split('.')[0], 10)
  return { node: process.versions.node, nodeRequired: required, nodeOk: major >= min, platform: process.platform }
}

function parseManifest(t) {
  const out = {}
  for (const line of String(t).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
  }
  return out
}

// bsc falls back to roku-deploy DefaultFiles when bsconfig has no `files`. Printed from roku-deploy in a bsc 0.73 install;
// it may vary by version. A list counts as default-equivalent only if every entry is exactly one of these (order and
// duplicates ignored); looser variants such as source/** are not assumed equivalent.
const ROKU_DEPLOY_DEFAULT_FILES = new Set(['source/**/*.*', 'components/**/*.*', 'images/**/*.*', 'locale/**/*', 'manifest'])

function bsconfigSection(text, files) {
  const cands = files.map((f) => f.rel).filter((r) => !r.includes('/') && /^bsconfig[^/]*\.json$/i.test(r))
  const file = cands.includes('bsconfig.json') ? 'bsconfig.json' : cands[0] || null
  if (!file) return { present: false, file: null, rootDir: null, files: [], plugins: [], bsConstOverride: false, unsupported: [], mapping: null }
  const j = tryJson(text.get(file)) || {}
  const plugins = (Array.isArray(j.plugins) ? j.plugins : []).map((p) => (typeof p === 'string' ? p : (p && p.name) || String(p)))
  const bsConstOverride = !!(j.manifest && typeof j.manifest === 'object' && j.manifest.bs_const)
  // string globs as-is; `{ src, dest }` objects are kept as 'src=>dest' strings so they count as a custom list
  const sourceGlobs = (Array.isArray(j.files) ? j.files : []).map((g) => (typeof g === 'string' ? g : (g && typeof g === 'object' && typeof g.src === 'string' ? `${g.src}=>${typeof g.dest === 'string' ? g.dest : ''}` : null))).filter((g) => g !== null)
  const unsupported = []
  if (plugins.length) unsupported.push('plugins')
  if (bsConstOverride) unsupported.push('manifest.bs_const')
  return {
    present: true, file, rootDir: typeof j.rootDir === 'string' ? j.rootDir : null, files: sourceGlobs, plugins, bsConstOverride, unsupported,
    mapping: { rootDir: typeof j.rootDir === 'string' ? j.rootDir : '.', sourceGlobs },
  }
}

function engineSection(root) {
  const out = { warnings: [] }
  for (const [kind, c] of Object.entries(engines.CANDIDATES)) {
    out[kind] = null
    for (const name of [c.patched, c.stock]) {
      let pkg = null
      const got = require('./instrument/census').safeRead(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), { followLink: true })
      if (!got.buf) continue
      try { pkg = JSON.parse(got.buf.toString('utf8')) } catch (e) { continue }
      out[kind] = { name, version: pkg.version || null, patched: !!(pkg.brighttest && typeof pkg.brighttest === 'object') || name === c.patched }
      break
    }
  }
  const b = out.brsNode
  if (b && b.version && engines.cmpVersion(b.version, '2.7.0') < 0) out.warnings.push(`@SGNode suites may hang on brs-node < 2.7.0 (reported; found ${b.version})`)
  return out
}

function ciSection(root, files, text) {
  const systems = []
  const bodies = []
  for (const f of files) {
    const base = f.rel.split('/').pop()
    let sys = null
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(f.rel)) sys = 'github-actions'
    else if (!f.rel.includes('/') && CI_FILES[base]) sys = CI_FILES[base]
    if (!sys) continue
    if (!systems.includes(sys)) systems.push(sys)
    bodies.push(text.get(f.rel) || '')
  }
  const all = bodies.join('\n')
  const versions = new Set()
  for (const m of all.matchAll(/node-version\s*:\s*\[?([^\n\]#]+)/gi)) for (const v of m[1].split(',')) { const n = /(\d+)/.exec(v); if (n) versions.add(n[1]) }
  for (const m of all.matchAll(/\bnode:(\d+)/gi)) versions.add(m[1])
  for (const m of all.matchAll(/\bnodejs\s*['"]?(\d+)/gi)) versions.add(m[1])
  const nodeVersions = [...versions].sort((a, b) => a - b)
  return {
    systems, nodeVersions,
    nodeOk: nodeVersions.length ? nodeVersions.every((v) => Number(v) >= 22) : null,
    selfHosted: /self-hosted/i.test(all),
    runsBrighttest: /\bbrighttest\b/i.test(all),
  }
}

function gitignoreSection(files, text) {
  const body = files.some((f) => f.rel === '.gitignore') ? text.get('.gitignore') : null
  if (body === null || body === undefined) return { present: false, brighttest: false, env: false, coverage: false, instrumentedZip: false }
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const has = (re) => lines.some((l) => re.test(l))
  return {
    present: true,
    brighttest: has(/^\/?\.brighttest\/?(\*\*?)?$/),
    env: has(/^\/?\.env(\*|\.\*)?$/),
    coverage: has(/^\/?coverage\/?/),
    instrumentedZip: has(/instrument.*\.zip$|^\*\.zip$|\.brighttest\/?/),
  }
}

// census.js opens every file under source/ and components/, so look for files it must not open BY NAME AND SIZE ONLY
// (readdir + lstat) before calling it. Symlinks are not followed (census does not follow them either).
function censusGuard(appDir) {
  const found = []
  let seen = 0
  let capped = false
  const walk = (rel) => {
    if (capped) return
    let entries
    try { entries = fs.readdirSync(path.join(appDir, rel), { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      const r = `${rel}/${e.name}`
      if (++seen > MAX_FILES) { capped = true; return }
      if (e.isDirectory()) { if (e.name.toLowerCase() === 'certs' || ENV_DIR.test(e.name)) found.push(`${r}/`); else walk(r); continue }
      if (!e.isFile()) continue
      if (SENSITIVE_FILE.test(e.name)) { found.push(r); continue }
      try { if (fs.statSync(path.join(appDir, r)).size > MAX_BYTES) found.push(r) } catch (err) { /* ignore */ }
    }
  }
  for (const d of ['source', 'components']) walk(d)
  return { found: found.sort(), capped }
}

// ADOPT-29: census errors (for example a missing-module require stack) carry absolute paths and the home directory.
// Paths inside the project root keep their folders relative to it (<path>/components/A.brs); every other absolute path,
// including anything under the home directory, is cut to <path>/<file name>. Used where the census error is copied.
// A path starts at a boundary (not after a word char, ':' or a path separator) and may contain spaces in folder names.
const PATH_RE = /(?<![\w.:/\\<>-])(?:\\\\[^\s\\/:'"`()<>]+[\\/]|[A-Za-z]:[\\/]|[\\/](?=[^\s\\/]))(?:[^\\/:'"`()<>\r\n]+[\\/])*(?:[^\s\\/:'"`()<>]+)?/g
// Pure core: roots are absolute project roots in any separator style. Separators are normalised to '/' and the compare is
// case-insensitive when ci is true (Windows), so a root given with backslashes still matches. Output uses '/'.
function redactPathsWith(text, rootList, ci) {
  const fold = (x) => (ci ? x.toLowerCase() : x)
  const roots = rootList.filter((r) => r && r.length > 1).map((r) => r.replace(/\\/g, '/').replace(/\/+$/, ''))
  return String(text == null ? '' : text).replace(PATH_RE, (m) => {
    const norm = m.replace(/\\/g, '/').replace(/\/+$/, '')
    for (const r of roots) {
      if (fold(norm) === fold(r)) return '<path>'
      if (fold(norm).startsWith(fold(r) + '/')) return `<path>/${norm.slice(r.length + 1)}`
    }
    const base = norm.split('/').filter(Boolean).pop()
    return base ? `<path>/${base}` : '<path>'
  })
}
function redactPaths(text, appDir) {
  return redactPathsWith(text, [appDir, appDir && safeReal(appDir)], process.platform === 'win32')
}
function safeReal(p) { try { return fs.realpathSync(p) } catch (_) { return null } }

// scanDir: the census's effective root (where source/ and components/ are read); root: the project root passed to census
async function censusSection(root, scanDir, config) {
  const appDir = scanDir
  let c = null
  const { found: guarded, capped } = censusGuard(scanDir)
  const emptySummary = (error) => ({ components: 0, scenes: 0, tasks: 0, setUrlSites: 0, setUrlCovered: 0, notCovered: [], couldNotInstrument: 0, inlineCdataScenes: 0, registrySections: [], globalFields: 0, error })
  if (capped) {
    return { full: null, summary: emptySummary(`census skipped: more than ${MAX_FILES.toLocaleString('en-US')} files under source/ or components/ (file cap reached, nothing was opened)`) }
  }
  if (guarded.length) {
    const shown = guarded.slice(0, 5).join(', ') + (guarded.length > 5 ? `, and ${guarded.length - 5} more` : '')
    return { full: null, summary: { components: 0, scenes: 0, tasks: 0, setUrlSites: 0, setUrlCovered: 0, notCovered: [], couldNotInstrument: 0, inlineCdataScenes: 0, registrySections: [], globalFields: 0, error: `census skipped: sensitive or oversized files under source/ or components/ (not opened): ${shown}` } }
  }
  try { c = await require('./instrument/census').census(root, { config: config || {} }) } catch (e) {
    return { full: null, summary: { components: 0, scenes: 0, tasks: 0, setUrlSites: 0, setUrlCovered: 0, notCovered: [], couldNotInstrument: 0, inlineCdataScenes: 0, registrySections: [], globalFields: 0, error: redactPaths(e.message, root) } }
  }
  const by = new Map()
  for (const n of c.notCovered) by.set(n.reason, (by.get(n.reason) || 0) + 1)
  return {
    full: c,
    summary: {
      components: c.counts.components, scenes: c.scenes.length, tasks: c.tasks.length,
      setUrlSites: c.network.setUrlSites.length, setUrlCovered: c.network.setUrlSites.filter((s) => s.covered).length,
      notCovered: [...by.entries()].sort().map(([reason, count]) => ({ reason, count })),
      couldNotInstrument: c.skipped.filter((s) => !s.informational).length,
      inlineCdataScenes: c.inlineCdataScenes.length,
      registrySections: [...new Set(c.registrySections.map((r) => r.name))].sort(),
      globalFields: c.globalFields.length, error: null,
    },
  }
}

// ---- secret and risky-pattern scans ------------------------------------------------------------------------------
// Both work on text already read by readTree (never on .env*, key or cert files). The secret scan returns
// {file, line, key, kind} and never keeps the matched value or the line text.
const SCAN_TEXT_RE = /\.(brs|bs|xml)$|(^|\/)manifest$|(^|\/)(bsconfig|brighttest)[^/]*\.json$/i
const MAX_LINE = 4000
// A key is sensitive when one of its words (camelCase, snake_case or kebab-case parts) is, or ends in, a secret word
// (`apitoken`, `clientSecret`, `ROKU_PASSWORD`, `JWTToken`). `author`, `passThrough`, `compass`, `authStatus` and a bare
// `pass` or `auth` are not flagged.
const SECRET_WORD_END = /(password|passwd|passphrase|secret|token|apikey|credentials?)$/
function isSecretKey(key) {
  const w = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x.toLowerCase())
  if (w.some((x) => SECRET_WORD_END.test(x) || x === 'authorization' || x === 'bearer' || /^(api|access|private|secret)key$/.test(x))) return true
  return w.some((x, i) => (x === 'key' && i > 0 && ['api', 'private', 'access'].includes(w[i - 1])))
}
const SECRET_KEY_NOT_RE = /(type|url|uri|path|name|label|field|endpoint|header|scheme|enabled)$/i
const PLACEHOLDER_RE = /^(\$\{.*\}|\{\{.*\}\}|<.*>|x+|\*+|changeme|your[-_].*|todo|null|none|true|false)$/i
const ASSIGN_RE = /([A-Za-z_][\w.-]{0,63})["']?\s*[:=]\s*"([^"]{4,4000})"/g
const XML_TAG_RE = /<[A-Za-z][^>]{0,4000}>/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const URL_CRED_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@"']+:[^/\s@"']+@/i

function secretScan(files, text) {
  const out = []
  let scanned = 0
  let skippedLongLines = 0
  for (const f of files) {
    if (!SCAN_TEXT_RE.test(f.rel)) continue
    const body = text.get(f.rel)
    if (body === undefined) continue
    scanned++
    const lines = body.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (ln.length > MAX_LINE) { skippedLongLines++; continue }
      const seen = new Set()
      const add = (kind, key) => { const id = `${kind}\0${key}`; if (!seen.has(id)) { seen.add(id); out.push({ file: f.rel, line: i + 1, key, kind }) } }
      for (const m of ln.matchAll(ASSIGN_RE)) {
        const key = m[1].split('.').pop().slice(0, 64)
        if (key && isSecretKey(key) && !SECRET_KEY_NOT_RE.test(key) && !PLACEHOLDER_RE.test(m[2])) add('assignment', key)
      }
      if (/\.xml$/i.test(f.rel)) {
        for (const t of ln.matchAll(XML_TAG_RE)) {
          const idm = /\b(?:id|name)\s*=\s*"([A-Za-z_][\w.-]{0,63})"/i.exec(t[0])
          const valm = /\bvalue\s*=\s*"([^"]{4,4000})"/i.exec(t[0])
          if (!idm || !valm) continue
          const key = idm[1].split('.').pop()
          if (isSecretKey(key) && !SECRET_KEY_NOT_RE.test(key) && !PLACEHOLDER_RE.test(valm[1])) add('assignment', key)
        }
      }
      if (BEARER_RE.test(ln)) add('bearer-literal', null)
      if (PRIVATE_KEY_RE.test(ln)) add('private-key', null)
      if (ln.includes('://') && URL_CRED_RE.test(ln)) add('url-credentials', null)
    }
  }
  return { findings: out, scanned, skippedLongLines }
}

// Removes a trailing ' or REM comment and blanks string contents, so patterns only match code.
function codeView(line) {
  let kept = '', code = '', q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      kept += c
      if (c === q) { q = null; code += c } else code += ' '
      continue
    }
    if (c === '"' || c === '`') { q = c; kept += c; code += c; continue }
    if (c === "'") break
    if (c === ':' && /^:\s*rem\b/i.test(line.slice(i))) break
    kept += c
    code += c
  }
  if (/^\s*rem\b/i.test(code)) return { kept: '', code: '' }
  return { kept, code }
}

function taskScripts(files, text) {
  const set = []
  for (const f of files) {
    if (!/\.xml$/i.test(f.rel)) continue
    const body = text.get(f.rel)
    if (!body || !/<component\b[^>]*\bextends\s*=\s*"Task"/i.test(body)) continue
    const dir = f.rel.split('/').slice(0, -1).join('/')
    for (const m of body.matchAll(/<script\b[^>]*\buri\s*=\s*"([^"]+)"/gi)) {
      const u = m[1].replace(/^pkg:\/?/i, '')
      set.push(m[1].toLowerCase().startsWith('pkg:') ? u.toLowerCase() : path.posix.normalize(dir ? `${dir}/${u}` : u).toLowerCase())
    }
  }
  return (rel) => { const r = rel.toLowerCase(); return set.some((u) => r === u || r.endsWith(`/${u}`)) }
}

// True when the `while` loop starting at line `start` has a `wait(` call in its body (a Task blocking on its port).
function loopWaits(views, start) {
  let depth = 0
  for (let j = start; j < views.length; j++) {
    const code = views[j] ? views[j].code : ''
    if (/^\s*while\b/i.test(code)) depth++
    else if (/^\s*(end\s*while|endwhile)\b/i.test(code)) { if (--depth === 0) return false }
    if (j > start && /\bwait\s*\(/i.test(code)) return true
  }
  return false
}

function riskyScan(files, text) {
  const out = []
  const isTask = taskScripts(files, text)
  const globals = new Map()
  let scanned = 0
  let skippedLongLines = 0
  for (const f of files) {
    if (!/\.(brs|bs)$/i.test(f.rel)) continue
    const body = text.get(f.rel)
    if (body === undefined) continue
    scanned++
    const task = isTask(f.rel)
    const hasInput = /roInput/i.test(body)
    const lines = body.split(/\r?\n/)
    const views = lines.map((l) => (l.length > MAX_LINE ? null : codeView(l)))
    skippedLongLines += views.filter((v) => v === null).length
    for (let i = 0; i < lines.length; i++) {
      if (!views[i]) continue
      const { kept, code } = views[i]
      if (!code.trim()) continue
      const hit = (kind) => out.push({ kind, file: f.rel, line: i + 1 })
      if (/\beval\s*\(/i.test(code)) hit('eval')
      if (hasInput && /\.getInfo\s*\(\s*\)/i.test(code)) hit('roInput-unknown-keys')
      if (!task && /\.(getToString|getToFile|postFromString|postFromFile)\s*\(/i.test(code)) hit('render-thread-sync-http')
      if (task && /^\s*while\s+(true|1)\b/i.test(code) && !loopWaits(views, i)) hit('task-infinite-loop')
      if (/^\s*(print\b|\?)/i.test(code) && /\b(launchArgs|inputData|deeplink\w*|contentId|mediaType)\b/i.test(code)) hit('logs-deeplink-params')
      const note = (name) => { if (!globals.has(name)) globals.set(name, { file: f.rel, line: i + 1 }) }
      for (const m of code.matchAll(/\bm\.global\.(\w+)\s*=(?!=)/gi)) note(m[1].toLowerCase())
      for (const m of kept.matchAll(/\bm\.global\.addField\s*\(\s*"(\w+)"/gi)) note(m[1].toLowerCase())
      const af = /\bm\.global\.addFields\s*\(\s*\{([^}]*)\}/i.exec(kept)
      if (af) for (const m of af[1].matchAll(/(\w+)\s*:/g)) note(m[1].toLowerCase())
    }
  }
  if (globals.size > LARGE_GLOBAL_FIELDS) {
    const first = [...globals.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))[0]
    out.push({ kind: 'large-global', file: first.file, line: first.line })
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)))
  return { findings: out, scanned, skippedLongLines }
}

function projectRel(root, file) {
  if (!file) return null
  const rel = path.relative(root, file)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

// ---- assemble ----------------------------------------------------------------------------------------------------
async function assess(rootArg, opts = {}) {
  const root = path.resolve(rootArg || '.')
  let st = null
  try { st = fs.statSync(root) } catch (e) { /* missing */ }
  if (!st || !st.isDirectory()) throw new UsageError(`${rootArg || '.'} is not a directory`)

  let config = null
  let configFile = null
  if (opts.config) {
    configFile = path.resolve(opts.config)
    const got = require('./instrument/census').safeRead(configFile, { followLink: true, skipName: true })
    if (got.refused) throw new UsageError(`cannot read config ${path.basename(configFile)}: ${got.refused === 'missing' ? 'ENOENT' : got.refused}`)
    try { config = parseJsonLoose(got.buf.toString('utf8')) } catch (e) { throw new UsageError(`cannot read config ${path.basename(configFile)}: invalid JSON`) }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UsageError(`config ${opts.config} must be a JSON object`)
  }

  const sc = scan(root)
  const { text, treeHash } = readTree(root, sc.files)
  const rels = sc.files.map((f) => f.rel)
  if (!config) {
    const rc = rels.includes('brighttest.json') ? 'brighttest.json' : rels.find((r) => /^brighttest[^/]*\.json$/i.test(r))
    if (rc) { config = tryJson(text.get(rc)); configFile = path.join(root, rc); if (!config || typeof config !== 'object') config = null }
  }

  const pkg = tryJson(text.get('package.json') || '') || {}
  const cliPkg = require('../package.json')
  const bs = bsconfigSection(text, sc.files)
  // the census's effective root (brighttest.json rootDir, else bsconfig rootDir through extends, else the project root)
  const effBase = require('./instrument/census').effectiveBase(root, config && config.rootDir)
  const scanRel = path.relative(root, effBase).split(path.sep).join('/')
  const man = scanRel && rels.includes(`${scanRel}/manifest`) ? `${scanRel}/manifest` : rels.includes('manifest') ? 'manifest' : null
  const baseRel = man ? man.split('/').slice(0, -1).join('/') : ''
  const appDir = path.join(root, scanRel)
  const under = (r, d) => r.startsWith(scanRel ? `${scanRel}/${d}/` : `${d}/`)
  const dirs = ['source', 'components'].filter((d) => rels.some((r) => under(r, d)))
  const count = (re) => sc.files.filter((f) => re.test(f.rel)).length
  const nBrs = count(/\.brs$/i), nBs = count(/\.bs$/i)
  const language = nBs && nBrs ? 'mixed' : nBs ? 'brighterscript' : 'brightscript'
  const manText = man ? parseManifest(text.get(man) || '') : {}
  const manifestKeys = {}
  for (const k of MANIFEST_KEYS) manifestKeys[k] = Object.prototype.hasOwnProperty.call(manText, k) ? manText[k] : null

  const deps = Object.assign({}, pkg.devDependencies, pkg.dependencies)
  const lock = tryJson(text.get('package-lock.json') || '') || {}
  const lockVer = (n) => { const e = lock.packages && lock.packages[`node_modules/${n}`]; return e && e.version ? e.version : null }
  const specs = sc.files.filter((f) => SPEC_RE.test(f.rel)).map((f) => f.rel)
  const rooibosDep = deps['rooibos-roku'] || deps['@ramonlobo/rooibos-roku'] || null
  const brsAnnotated = specs.filter((r) => /\.brs$/i.test(r) && /'\s*@suite\b/i.test(text.get(r) || '')).length

  const sec = secretScan(sc.files, text)
  const risk = riskyScan(sc.files, text)
  const cen = await censusSection(root, appDir, config || {})
  const ci = ciSection(root, sc.files, text)
  const eng = engineSection(root)
  const host = hostSection(cliPkg)
  const cfgKeys = config ? Object.keys(config).sort() : []

  const project = {
    isRokuApp: !!man, manifest: !!man, dirs, language,
    bsconfig: bs,
    ropm: !!(deps.ropm || rels.some((r) => r.startsWith('roku_modules/'))),
    packageManagerDeps: { brighterscript: deps.brighterscript || null, 'rooibos-roku': rooibosDep, brighttest: deps.brighttest || null },
    rooibos: { present: !!rooibosDep || specs.length > 0, specFiles: specs.length, specsOutsideSource: specs.filter((r) => !under(r, 'source')).length, brsAnnotated },
    manifestKeys,
    files: { brs: nBrs, bs: nBs, xml: count(/\.xml$/i), bytes: sc.files.reduce((n, f) => n + f.size, 0), truncated: sc.truncated },
  }

  let recPath
  if (!man) recPath = 'not-a-roku-app'
  else if (cen.summary.components < GREENFIELD_MAX_COMPONENTS && specs.length === 0) recPath = 'greenfield'
  else recPath = 'brownfield'
  const blockers = []
  if (bs.plugins.length) blockers.push(`bsconfig plugins are not honored by brighttest: ${bs.plugins.join(', ')}`)
  if (bs.bsConstOverride) blockers.push('bsconfig manifest.bs_const overrides are not honored by brighttest')
  // ADOPT-27: census follows a bsconfig rootDir (direct or through extends) only as a hint when brighttest.json sets no
  // rootDir. Build and instrument take their root from brighttest.json rootDir (default ".") and never read bsconfig.json,
  // so a bsconfig rootDir that brighttest.json does not repeat is a blocker to confirm with the human, not a census gap.
  // The rootDir value is echoed JSON-quoted (control characters escaped) and only when it is a relative path inside the
  // project; absolute or `..` values are never read. A rootDir set through `extends` is not detected here (census reads it).
  const norm = (v) => String(v).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.'
  const rd = bs.rootDir && norm(bs.rootDir)
  const rdActive = !!(rd && rd !== '.')
  const btSet = !!(config && typeof config.rootDir === 'string' && config.rootDir.trim() !== '')
  const btAbs = path.resolve(root, btSet ? config.rootDir : '.')
  const inherited = !rdActive && !btSet && !!scanRel // census moved through a bsconfig `extends`
  const hintRd = rdActive ? rd : inherited ? scanRel : null
  if (hintRd && (inherited || path.resolve(root, hintRd) !== btAbs)) {
    const outside = /^([A-Za-z]:|\/)/.test(hintRd) || hintRd.split('/').includes('..')
    blockers.push(`bsconfig rootDir is read by the census as a hint only; the brighttest build uses rootDir from brighttest.json and does not read bsconfig.json (set the same rootDir in brighttest.json, and confirm with the human): ${outside ? 'points outside the project root, not read' : JSON.stringify(hintRd)}`)
  }
  const filesDefault = bs.files.length > 0 && bs.files.every((g) => ROKU_DEPLOY_DEFAULT_FILES.has(g))
  if (bs.files.length && !filesDefault) blockers.push(`bsconfig files list is not honored by brighttest (the default source/, components/ layout is assumed): ${bs.files.length} entr${bs.files.length === 1 ? 'y' : 'ies'}`)
  if (man && !cen.summary.error && cen.summary.scenes === 0 && !hintRd) blockers.push('census found 0 scenes: check the app keeps components/ under the rootDir (or the project root)')
  if (cen.summary.error) blockers.push(/^census skipped/.test(cen.summary.error) ? cen.summary.error : `census could not parse the project: ${cen.summary.error}`)
  if (!host.nodeOk) blockers.push(`Node ${process.versions.node} does not satisfy ${host.nodeRequired}`)
  const nextSteps = recPath === 'not-a-roku-app' ? ['run assess from the project root (the folder with the manifest), or create the app first']
    : recPath === 'greenfield' ? ['npx brighttest init', 'npx brighttest skills install', 'write the first spec, then npx brighttest']
      : ['npx brighttest doctor --engines', 'npx brighttest init', 'npx brighttest instrument census', 'npx brighttest']
  const unknowns = ['device availability']
  if (recPath !== 'not-a-roku-app') unknowns.push('whether the team will edit app code')
  if (filesDefault) unknowns.push('bsconfig files list matches the bsc defaults: confirm it has no other entries')

  const cacheFile = process.env.BRIGHTTEST_CACHE || path.join(os.homedir(), '.brighttest', 'devices.json')
  let cacheExists = false
  try { cacheExists = fs.existsSync(cacheFile) } catch (e) { /* stat only */ }

  const report = {
    schema: SCHEMA,
    cliVersion: cliPkg.version,
    root: '.',
    host,
    project,
    brighttest: {
      installed: deps.brighttest ? (lockVer('brighttest') || deps.brighttest) : null,
      config: { present: !!config, file: projectRel(root, configFile), keys: cfgKeys, deprecatedKeys: cfgKeys.includes('instrumentExclude') ? ['instrumentExclude'] : [] },
      engines: eng,
    },
    census: cen.summary,
    secrets: sec.findings,
    risky: risk.findings,
    scans: { secrets: { ran: true, files: sec.scanned, skippedLongLines: sec.skippedLongLines }, risky: { ran: true, files: risk.scanned, skippedLongLines: risk.skippedLongLines } },
    ci,
    gitignore: gitignoreSection(sc.files, text),
    devices: { envHostSet: !!process.env.ROKU_HOST, deviceCacheExists: cacheExists },
    recommendation: { path: recPath, editPermission: 'unknown', blockers, nextSteps, unknowns },
    scan: { files: sc.files.length, skippedSensitive: sc.skippedSensitive, overCap: sc.overCap, truncated: sc.truncated, treeHash },
  }
  return { report, census: cen.full, baseRel }
}

// ---- rendering ---------------------------------------------------------------------------------------------------
function renderMarkdown(r) {
  const yn = (b) => (b ? 'yes' : 'no')
  const p = r.project, c = r.census, rec = r.recommendation
  const o = [`# brighttest assessment`, '', `Schema ${r.schema}, brighttest ${r.cliVersion}. Recommended path: **${rec.path}**.`, '']
  o.push('## Host', '', `- Node ${r.host.node} (required ${r.host.nodeRequired}, ok: ${yn(r.host.nodeOk)}), ${r.host.platform}`, '')
  o.push('## Project', '', `- Roku app: ${yn(p.isRokuApp)}; dirs: ${p.dirs.join(', ') || 'none'}; language: ${p.language}`,
    `- Files: ${p.files.brs} brs, ${p.files.bs} bs, ${p.files.xml} xml (${p.files.bytes} bytes${p.files.truncated ? ', TRUNCATED' : ''})`,
    `- Rooibos: ${yn(p.rooibos.present)}; ${p.rooibos.specFiles} spec file(s), ${p.rooibos.specsOutsideSource} outside source/; ropm: ${yn(p.ropm)}`, '')
  o.push('## bsconfig', '', p.bsconfig.present ? `- ${p.bsconfig.file}; rootDir ${p.bsconfig.rootDir || '(none)'}; plugins: ${p.bsconfig.plugins.join(', ') || 'none'}; unsupported: ${p.bsconfig.unsupported.join(', ') || 'none'}` : '- none', '')
  o.push('## Manifest', '', ...Object.entries(p.manifestKeys).map(([k, v]) => `- ${k}: ${v === null ? '(unset)' : v}`), '')
  const e = r.brighttest.engines
  o.push('## Engines', '', `- brs-node: ${e.brsNode ? `${e.brsNode.name}@${e.brsNode.version}` : 'not installed'}`, `- rooibos: ${e.rooibos ? `${e.rooibos.name}@${e.rooibos.version}` : 'not installed'}`, ...e.warnings.map((w) => `- warning: ${w}`), '')
  o.push('## Census', '', c.error ? `- error: ${c.error}` : `- ${c.components} components, ${c.scenes} scenes, ${c.tasks} tasks; setUrl ${c.setUrlCovered}/${c.setUrlSites} covered; could not instrument ${c.couldNotInstrument}; inline CDATA scenes ${c.inlineCdataScenes}; global fields ${c.globalFields}; registry sections: ${c.registrySections.join(', ') || 'none'}`, '')
  o.push('## CI', '', `- systems: ${r.ci.systems.join(', ') || 'none'}; node: ${r.ci.nodeVersions.join(', ') || 'unknown'}; runs brighttest: ${yn(r.ci.runsBrighttest)}`, '')
  o.push('## .gitignore', '', r.gitignore.present ? `- brighttest dir: ${yn(r.gitignore.brighttest)}; .env: ${yn(r.gitignore.env)}; coverage: ${yn(r.gitignore.coverage)}` : '- no .gitignore', '')
  o.push('## Devices', '', `- ROKU_HOST set: ${yn(r.devices.envHostSet)}; device cache present: ${yn(r.devices.deviceCacheExists)}`, '')
  o.push('## Recommendation', '', `- Path: ${rec.path}; edit permission: ${rec.editPermission} (ask the human)`, ...rec.blockers.map((b) => `- Blocker: ${b}`), ...rec.nextSteps.map((s, i) => `${i + 1}. ${s}`), '', `Unknowns: ${rec.unknowns.join('; ')}`, '', '')
  o.push('## Secrets', '', 'Key names and locations only; values are never read into this report.', '',
    ...(r.secrets.length ? r.secrets.map((x) => `- ${x.file}:${x.line} ${x.key === null ? '(no key)' : x.key} (${x.kind})`) : ['- none found']), '')
  o.push('## Risky patterns', '', ...(r.risky.length ? r.risky.map((x) => `- ${x.file}:${x.line} ${x.kind}`) : ['- none found']), '',
    `A clean scan is not proof: ${r.scans.secrets.files} file(s) checked for secrets, ${r.scans.risky.files} for risky patterns${r.scan.truncated ? ' (scan truncated)' : ''}; lines over ${MAX_LINE} characters are skipped (${r.scans.secrets.skippedLongLines} for secrets, ${r.scans.risky.skippedLongLines} for risky patterns).`)
  return o.join('\n') + '\n'
}

function renderHuman(r) {
  const c = r.census, rec = r.recommendation
  const L = [`brighttest assess (${r.schema})`]
  L.push(`host:      node ${r.host.node} (${r.host.nodeOk ? 'ok' : `needs ${r.host.nodeRequired}`}), ${r.host.platform}`)
  L.push(`project:   ${r.project.isRokuApp ? 'Roku app' : 'not a Roku app'}; ${r.project.files.brs} brs, ${r.project.files.bs} bs, ${r.project.files.xml} xml; specs ${r.project.rooibos.specFiles}${r.project.files.truncated ? '; scan truncated' : ''}`)
  L.push(`bsconfig:  ${r.project.bsconfig.present ? `${r.project.bsconfig.file}, unsupported: ${r.project.bsconfig.unsupported.join(', ') || 'none'}` : 'none'}`)
  L.push(`manifest:  ${r.project.manifest ? 'present' : 'missing'}`)
  const e = r.brighttest.engines
  L.push(`engines:   brs-node ${e.brsNode ? e.brsNode.version : 'not installed'}, rooibos ${e.rooibos ? e.rooibos.version : 'not installed'}`)
  L.push(`census:    ${c.error ? `error: ${c.error}` : `${c.scenes} scenes, ${c.tasks} tasks, setUrl ${c.setUrlCovered}/${c.setUrlSites} covered, ${c.couldNotInstrument} could not instrument`}`)
  L.push(`ci:        ${r.ci.systems.join(', ') || 'none'}${r.ci.nodeVersions.length ? `, node ${r.ci.nodeVersions.join('/')}` : ''}`)
  L.push(`gitignore: ${r.gitignore.present ? `brighttest ${r.gitignore.brighttest ? 'yes' : 'no'}, .env ${r.gitignore.env ? 'yes' : 'no'}, coverage ${r.gitignore.coverage ? 'yes' : 'no'}` : 'none'}`)
  L.push(`devices:   ROKU_HOST ${r.devices.envHostSet ? 'set' : 'unset'}, cache ${r.devices.deviceCacheExists ? 'present' : 'absent'}`)
  const lim = (a, f) => a.slice(0, 10).map(f).join(', ') + (a.length > 10 ? `, and ${a.length - 10} more` : '')
  L.push(`secrets:   ${r.secrets.length ? `${r.secrets.length} finding(s) (key names and lines only): ${lim(r.secrets, (x) => `${x.file}:${x.line} ${x.key === null ? x.kind : x.key}`)}` : 'none found'}`)
  L.push(`risky:     ${r.risky.length ? `${r.risky.length} finding(s): ${lim(r.risky, (x) => `${x.kind} ${x.file}:${x.line}`)}` : 'none found'}`)
  L.push(`recommend: ${rec.path}; edit permission unknown`)
  for (const b of rec.blockers) L.push(`  blocker: ${b}`)
  for (const s of rec.nextSteps) L.push(`  next: ${s}`)
  L.push(`scan:      ${r.scan.files} files, tree ${r.scan.treeHash.slice(0, 12)}${r.scan.truncated ? ' (truncated)' : ''}`)
  return L.join('\n') + '\n'
}

// ---- --out -------------------------------------------------------------------------------------------------------
// realpath of the nearest existing ancestor (the path may not exist yet), re-joined with the missing tail
function realish(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()) } catch (e) { /* walk up */ }
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(p)
    tail.push(path.basename(cur)); cur = parent
  }
}
const fold = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p)

function checkOut(outArg, root, baseRel) {
  const out = fold(realish(outArg))
  for (const d of ['source', 'components']) {
    for (const base of new Set([root, path.join(root, baseRel)])) {
      const protectedDir = fold(realish(path.join(base, d)))
      const rel = path.relative(protectedDir, out)
      const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
      if (!outside) throw new UsageError(`--out ${outArg} is inside ${d}/; choose a directory outside the app sources`)
    }
  }
  return path.resolve(outArg)
}

async function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s))
  const stderr = io.stderr || ((s) => process.stderr.write(s))
  try {
    const o = parseArgs(argv)
    if (o.help) { stdout(HELP.trimStart()); return EXIT.OK }
    const root = path.resolve(o.dir || '.')
    // `--out` is validated before anything is written; app base may differ from root (bsconfig rootDir)
    const { report, census, baseRel } = await assess(root, { config: o.config })
    const outDir = o.out ? checkOut(o.out, root, baseRel) : null
    if (outDir) {
      let existing = null
      try { existing = fs.statSync(outDir) } catch (e) { /* not there yet */ }
      if (existing && !existing.isDirectory()) throw new UsageError(`--out ${o.out} is an existing file; choose a directory`)
      try { fs.mkdirSync(outDir, { recursive: true }) } catch (e) {
        if (e.code === 'EEXIST' || e.code === 'ENOTDIR') throw new UsageError(`--out ${o.out} cannot be created: a path part is a file`)
        throw e
      }
      fs.writeFileSync(path.join(outDir, 'assess.json'), JSON.stringify(report, null, 2) + '\n')
      fs.writeFileSync(path.join(outDir, 'assess.md'), renderMarkdown(report))
      if (census) require('./instrument/census').write(census, outDir)
    }
    stdout(o.json ? JSON.stringify(report, null, 2) + '\n' : renderHuman(report))
    return EXIT.OK
  } catch (e) {
    if (e instanceof UsageError) { stderr(`[brighttest assess] ${e.message}\n`); return EXIT.USAGE }
    stderr(`[brighttest assess] internal error: ${e && e.message}\n`)
    return EXIT.INTERNAL
  }
}

module.exports = { redactPathsWith, run, assess, checkOut, gitignoreSection, UsageError, parseArgs, renderMarkdown, renderHuman, scan, HELP, SCHEMA, EXIT, GREENFIELD_MAX_COMPONENTS, LARGE_GLOBAL_FIELDS, MAX_FILES, MAX_BYTES }
