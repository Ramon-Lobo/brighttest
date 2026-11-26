import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, writeBsConfig, findNodeSpecs, findBareDeviceOnly, parseIdleTimeout } from '../lib/config.js'

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

describe('writeBsConfig coverage key by rooibos version', () => {
  const engines = createRequire(import.meta.url)('../lib/engines.js')
  afterEach(() => { vi.restoreAllMocks() })
  for (const [version, key, other] of [
    ['5.16.4', 'isRecordingCodeCoverage', 'codeCoverage'],
    ['5.17.0', 'codeCoverage', 'isRecordingCodeCoverage'],
    ['5.17.0-bt.1', 'codeCoverage', 'isRecordingCodeCoverage'],
  ]) {
    it(`rooibos ${version} writes only ${key}`, () => {
      vi.spyOn(engines, 'engineFor').mockReturnValue({ kind: 'rooibos', version, stamp: null })
      for (const lane of ['headless-coverage', 'headless-scene']) {
        const bs = readBsConfig(writeBsConfig(cfgAt(tmp), lane).bsconfigPath)
        expect(bs.rooibos[key]).toBe(lane === 'headless-coverage')
        expect(other in bs.rooibos).toBe(false)
      }
    })
  }
  it('keeps the old key when no rooibos engine resolves', () => {
    vi.spyOn(engines, 'engineFor').mockImplementation(() => { throw new Error('missing') })
    const bs = readBsConfig(writeBsConfig(cfgAt(tmp), 'headless-coverage').bsconfigPath)
    expect(bs.rooibos.isRecordingCodeCoverage).toBe(true)
    expect('codeCoverage' in bs.rooibos).toBe(false)
  })
})

describe('writeBsConfig', () => {
  // the coverage key follows the resolved rooibos version (5.16.x: isRecordingCodeCoverage, 5.17.0 and later: codeCoverage)
  const enginesMod = createRequire(import.meta.url)('../lib/engines.js')
  const covOf = (bs) => bs.rooibos[enginesMod.supportsOption(enginesMod.engineFor('rooibos', cfgAt(tmp)), 'codeCoverage') ? 'codeCoverage' : 'isRecordingCodeCoverage']
  it('headless-scene lane: no coverage, excludes deviceOnly, no LCOV', () => {
    const { bsconfigPath } = writeBsConfig(cfgAt(tmp), 'headless-scene')
    const bs = readBsConfig(bsconfigPath)
    expect(covOf(bs)).toBe(false)
    expect(bs.rooibos.failFast).toBe(false)
    expect(bs.rooibos.tags).toEqual(['!deviceOnly'])
    expect(bs.rooibos.printLcov).toBeUndefined()
    expect(bs.createPackage).toBe(true)
    expect(bs.autoImportComponentScript).toBe(true)
  })

  it('headless-coverage lane: coverage on and LCOV printed', () => {
    const bs = readBsConfig(writeBsConfig(cfgAt(tmp), 'headless-coverage').bsconfigPath)
    expect(covOf(bs)).toBe(true)
    expect(bs.rooibos.printLcov).toBe(true)
    expect(bs.rooibos.tags).toEqual(['!deviceOnly'])
  })

  it('device lane: coverage on, keeps deviceOnly tests, LCOV only when requested', () => {
    const noLcov = readBsConfig(writeBsConfig(cfgAt(tmp), 'device').bsconfigPath)
    expect(covOf(noLcov)).toBe(true)
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

describe('deviceLease config', () => {
  let d
  beforeEach(() => { d = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-cfg-lease-')) })
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }))

  it('has defaults when brighttest.json has no deviceLease block', () => {
    expect(loadConfig(d, null).deviceLease).toEqual({
      enabled: true, wait: '30m', maxHold: '60m', sessionIdle: '10m', sessionMax: '45m',
      hygiene: 'home', studioIdle: '5m', studioYield: '60s',
    })
  })

  it('merges a partial block over the defaults; env and flags win over config', async () => {
    fs.writeFileSync(path.join(d, 'brighttest.json'), JSON.stringify({ deviceLease: { wait: '1s', hygiene: 'none' } }))
    const cfg = loadConfig(d, null)
    expect(cfg.deviceLease).toMatchObject({ wait: '1s', hygiene: 'none', maxHold: '60m' })
    const { resolveSettings } = await import('../lib/device-lease.js').then((m) => m.default || m)
    expect(resolveSettings({ cfg, env: {} })).toMatchObject({ waitMs: 1000, hygiene: 'none', maxHoldMs: 3600000, studioIdleMs: 300000, studioYieldMs: 60000 })
    expect(resolveSettings({ cfg, env: { BRIGHTTEST_LEASE_WAIT: '3s' } }).waitMs).toBe(3000)
    expect(resolveSettings({ cfg, env: { BRIGHTTEST_LEASE_WAIT: '3s' }, flags: { wait: '0' } }).waitMs).toBe(0)
    expect(resolveSettings({ cfg: { deviceLease: { enabled: false } }, env: {} }).enabled).toBe(false)
  })
})

describe('deviceIdleTimeout', () => {
  const load = (v) => { fs.writeFileSync(path.join(tmp, 'brighttest.json'), JSON.stringify(v)); return loadConfig(tmp, null) }
  it('is unset by default', () => { expect(loadConfig(tmp, null).deviceIdleTimeout).toBeUndefined() })
  it('accepts a non-negative integer, 0 included', () => {
    expect(load({ deviceIdleTimeout: 5 }).deviceIdleTimeout).toBe(5)
    expect(load({ deviceIdleTimeout: 0 }).deviceIdleTimeout).toBe(0)
  })
  it('rejects invalid values', () => {
    for (const v of ['abc', -1, 1.5, true]) expect(() => load({ deviceIdleTimeout: v })).toThrow(/deviceIdleTimeout/)
  })
  it('parseIdleTimeout: numeric strings ok, others throw', () => {
    expect(parseIdleTimeout('5', '--idle-timeout')).toBe(5)
    expect(parseIdleTimeout('0', '--idle-timeout')).toBe(0)
    for (const v of ['x', '', '-2', '1.5', undefined]) expect(() => parseIdleTimeout(v, '--idle-timeout')).toThrow(/--idle-timeout/)
  })
})

describe('writeBsConfig plain source/main.brs auto-exclude (headless-scene only)', () => {
  const putMain = (name) => {
    fs.mkdirSync(path.join(tmp, 'source'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'source', name), 'sub Main()\nend sub\n')
  }
  let log
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { log.mockRestore() })
  const excludeLogs = () => log.mock.calls.filter((c) => String(c[0]).includes('excluded source/'))
  const filesFor = (lane, globs, extra) => readBsConfig(writeBsConfig(cfgAt(tmp, globs ? { sourceGlobs: globs } : {}), lane, extra).bsconfigPath).files
  const DEFAULT = ['manifest', 'source/**/*', 'components/**/*']

  it('appends !source/main.brs and logs once for a plain main.brs', () => {
    putMain('main.brs')
    expect(filesFor('headless-scene').filter((f) => f === '!source/main.brs')).toHaveLength(1)
    expect(excludeLogs()).toHaveLength(1)
  })

  it('logs once per run even when writeBsConfig is called twice', () => {
    putMain('main.brs')
    filesFor('headless-scene'); filesFor('headless-scene')
    expect(excludeLogs()).toHaveLength(1)
  })

  it.each(['headless-coverage', 'headless', 'device'])('does not exclude on the %s lane', (lane) => {
    putMain('main.brs')
    expect(filesFor(lane)).toEqual(DEFAULT)
    expect(excludeLogs()).toHaveLength(0)
  })

  it('does nothing when the user already excludes it (exact)', () => {
    putMain('main.brs')
    const globs = ['manifest', 'source/**/*', '!source/main.brs']
    expect(filesFor('headless-scene', globs)).toEqual(globs)
    expect(excludeLogs()).toHaveLength(0)
  })

  it('respects a user exclude written as a glob, with ./ and backslashes', () => {
    putMain('main.brs')
    for (const g of ['!source/main.*', '!./source/main.brs', '!source\\main.brs', '!**/main.brs']) {
      const globs = ['manifest', 'source/**/*', g]
      expect(filesFor('headless-scene', globs)).toEqual(globs)
    }
    expect(excludeLogs()).toHaveLength(0)
  })

  it('leaves a .bs Main untouched', () => {
    putMain('main.bs')
    expect(filesFor('headless-scene')).toEqual(DEFAULT)
    expect(excludeLogs()).toHaveLength(0)
  })

  it('does nothing when the globs do not compile main.brs', () => {
    putMain('main.brs')
    const globs = ['manifest', 'components/**/*']
    expect(filesFor('headless-scene', globs)).toEqual(globs)
    expect(excludeLogs()).toHaveLength(0)
  })

  it('excludes when a **/* glob compiles main.brs', () => {
    putMain('main.brs')
    expect(filesFor('headless-scene', ['manifest', '**/*'])).toEqual(['manifest', '**/*', '!source/main.brs'])
  })

  it('matches **/ across zero or more directories', () => {
    putMain('main.brs')
    expect(filesFor('headless-scene', ['manifest', '**/main.brs'])).toContain('!source/main.brs')
  })

  it('does not let * match a slash', () => {
    putMain('main.brs')
    expect(filesFor('headless-scene', ['manifest', 'source/*'])).toContain('!source/main.brs')
    expect(filesFor('headless-scene', ['manifest', '*.brs'])).not.toContain('!source/main.brs')
    expect(filesFor('headless-scene', ['manifest', 'source/**/*', '!*.brs'])).toContain('!source/main.brs')
  })

  it('uses the real casing of Main.brs and skips the duplicate when that is already excluded', () => {
    putMain('Main.brs')
    expect(filesFor('headless-scene')).toEqual([...DEFAULT, '!source/Main.brs'])
    const globs = ['manifest', 'source/**/*', '!source/Main.brs']
    expect(filesFor('headless-scene', globs)).toEqual(globs)
  })
})

describe('stock-engine warnings (ROO-04 globalFields, ROO-05 bare @deviceOnly)', () => {
  const engines = createRequire(import.meta.url)('../lib/engines.js')
  let warn
  // A fake rooibos engine dir: stamped with the given patch ids, or unstamped (stock) when patches is null.
  function fakeRooibos(patches) {
    const dir = path.join(tmp, 'fake-engines', patches ? 'patched' : 'stock')
    const pkgDir = path.join(dir, 'node_modules', patches ? '@ramonlobo/rooibos-roku' : 'rooibos-roku')
    fs.mkdirSync(pkgDir, { recursive: true })
    const pkg = { name: patches ? '@ramonlobo/rooibos-roku' : 'rooibos-roku', version: patches ? '5.17.0-bt.1' : '5.17.0', bin: 'bin.js' }
    if (patches) pkg.brighttest = { patches: Object.fromEntries(patches.map((id) => [id, true])) }
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg))
    return dir
  }
  function useEngine(dir) {
    const orig = engines.engineFor
    vi.spyOn(engines, 'engineFor').mockImplementation((kind, cfg, opts) => orig(kind, cfg, { ...opts, paths: [dir] }))
  }
  function spec(rel, text) {
    const f = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, text)
  }
  const warned = (re) => warn.mock.calls.map((c) => c.join(' ')).filter((l) => re.test(l))
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  describe('ROO-04', () => {
    const cfgG = () => cfgAt(tmp, { globalFields: { config: {} } })
    it('warns once on stock for each lane, device included', () => {
      useEngine(fakeRooibos(null))
      for (const lane of ['headless-scene', 'headless-coverage', 'device']) {
        warn.mockClear()
        writeBsConfig(cfgG(), lane)
        expect(warned(/ROO-04/)).toHaveLength(1)
      }
      expect(warned(/ROO-04/)[0]).toContain('rooibos-roku@5.17.0 (stock)')
    })
    it('is silent on a ROO-04 stamp', () => {
      useEngine(fakeRooibos(['ROO-04']))
      writeBsConfig(cfgG(), 'headless-scene')
      expect(warned(/ROO-04/)).toHaveLength(0)
    })
    it('is silent without globalFields', () => {
      useEngine(fakeRooibos(null))
      writeBsConfig(cfgAt(tmp), 'headless-scene')
      writeBsConfig(cfgAt(tmp, { globalFields: {} }), 'headless-scene')
      expect(warned(/ROO-04/)).toHaveLength(0)
    })
    it('is silent when no engine resolves', () => {
      vi.spyOn(engines, 'engineFor').mockImplementation(() => { throw new Error('missing') })
      writeBsConfig(cfgG(), 'headless-scene')
      expect(warned(/ROO-04/)).toHaveLength(0)
    })
  })

  describe('ROO-05', () => {
    beforeEach(() => {
      spec('source/A.spec.bs', 'namespace t\n  @suite\n  @deviceOnly\n  class A\n  end class\nend namespace\n')
      spec('source/B.spec.bs', '@suite\n@tags("deviceOnly")\nclass B\nend class\n')
    })
    it('findBareDeviceOnly returns rel:line for bare annotations only', () => {
      expect(findBareDeviceOnly(cfgAt(fs.realpathSync(tmp)))).toEqual([`${path.join('source', 'A.spec.bs')}:3`])
    })
    it('warns on stock for headless lanes, naming file:line', () => {
      useEngine(fakeRooibos(null))
      writeBsConfig(cfgAt(tmp), 'headless-scene')
      const w = warned(/ROO-05/)
      expect(w).toHaveLength(1)
      expect(w[0]).toContain(`${path.join('source', 'A.spec.bs')}:3`)
    })
    it('does not warn on the device lane', () => {
      useEngine(fakeRooibos(null))
      writeBsConfig(cfgAt(tmp), 'device')
      expect(warned(/ROO-05/)).toHaveLength(0)
    })
    it('does not warn when the engine has ROO-05', () => {
      useEngine(fakeRooibos(['ROO-05']))
      writeBsConfig(cfgAt(tmp), 'headless-scene')
      expect(warned(/ROO-05/)).toHaveLength(0)
    })
  })
})
