import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Integration harness: run the real brighttest CLI against a throwaway copy of a fixture project.
// bsc/brs-node resolve from THIS repo's node_modules (the CLI's __dirname is here), so fixtures need
// no node_modules of their own.
const dir = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(dir, '..', '..')
const CLI = path.join(REPO, 'bin', 'cli.js')
const FIXTURES = path.join(dir, '..', 'fixtures')

const tmpDirs = []

function register(d) {
  tmpDirs.push(d)
  return d
}

// Copy a fixture project to a fresh temp dir and return its path.
export function makeProject(fixture = 'sample-project') {
  const d = register(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-int-')))
  fs.cpSync(path.join(FIXTURES, fixture), d, { recursive: true })
  return d
}

// A fresh empty temp dir (for `init` / `skills`, which start from nothing).
export function makeEmptyDir() {
  return register(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-int-')))
}

// Run `brighttest <args>` with cwd = dir. Returns exit status, stdout, stderr, and their concatenation.
export function runCli(dir, args = []) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  if (res.error) throw res.error
  const stdout = res.stdout || ''
  const stderr = res.stderr || ''
  return { status: res.status, stdout, stderr, output: stdout + stderr }
}

// Convenience readers for files a run wrote into the project dir.
export function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8')
}
export function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel))
}

// Remove every temp dir created so far. Call from afterAll.
export function cleanupTemp() {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// True when the engines these tests run against (BRIGHTTEST_ENGINES, else auto) are the patched @ramonlobo builds.
// Resolved the way the CLI does it (lib/engines.js), so a stock run (BRIGHTTEST_ENGINES=stock, or no patched package
// installed) skips the tests that assert patched-only behavior instead of failing them.
export function enginesArePatched() {
  const engines = createRequire(import.meta.url)('../../lib/engines.js')
  return ['brsNode', 'rooibos'].every((kind) => {
    try { return engines.resolveEngine(kind, engines.engineMode(kind).mode).flavor === 'patched' } catch { return false }
  })
}

// Test title for a patched-only test: unchanged on patched engines, tagged with the skip reason on stock so the
// reason shows in the reporter next to the skipped test. Use with it.skipIf(!enginesArePatched()).
export function patchedOnly(title) {
  return enginesArePatched() ? title : `${title} [skipped: needs the patched engines]`
}
