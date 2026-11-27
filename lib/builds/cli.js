'use strict'
// `brighttest builds ...` (studio-builds design section 8): list, show, add, install, pin, unpin, edit, rm, prune.
//
//   run(argv, deps?) -> Promise<exitCode>      argv = the arguments after "builds"
//   deps (tests): { cwd, env, out(line), err(line), loadConfig, sideload, resolvePassword, store, ...sideload seams }
//
// Exit codes: 0 ok; 1 operation failed (install failed, rm of a pinned build); 2 usage, missing host, unknown id,
// ambiguous prefix; 5 package rejected (invalid, unsafe, no manifest, too large, blob missing or corrupt); 75 lease
// busy; 77 build store not usable (locked, write failed) or lease lost; 78 configuration error (store path, lease dir).
// `install` takes the device lease through sideload(); the host comes from --host or ROKU_HOST (process env or the
// project .env), never from the device cache. The dev password is never printed.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ACTIONS = ['list', 'show', 'add', 'install', 'pin', 'unpin', 'edit', 'rm', 'prune']
const VALUE_FLAGS = ['host', 'wait', 'max', 'expect', 'as', 'purpose', 'label', 'note', 'notes', 'tag', 'untag', 'tags', 'builds-dir', 'kind', 'config']
const BOOL_FLAGS = ['json', 'latest', 'all', 'pinned', 'dry-run', 'force', 'help']
const REPEAT = ['tag', 'untag']

const HELP = `brighttest builds — the history of built and sideloaded packages (the build store)

Usage:
  brighttest builds list [--json] [--all] [--kind store|instrumented] [--tag <t>] [--pinned]
  brighttest builds show <id|prefix> [--json]
  brighttest builds add <zip> [--label <text>] [--note <text>] [--tag <t>]... [--json]
  brighttest builds install <id|prefix|zip> | --latest [--host <ip>] [--wait <dur>] [--as <agent>] [--purpose <text>] [--json]
  brighttest builds pin|unpin <id|prefix>
  brighttest builds edit <id|prefix> [--label <text>] [--note <text>] [--tag <t>]... [--untag <t>]...
  brighttest builds rm <id|prefix> [--force]
  brighttest builds prune [--dry-run] [--json]

  An id is "b" + 12 hex; any unique prefix of 4+ characters works. --builds-dir <dir> (absolute) overrides the store
  for one call; --config <path> picks the brighttest.json.
  install: --latest is the newest build made by "instrument build" (the re-sideload command for multi-agent work);
  a zip path is added to the store first. The host comes only from --host or ROKU_HOST (shell or project .env), never
  the device cache; the dev password from ROKU_PASSWORD. The install takes the device lease.
Exit codes: 0 ok; 1 failed (install, pinned rm); 2 usage, no host, unknown or ambiguous id; 5 package rejected
  (invalid, unsafe, no manifest, blob missing or corrupt); 75 lease busy; 77 store unusable or lease lost; 78 config error.`

const CODE_EXIT = {
  BUILD_NOT_FOUND: 2, BUILD_AMBIGUOUS: 2, BUILD_INVALID_FIELD: 2,
  BUILD_INVALID_ZIP: 5, BUILD_UNSAFE_ZIP: 5, BUILD_NO_MANIFEST: 5, BUILD_TOO_LARGE: 5, BUILD_BLOB_MISSING: 5, BUILD_BLOB_CORRUPT: 5,
  BUILD_PINNED: 1, STORE_LOCKED: 77, STORE_WRITE_FAILED: 77,
}

function parse(argv) {
  const o = { action: null, args: [], unknown: [] }
  for (const f of REPEAT) o[f] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { if (!o.action) o.action = a; else o.args.push(a); continue }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (BOOL_FLAGS.includes(name)) { o[name] = true; continue }
    if (VALUE_FLAGS.includes(name)) {
      let v = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (v === undefined) { o.unknown.push(`${a} (needs a value)`); continue }
      if (REPEAT.includes(name)) o[name].push(v); else o[name] = v
      continue
    }
    o.unknown.push(a)
  }
  return o
}

const tilde = (p) => { const h = os.homedir(); return p.startsWith(h) ? '~' + p.slice(h.length) : p }
const iso = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z')
function age(at, now) {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 129600) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function line(b, now) {
  const li = b.lastInstall ? `${age(b.lastInstall.at, now)} ago ${b.lastInstall.ok ? 'ok' : 'FAILED'}` : 'never installed'
  const ver = b.manifest && b.manifest.version ? b.manifest.version : '-'
  return `${b.id}  ${b.pinned ? 'pin' : '   '}  ${b.label}  ${ver}  ${b.kind}  ${mb(b.size)}  ${li}${b.blob !== 'ok' ? `  [blob ${b.blob}]` : ''}`
}

// Newest build made by "instrument build": the newest `build` source across records.
function latestBuilt(store) {
  let best = null
  let bestAt = ''
  for (const b of store.list().builds) {
    for (const s of b.sources) if (s.kind === 'build' && s.at >= bestAt) { best = b; bestAt = s.at }
  }
  return best
}

async function run(argv, deps = {}) {
  const cwd = deps.cwd || process.cwd()
  const env = deps.env || process.env
  const out = deps.out || ((l) => process.stdout.write(l + '\n'))
  const err = deps.err || ((l) => process.stderr.write(l + '\n'))
  const o = parse(argv)
  const say = (m) => err(`[brighttest builds] ${m}`)
  if (o.help || !o.action) { out(HELP); return o.help ? 0 : 2 }
  if (!ACTIONS.includes(o.action)) { say(`unknown action "${o.action}"; available: ${ACTIONS.join(', ')} (see: builds --help)`); return 2 }
  if (o.unknown.length) { say(`unknown option(s): ${o.unknown.join(' ')}`); return 2 }
  const json = (v) => out(JSON.stringify(v, null, 2))
  const fromError = (e) => {
    const code = e && e.code
    say(String(e && e.message))
    return Object.prototype.hasOwnProperty.call(CODE_EXIT, code) ? CODE_EXIT[code] : 1
  }
  const need = (n, what) => { if (o.args.length < n) { say(`${o.action} needs ${what}`); return false } return true }

  // config + store
  let cfg, store
  try {
    cfg = (deps.loadConfig || require('../config').loadConfig)(cwd, o.config || null)
  } catch (e) { say(`configuration error: ${e.message}`); return 78 }
  try {
    const senv = o['builds-dir'] ? { ...env, BRIGHTTEST_BUILDS_DIR: o['builds-dir'] } : env
    store = deps.store || require('./store').openStore({ cfg, rootDir: cfg.rootDir, env: senv })
  } catch (e) { say(`store: ${e.message}`); return 78 }

  try {
    switch (o.action) {
      case 'list': {
        const { builds: all, warnings } = store.list()
        const builds = all.filter((b) => (!o.kind || b.kind === o.kind) && (!o.tag.length || o.tag.every((t) => b.tags.includes(t))) && (!o.pinned || b.pinned))
        if (o.json) { json({ store: { scope: store.scope, count: all.length }, builds, warnings }); return 0 }
        out(`store: ${store.scope} (${tilde(store.dir)}), ${all.length} build(s)`)
        const now = Date.now()
        for (const b of builds) out(line(b, now))
        if (!builds.length) out('no builds')
        if (o.all) for (const w of warnings) out(`warning: ${w}`)
        else if (warnings.length) say(`${warnings.length} warning(s); use --all to show them`)
        return 0
      }
      case 'show': {
        if (!need(1, '<id|prefix>')) return 2
        const b = store.get(o.args[0])
        if (!b) { say(`no build "${o.args[0]}"`); return 2 }
        if (o.json) { json(b); return 0 }
        out(line(b, Date.now()))
        out(`  sha256 ${b.sha256}`)
        out(`  file ${b.filename}${b.notes ? `\n  notes ${b.notes}` : ''}${b.tags.length ? `\n  tags ${b.tags.join(', ')}` : ''}`)
        out(`  installs ${b.installCount} (${b.failCount} failed), sources ${b.sources.map((s) => s.kind).join(', ')}`)
        return 0
      }
      case 'add': {
        if (!need(1, '<zip>')) return 2
        const file = path.resolve(cwd, o.args[0])
        let buf
        try { buf = fs.readFileSync(file) } catch (e) { say(`cannot read ${o.args[0]} (${e.code || 'error'})`); return 2 }
        const r = await store.add(buf, { filename: path.basename(file), source: { kind: 'cli-add' }, project: path.basename(cfg.rootDir || '') })
        let rec = r.record
        const patch = metaPatch(o, rec)
        if (patch) rec = await store.edit(rec.id, patch)
        if (o.json) json({ build: rec, created: r.created, deduped: r.deduped, warnings: r.warnings })
        else {
          out(`${r.created ? 'added' : 'already in the store'}: ${rec.id}  ${rec.label}`)
          for (const w of r.warnings) say(`warning: ${w}`)
        }
        return 0
      }
      case 'pin':
      case 'unpin': {
        if (!need(1, '<id|prefix>')) return 2
        const rec = await store.edit(o.args[0], { pinned: o.action === 'pin' })
        out(`${o.action === 'pin' ? 'pinned' : 'unpinned'}: ${rec.id}`)
        return 0
      }
      case 'edit': {
        if (!need(1, '<id|prefix>')) return 2
        const cur = store.get(o.args[0])
        if (!cur) { say(`no build "${o.args[0]}"`); return 2 }
        const patch = metaPatch(o, cur)
        if (!patch) { say('edit needs --label, --note, --tag or --untag'); return 2 }
        const rec = await store.edit(cur.id, patch)
        out(`edited: ${rec.id}`)
        return 0
      }
      case 'rm': {
        if (!need(1, '<id|prefix>')) return 2
        const r = await store.remove(o.args[0], { force: !!o.force })
        out(r.removed ? `removed: ${r.id}` : 'already removed')
        return 0
      }
      case 'prune': {
        const r = await store.prune({ dryRun: !!o['dry-run'] })
        if (o.json) { json({ dryRun: !!o['dry-run'], removed: r.removed, swept: r.swept, warnings: r.warnings }); return 0 }
        out(`${o['dry-run'] ? 'would remove' : 'removed'} ${r.removed.length} build(s)${r.removed.length ? ': ' + r.removed.join(', ') : ''}; swept ${r.swept.length} file(s)`)
        for (const w of r.warnings) say(`warning: ${w}`)
        return 0
      }
      case 'install':
        return await install(o, { cfg, store, env, cwd, deps, say, json, out, err })
    }
  } catch (e) { return fromError(e) }
  return 2
}

// --tag adds, --untag removes; returns null when no metadata flag was given.
function metaPatch(o, cur) {
  const p = {}
  if (o.label !== undefined) p.label = o.label
  const note = o.note !== undefined ? o.note : o.notes
  if (note !== undefined) p.notes = note
  const add = o.tag.concat(o.tags ? String(o.tags).split(',').filter(Boolean) : [])
  if (add.length || o.untag.length) p.tags = [...new Set((cur.tags || []).concat(add))].filter((t) => !o.untag.includes(t))
  return Object.keys(p).length ? p : null
}

async function install(o, { cfg, store, env, cwd, deps, say, json, out, err }) {
  const devices = require('../devices')
  // host: --host, else ROKU_HOST (process env, then the project .env); never the device cache
  const { splitHost } = require('../device-command')
  const inline = splitHost(o.host || '')
  const host = inline.host || env.ROKU_HOST || devices.loadDotEnv(cfg.rootDir || cwd).ROKU_HOST || null
  if (!host) { say('install needs a device: pass --host <ip> or set ROKU_HOST (in the shell or the project .env); the device cache is never used'); return 2 }
  if (!o.latest && !o.args.length) { say('install needs <id|prefix|zip> or --latest'); return 2 }

  // pick the build (a zip path is added to the store first)
  let rec
  if (o.latest) {
    rec = latestBuilt(store)
    if (!rec) { say('no recorded build to install (--latest needs a build made by "brighttest instrument build")'); return 2 }
  } else {
    const arg = o.args[0]
    const file = path.resolve(cwd, arg)
    let isFile = false
    try { isFile = fs.statSync(file).isFile() } catch (_) { /* not a path */ }
    if (isFile) {
      const r = await store.add(fs.readFileSync(file), { filename: path.basename(file), source: { kind: 'cli-add' }, project: path.basename(cfg.rootDir || '') })
      rec = r.record
    } else {
      rec = store.get(arg)
      if (!rec) { say(`no build or file "${arg}"`); return 2 }
    }
  }

  const password = (deps.resolvePassword || ((h) => devices.resolveDevice({ host: h, cwd: cfg.rootDir || cwd }).password))(host)
  if (!password) { say('install needs the dev password in ROKU_PASSWORD'); return 2 }
  store.blob(rec.id) // refuses a missing or corrupt blob (exit 5) before the lease is taken
  const zip = path.join(store.dir, 'blobs', rec.sha256 + '.zip')

  const log = deps.log || ((l) => err(l))
  const code = await (deps.sideload || require('../instrument/sideload').sideload)(cfg, {
    zip, host, password, record: { store, id: rec.id, via: 'cli' }, cwd: cfg.rootDir || cwd,
    wait: o.wait, max: o.max, expect: o.expect, as: o.as, purpose: o.purpose || 'builds install', via: 'cli',
  }, { log, fetch: deps.fetch, tcpProbe: deps.tcpProbe, sleep: deps.sleep, activeTries: deps.activeTries, acquireForLane: deps.acquireForLane, installedDir: deps.installedDir, collectFacts: deps.collectFacts })
  if (o.json) {
    let last = null
    try { const cur = store.get(rec.id); last = cur && cur.installs.length ? cur.installs[cur.installs.length - 1] : null } catch (_) { /* best-effort */ }
    json({ id: rec.id, label: rec.label, ok: code === 0, exitCode: code, recorded: !!last, install: last })
  }
  return code
}

module.exports = { run, parse, HELP, ACTIONS, latestBuilt }
