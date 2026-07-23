import { describe, it, expect } from 'vitest'
import { parseArgs, parseSkillsArgs, parseInitArgs } from '../bin/cli.js'

describe('parseArgs', () => {
  it('defaults to a headless run with no flags', () => {
    const o = parseArgs([])
    expect(o.device).toBe(false)
    expect(o.coverage).toBe(false)
    expect(o.crossCheck).toBeUndefined()
    expect(o.lcov).toBeNull()
    expect(o.junit).toBeNull()
  })

  it('parses boolean lane flags', () => {
    expect(parseArgs(['--device']).device).toBe(true)
    expect(parseArgs(['-d']).device).toBe(true)
    expect(parseArgs(['--coverage']).coverage).toBe(true)
    expect(parseArgs(['--cross-check']).crossCheck).toBe(true)
    expect(parseArgs(['--no-sgnode']).noSgnode).toBe(true)
    expect(parseArgs(['--skip-sgnode']).noSgnode).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('parses space- and equals-separated value flags equivalently', () => {
    expect(parseArgs(['--host', '1.2.3.4']).host).toBe('1.2.3.4')
    expect(parseArgs(['--host=1.2.3.4']).host).toBe('1.2.3.4')
    expect(parseArgs(['--password', 'pw']).password).toBe('pw')
    expect(parseArgs(['--pass', 'pw']).password).toBe('pw')
    expect(parseArgs(['--password=pw']).password).toBe('pw')
    expect(parseArgs(['--junit', 'r.xml']).junit).toBe('r.xml')
    expect(parseArgs(['--junit=r.xml']).junit).toBe('r.xml')
    expect(parseArgs(['--config', 'c.json']).config).toBe('c.json')
    expect(parseArgs(['-c', 'c.json']).config).toBe('c.json')
  })

  it('--lcov uses the default path when no value follows', () => {
    expect(parseArgs(['--lcov']).lcov).toBe('coverage/lcov.info')
    expect(parseArgs(['--lcov', '--device']).lcov).toBe('coverage/lcov.info')
    expect(parseArgs(['--lcov', '--device']).device).toBe(true)
  })

  it('--lcov takes an explicit path (space or equals form)', () => {
    expect(parseArgs(['--lcov', 'out/l.info']).lcov).toBe('out/l.info')
    expect(parseArgs(['--lcov=out/l.info']).lcov).toBe('out/l.info')
  })

  it('parses --timeout in both forms and ignores non-numbers', () => {
    expect(parseArgs(['--timeout', '600']).timeout).toBe(600)
    expect(parseArgs(['--timeout=600']).timeout).toBe(600)
    expect(parseArgs(['--timeout', 'abc']).timeout).toBeUndefined()
  })

  it('combines flags for a full device coverage run', () => {
    const o = parseArgs(['--device', '--host', '10.0.0.5', '--password', 'secret', '--lcov'])
    expect(o).toMatchObject({ device: true, host: '10.0.0.5', password: 'secret', lcov: 'coverage/lcov.info' })
  })
})

describe('parseSkillsArgs', () => {
  it('defaults to the install action', () => {
    expect(parseSkillsArgs([]).skillsAction).toBe('install')
  })

  it('recognizes each positional action', () => {
    for (const action of ['install', 'update', 'export', 'list', 'uninstall']) {
      expect(parseSkillsArgs([action]).skillsAction).toBe(action)
    }
  })

  it('parses option flags in space and equals forms', () => {
    expect(parseSkillsArgs(['--agent', 'claude']).agent).toBe('claude')
    expect(parseSkillsArgs(['--agent=claude']).agent).toBe('claude')
    expect(parseSkillsArgs(['--skill=writing-rooibos-tests']).skill).toBe('writing-rooibos-tests')
    expect(parseSkillsArgs(['-o', 'dir']).out).toBe('dir')
    expect(parseSkillsArgs(['--out=dir']).out).toBe('dir')
    expect(parseSkillsArgs(['--ref', 'main']).ref).toBe('main')
    expect(parseSkillsArgs(['--skills-dir=.agents/skills']).skillsDir).toBe('.agents/skills')
    expect(parseSkillsArgs(['--force']).force).toBe(true)
    expect(parseSkillsArgs(['-f']).force).toBe(true)
    expect(parseSkillsArgs(['-h']).help).toBe(true)
  })

  it('combines an action with flags', () => {
    const o = parseSkillsArgs(['export', '--out', 'x', '--force'])
    expect(o).toMatchObject({ skillsAction: 'export', out: 'x', force: true })
  })
})

describe('parseInitArgs', () => {
  it('defaults force and help off', () => {
    expect(parseInitArgs([])).toEqual({ force: false, help: false })
  })

  it('parses --force and --help', () => {
    expect(parseInitArgs(['--force']).force).toBe(true)
    expect(parseInitArgs(['-f']).force).toBe(true)
    expect(parseInitArgs(['--help']).help).toBe(true)
    expect(parseInitArgs(['-h']).help).toBe(true)
  })
})
