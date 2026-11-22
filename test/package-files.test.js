import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')

// Every .js file under bin/ and lib/ (the Studio web client sources are built into lib/studio/public).
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'public' || p === path.join(root, 'lib/studio/web')) continue
      walk(p, out)
    } else if (ent.name.endsWith('.js')) out.push(p)
  }
  return out
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(root, c)
  }
  return null
}

function requiredModules() {
  const found = new Set()
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
  for (const dir of ['bin', 'lib']) {
    for (const file of walk(path.join(root, dir))) {
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(re)) {
        const r = resolveRelative(file, m[1])
        if (r) found.add(r)
      }
    }
  }
  return [...found].sort()
}

describe('npm pack contents', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32',
  })
  const packed = new Set(JSON.parse(out)[0].files.map((f) => f.path))

  it('finds the modules it is meant to check', () => {
    const mods = requiredModules()
    expect(mods).toContain('lib/studio/perf.js')
    expect(mods.length).toBeGreaterThan(10)
  })

  it('ships every relative require under bin/ and lib/', () => {
    const missing = requiredModules().filter((m) => !packed.has(m))
    expect(missing).toEqual([])
  })

  it('ships the device lease module', () => {
    expect(packed.has('lib/device-lease.js')).toBe(true)
  })

  it('ships the instrument modules (plugin, build, verify, census, receiver)', () => {
    for (const m of ['plugin', 'build', 'verify', 'census', 'receiver']) expect(packed.has(`lib/instrument/${m}.js`), m).toBe(true)
  })

  it('does not ship repo-only folders', () => {
    const forbidden = [...packed].filter((p) =>
      /^(design|docs|experiments|examples|test|scripts|\.github|\.claude)\//.test(p) || p.startsWith('lib/studio/web/'))
    expect(forbidden).toEqual([])
  })
})
