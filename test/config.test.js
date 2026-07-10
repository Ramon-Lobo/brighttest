import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, writeBsConfig, findNodeSpecs } from '../lib/config.js'

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brighttest-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Build a config as loadConfig would, but rooted at the temp dir so writeBsConfig writes there.
function cfgAt(root, overrides = {}) {
  return {
    rootDir: root,
    sourceGlobs: ['manifest', 'source/**/*', 'components/**/*'],
    testsFilePattern: '**/*.spec.bs',
    stagingDir: path.join(root, '.brighttest'),
    ...overrides,
  }
}

function readBsConfig(bsconfigPath) {
  return JSON.parse(fs.readFileSync(bsconfigPath, 'utf8'))
}

describe('loadConfig', () => {
  it('applies defaults when no config file exists', () => {
    const cfg = loadConfig(tmp)
    expect(cfg.sourceGlobs).toEqual(['manifest', 'source/**/*', 'components/**/*'])
    expect(cfg.testsFilePattern).toBe('**/*.spec.bs')
    // loadConfig uses path.resolve (does not resolve symlinks), so compare against tmp as-is.
    expect(cfg.rootDir).toBe(path.resolve(tmp))
    expect(cfg.stagingDir).toBe(path.join(tmp, '.brighttest'))
  })

  it('merges brighttest.json over the defaults', () => {
    fs.writeFileSync(
      path.join(tmp, 'brighttest.json'),
      JSON.stringify({ testsFilePattern: '**/*.test.bs', stagingDir: 'out' }),
    )
    const cfg = loadConfig(tmp)
    expect(cfg.testsFilePattern).toBe('**/*.test.bs')
    expect(cfg.stagingDir).toBe(path.join(tmp, 'out'))
    // Untouched keys keep their defaults.
    expect(cfg.sourceGlobs).toEqual(['manifest', 'source/**/*', 'components/**/*'])
  })

  it('reads an explicit config path when given', () => {
    const custom = path.join(tmp, 'custom.json')
    fs.writeFileSync(custom, JSON.stringify({ testsFilePattern: '**/*.x.bs' }))
    const cfg = loadConfig(tmp, custom)
    expect(cfg.testsFilePattern).toBe('**/*.x.bs')
  })

  it('resolves rootDir relative to cwd', () => {
    fs.mkdirSync(path.join(tmp, 'app'))
    fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify({ rootDir: 'app' }))
    const cfg = loadConfig(tmp)
    expect(cfg.rootDir).toBe(path.join(tmp, 'app'))
  })
})

describe('findNodeSpecs', () => {
  it('finds only .spec.bs files that reference @SGNode, as rootDir-relative paths', () => {
    fs.mkdirSync(path.join(tmp, 'source', 'tests'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', 'tests', 'Node.spec.bs'), '@SGNode("Widget")\nclass X\nend class')
    fs.writeFileSync(path.join(tmp, 'source', 'tests', 'Pure.spec.bs'), 'class Y\nend class')
    fs.writeFileSync(path.join(tmp, 'source', 'notaspec.bs'), '@SGNode("Z")')
    const found = findNodeSpecs(cfgAt(fs.realpathSync(tmp)))
    expect(found).toEqual([path.join('source', 'tests', 'Node.spec.bs')])
  })

  it('skips node_modules and other ignored directories', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'Dep.spec.bs'), '@SGNode("Dep")')
    expect(findNodeSpecs(cfgAt(fs.realpathSync(tmp)))).toEqual([])
  })
})

describe('writeBsConfig', () => {
  it('headless-scene lane: no coverage, excludes deviceOnly, no LCOV', () => {
    const { bsconfigPath } = writeBsConfig(cfgAt(tmp), 'headless-scene')
    const bs = readBsConfig(bsconfigPath)
    expect(bs.rooibos.isRecordingCodeCoverage).toBe(false)
    expect(bs.rooibos.failFast).toBe(false)
    expect(bs.rooibos.tags).toEqual(['!deviceOnly'])
    expect(bs.rooibos.printLcov).toBeUndefined()
    expect(bs.createPackage).toBe(true)
    expect(bs.autoImportComponentScript).toBe(true)
  })

  it('headless-coverage lane: coverage on and LCOV printed', () => {
    const bs = readBsConfig(writeBsConfig(cfgAt(tmp), 'headless-coverage').bsconfigPath)
    expect(bs.rooibos.isRecordingCodeCoverage).toBe(true)
    expect(bs.rooibos.printLcov).toBe(true)
    expect(bs.rooibos.tags).toEqual(['!deviceOnly'])
  })

  it('device lane: coverage on, keeps deviceOnly tests, LCOV only when requested', () => {
    const noLcov = readBsConfig(writeBsConfig(cfgAt(tmp), 'device').bsconfigPath)
    expect(noLcov.rooibos.isRecordingCodeCoverage).toBe(true)
    expect(noLcov.rooibos.tags).toBeUndefined()
    expect(noLcov.rooibos.printLcov).toBeUndefined()

    const withLcov = readBsConfig(writeBsConfig(cfgAt(tmp), 'device', { lcov: 'x' }).bsconfigPath)
    expect(withLcov.rooibos.printLcov).toBe(true)
  })

  it('always merges the default 1107 filter with project diagnosticFilters', () => {
    const bs = readBsConfig(writeBsConfig(cfgAt(tmp, { diagnosticFilters: [1140, 1107] }), 'headless-scene').bsconfigPath)
    expect(bs.diagnosticFilters).toEqual([1107, 1140])
  })

  it('excludeNodeSpecs negates @SGNode specs from the file list', () => {
    fs.mkdirSync(path.join(tmp, 'source'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', 'Node.spec.bs'), '@SGNode("W")')
    const bs = readBsConfig(writeBsConfig(cfgAt(fs.realpathSync(tmp)), 'headless-scene', { excludeNodeSpecs: true }).bsconfigPath)
    expect(bs.files).toContain('!' + path.join('source', 'Node.spec.bs'))
  })

  it('globalFields writes a seed file and injects it as a package entry', () => {
    const cfg = cfgAt(tmp, { globalFields: { config: {}, user: {} } })
    const bs = readBsConfig(writeBsConfig(cfg, 'headless-coverage').bsconfigPath)
    const seedEntry = bs.files.find((f) => f && typeof f === 'object' && f.dest === 'rooibos_global_seed.json')
    expect(seedEntry).toBeTruthy()
    const seed = JSON.parse(fs.readFileSync(seedEntry.src, 'utf8'))
    expect(seed).toEqual({ config: {}, user: {} })
  })

  it('does not inject a seed file when globalFields is empty', () => {
    const bs = readBsConfig(writeBsConfig(cfgAt(tmp, { globalFields: {} }), 'headless-scene').bsconfigPath)
    expect(bs.files.every((f) => typeof f === 'string')).toBe(true)
  })
})
