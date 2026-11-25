import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const features = require('../lib/features')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(ROOT, 'examples', 'feature-tree-app')
const CLI = path.join(ROOT, 'bin', 'cli.js')

async function run(args) {
  let out = ''; let err = ''
  const code = await features.run(args, { stdout: (s) => { out += s }, stderr: (s) => { err += s } })
  return { code, out, err }
}
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 })

let tmp; let proj
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-features-'))
  proj = path.join(tmp, 'app')
  fs.cpSync(APP, proj, { recursive: true })
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('features command: dispatch and help', () => {
  it('prints help from the module and from the CLI', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('brighttest features graph')
    const c = cli(['features', '--help'])
    expect(c.status).toBe(0)
    expect(c.stdout).toContain('brighttest features graph')
  })
  it('lists each features subcommand once in the top-level help', () => {
    const c = cli(['--help'])
    const lines = (c.stdout + c.stderr).split('\n').filter((l) => /brighttest features/.test(l))
    expect(lines).toHaveLength(2)
    expect(lines.filter((l) => /features graph/.test(l))).toHaveLength(1)
    expect(lines.filter((l) => /features check/.test(l))).toHaveLength(1)
  })
  it('exits 2 on unknown flags, unknown or missing subcommands and extra arguments', async () => {
    for (const a of [['graph', '--nope'], ['bogus'], [], ['graph', 'a', 'b'], ['graph', '--out']]) {
      const r = await run(a)
      expect(r.code, a.join(' ')).toBe(2)
      expect(r.err).toContain('[brighttest features]')
    }
    expect(cli(['features', 'graph', '--nope']).status).toBe(2)
  })
  it('exits 2 for a missing directory', async () => {
    expect((await run(['graph', path.join(tmp, 'missing')])).code).toBe(2)
  })
})

describe('features graph: output and self-ignore', () => {
  it('writes graph.json and a self-ignoring .gitignore under .brighttest/features by default', async () => {
    fs.rmSync(path.join(proj, '.gitignore'), { force: true })
    const r = await run(['graph', proj])
    expect(r.code).toBe(0)
    const dir = path.join(proj, '.brighttest', 'features')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')).schema).toBe('brighttest-feature-graph/v1')
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n')
  })
  it('does not write a .gitignore when the project already ignores .brighttest/, and never edits the project one', async () => {
    fs.writeFileSync(path.join(proj, '.gitignore'), '.brighttest/\n')
    expect((await run(['graph', proj])).code).toBe(0)
    expect(fs.existsSync(path.join(proj, '.brighttest', 'features', '.gitignore'))).toBe(false)
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toBe('.brighttest/\n')
  })
  it('self-ignores a custom --out inside the project, not one outside', async () => {
    expect((await run(['graph', proj, '--out', path.join(proj, 'gen')])).code).toBe(0)
    expect(fs.existsSync(path.join(proj, 'gen', '.gitignore'))).toBe(true)
    const outside = path.join(tmp, 'elsewhere')
    expect((await run(['graph', proj, '--out', outside])).code).toBe(0)
    expect(fs.existsSync(path.join(outside, 'graph.json'))).toBe(true)
    expect(fs.existsSync(path.join(outside, '.gitignore'))).toBe(false)
  })
  it('refuses --out inside source/ and writes nothing', async () => {
    const r = await run(['graph', proj, '--out', path.join(proj, 'source', 'gen')])
    expect(r.code).toBe(2)
    expect(fs.existsSync(path.join(proj, 'source', 'gen'))).toBe(false)
  })
  it('--json prints the graph', async () => {
    const r = await run(['graph', proj, '--json'])
    expect(JSON.parse(r.out).schema).toBe('brighttest-feature-graph/v1')
  })
})

describe('features graph: review fixes', () => {
  it('--out . never overwrites the project .gitignore', async () => {
    fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n')
    const r = await run(['graph', proj, '--out', proj])
    expect(r.code).toBe(0)
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toBe('node_modules/\n')
  })
  it('keeps an existing .gitignore in a custom --out folder', async () => {
    fs.mkdirSync(path.join(proj, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'docs', '.gitignore'), 'keep-me\n')
    expect((await run(['graph', proj, '--out', path.join(proj, 'docs')])).code).toBe(0)
    expect(fs.readFileSync(path.join(proj, 'docs', '.gitignore'), 'utf8')).toBe('keep-me\n')
  })
  it('honours brighttest.json rootDir when refusing --out', async () => {
    const app = path.join(tmp, 'rooted')
    fs.mkdirSync(path.join(app, 'src'), { recursive: true })
    fs.cpSync(path.join(proj, 'source'), path.join(app, 'src', 'source'), { recursive: true })
    fs.cpSync(path.join(proj, 'components'), path.join(app, 'src', 'components'), { recursive: true })
    fs.copyFileSync(path.join(proj, 'manifest'), path.join(app, 'src', 'manifest'))
    fs.writeFileSync(path.join(app, 'brighttest.json'), JSON.stringify({ rootDir: 'src' }))
    const r = await run(['graph', app, '--out', path.join(app, 'src', 'source', 'gen')])
    expect(r.code).toBe(2)
    expect(fs.existsSync(path.join(app, 'src', 'source', 'gen'))).toBe(false)
  })
  it('exits 2 for a malformed brighttest.json and for a missing -c file', async () => {
    fs.writeFileSync(path.join(proj, 'brighttest.json'), '{ nope')
    expect((await run(['graph', proj])).code).toBe(2)
    fs.rmSync(path.join(proj, 'brighttest.json'))
    const r = await run(['graph', proj, '-c', 'nope.json'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('nope.json')
  })
  it('resolves -c against the current directory and uses its stagingDir', async () => {
    const sib = path.join(tmp, 'sib')
    fs.mkdirSync(sib)
    fs.writeFileSync(path.join(sib, 'alt.json'), JSON.stringify({ stagingDir: 'from-root' }))
    const prev = process.cwd()
    process.chdir(sib)
    try { expect((await run(['graph', proj, '-c', 'alt.json'])).code).toBe(0) } finally { process.chdir(prev) }
    expect(fs.existsSync(path.join(proj, 'from-root', 'features', 'graph.json'))).toBe(true)
  })
  it('names the staging directory, not --out, when it lies inside source/', async () => {
    fs.writeFileSync(path.join(proj, 'brighttest.json'), JSON.stringify({ stagingDir: 'source/stage' }))
    const r = await run(['graph', proj])
    expect(r.code).toBe(2)
    expect(r.err).toContain('staging directory')
    expect(r.err).not.toContain('--out source')
  })
})
