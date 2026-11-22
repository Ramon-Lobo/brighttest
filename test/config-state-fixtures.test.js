import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { writeBsConfig } = require('../lib/config.js')
const here = path.dirname(fileURLToPath(import.meta.url))

// STA-S-T12: BTState_ specs stage the helper and ship fixtures/state/** through {src,dest}.
let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const cfg = () => ({ rootDir: tmp, sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: path.join(tmp, '.brighttest') })
const files = (lane) => JSON.parse(fs.readFileSync(writeBsConfig(cfg(), lane).bsconfigPath, 'utf8')).files
const objs = (fs_) => fs_.filter((f) => f && typeof f === 'object')

describe('writeBsConfig with BTState_ specs', () => {
  beforeEach(() => { put('manifest', 'title=x\n'); put('fixtures/state/a.json', '{}') })

  it.each(['headless-scene', 'headless-coverage'])('stages the helper and ships fixtures/state on %s', (lane) => {
    put('source/tests/A.spec.bs', 'BTState_seedGlobals(snap.layers.global)\n')
    const o = objs(files(lane))
    const helper = o.find((f) => f.dest === 'source/bt/BTState.brs')
    expect(helper.src).toBe(path.join(here, '..', 'lib', 'spec-api', 'BTState.brs'))
    expect(fs.existsSync(helper.src)).toBe(true)
    expect(o.find((f) => f.dest === 'fixtures/state')).toEqual({ src: 'fixtures/state/**/*', dest: 'fixtures/state' })
  })

  it('ships a literal relative pair even when the project root has "(x86)" in it', () => {
    const root = path.join(tmp, 'Program Files (x86)', 'app')
    fs.mkdirSync(path.join(root, 'fixtures', 'state'), { recursive: true })
    fs.mkdirSync(path.join(root, 'source', 'tests'), { recursive: true })
    fs.writeFileSync(path.join(root, 'manifest'), 'title=x\n')
    fs.writeFileSync(path.join(root, 'source', 'tests', 'A.spec.bs'), 'x = btstate_load("pkg:/fixtures/state/a.json")\n')
    const c = { rootDir: root, sourceGlobs: ['manifest', 'source/**/*'], testsFilePattern: '**/*.spec.bs', stagingDir: path.join(root, '.brighttest') }
    const o = objs(JSON.parse(fs.readFileSync(writeBsConfig(c, 'headless-scene').bsconfigPath, 'utf8')).files)
    expect(o.find((f) => f.dest === 'fixtures/state')).toEqual({ src: 'fixtures/state/**/*', dest: 'fixtures/state' })
    expect(o.some((f) => f.dest === 'source/bt/BTState.brs')).toBe(true)
  })

  it('adds no fixtures line when the project has no fixtures/state', () => {
    fs.rmSync(path.join(tmp, 'fixtures'), { recursive: true })
    put('source/tests/A.spec.bs', 'x = BTState_load("pkg:/fixtures/state/a.json")\n')
    const o = objs(files('headless-scene'))
    expect(o.some((f) => f.dest === 'source/bt/BTState.brs')).toBe(true)
    expect(o.some((f) => f.dest === 'fixtures/state')).toBe(false)
  })

  it('changes nothing without a BTState_load/seedGlobals spec (BTState_publish alone does not count)', () => {
    put('source/tests/A.spec.bs', 'BTState_publish(m.top, {})\n')
    expect(objs(files('headless-scene'))).toEqual([])
  })
})
