'use strict'
// FR-BUILD-FROM: `instrument build --from <dir|zip>` takes an already-built package tree (an app with its own build step
// runs it first). resolveFrom() validates the input and returns a directory to use as rootDir; it never writes into the
// input. A zip is unpacked into a fresh temp directory after path and size checks; cleanup() removes that directory.
//
//   resolveFrom(input, { maxEntries, maxBytes, maxEntryBytes }) -> Promise<{ dir, cleanup(), kind: 'dir'|'zip' }>
//   Rejects with an Error (code BT_FROM_*) whose message is the user-facing text.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JSZip = require('jszip')

const LIMITS = Object.freeze({ maxEntries: 20000, maxBytes: 512 * 1024 * 1024, maxEntryBytes: 256 * 1024 * 1024 })
const fail = (code, msg) => Object.assign(new Error(msg), { code })

function checkLayout(dir, label) {
  if (!fs.existsSync(path.join(dir, 'manifest'))) {
    throw fail('BT_FROM_NO_MANIFEST', `--from ${label}: no manifest at the top level (a Roku package has manifest plus source/ or components/ at its root; if it sits in a subfolder, point --from at that folder)`)
  }
  const has = (d) => { try { return fs.statSync(path.join(dir, d)).isDirectory() } catch (e) { return false } }
  if (!has('source') && !has('components')) {
    throw fail('BT_FROM_NO_SOURCE', `--from ${label}: no source/ or components/ folder next to the manifest`)
  }
}

// Returns the safe relative posix path for a zip entry name, or throws.
function safeEntry(name) {
  const n = String(name).replace(/\\/g, '/')
  if (n.includes('\0')) throw fail('BT_FROM_UNSAFE_PATH', `--from: unsafe entry name in zip (NUL byte)`)
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) throw fail('BT_FROM_UNSAFE_PATH', `--from: zip entry has an absolute path: ${JSON.stringify(name)}`)
  if (n.split('/').includes('..')) throw fail('BT_FROM_UNSAFE_PATH', `--from: zip entry escapes the package with "..": ${JSON.stringify(name)}`)
  return n
}

async function resolveFrom(input, limits = {}) {
  const lim = { ...LIMITS, ...limits }
  if (typeof input !== 'string' || !input) throw fail('BT_FROM_USAGE', '--from needs a directory or a .zip path')
  const abs = path.resolve(input)
  let st
  try { st = fs.statSync(abs) } catch (e) { throw fail('BT_FROM_MISSING', `--from ${input}: no such file or directory`) }
  if (st.isDirectory()) {
    checkLayout(abs, input)
    return { dir: abs, kind: 'dir', cleanup() {} }
  }
  if (!st.isFile() || !/\.zip$/i.test(abs)) throw fail('BT_FROM_KIND', `--from ${input}: expected a directory or a .zip file`)
  if (st.size > lim.maxBytes) throw fail('BT_FROM_TOO_BIG', `--from ${input}: zip is larger than the ${lim.maxBytes}-byte cap`)
  let zip
  try { zip = await JSZip.loadAsync(fs.readFileSync(abs)) } catch (e) { throw fail('BT_FROM_CORRUPT', `--from ${input}: not a readable zip (${e.message})`) }
  const entries = Object.values(zip.files)
  if (entries.length > lim.maxEntries) throw fail('BT_FROM_TOO_BIG', `--from ${input}: zip has more than ${lim.maxEntries} entries`)
  // check every name before anything is written
  const plan = entries.map((e) => ({ e, rel: safeEntry(e.name) }))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-from-'))
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* best effort */ } }
  try {
    let total = 0
    for (const { e, rel } of plan) {
      if (e.dir || rel.endsWith('/')) continue
      const buf = await e.async('nodebuffer')
      total += buf.length
      if (buf.length > lim.maxEntryBytes || total > lim.maxBytes) throw fail('BT_FROM_TOO_BIG', `--from ${input}: unpacked size is over the ${lim.maxBytes}-byte cap`)
      const dest = path.resolve(dir, rel)
      if (dest !== dir && !dest.startsWith(dir + path.sep)) throw fail('BT_FROM_UNSAFE_PATH', `--from: zip entry escapes the package: ${JSON.stringify(e.name)}`)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
    }
    checkLayout(dir, input)
  } catch (e) { cleanup(); throw e }
  return { dir, kind: 'zip', cleanup }
}

module.exports = { resolveFrom, LIMITS }
