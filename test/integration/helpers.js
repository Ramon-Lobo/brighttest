import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
