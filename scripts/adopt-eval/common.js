'use strict'
// Shared constants and prompt builder for the ADOPT-21a T1 harness. Plain Node, no dependencies.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_RUN_ROOT = path.join(os.homedir(), 'brighttest-pack-runs', 'ADOPT-21a-C112')
const FIXTURES = ['legacy-app', 'bsconfig-plugin-app']
const ARMS = ['with-skills', 'baseline']
const RUNS = [1, 2, 3]
const TASK_PROMPT = 'Assess this Roku app and tell me how to adopt brighttest. Do not change any files except a report.'
const SKILL_FILES = [
  path.join(REPO_ROOT, 'skills', '_always-on', 'safety.md'),
  path.join(REPO_ROOT, 'skills', 'assessing-a-roku-app', 'SKILL.md'),
]
// Ground truth fields compared by C2. legacy-app: examples/legacy-app/EXPECTED-CENSUS.json (read at score time).
// bsconfig-plugin-app has no census file; these two values are from `bin/cli.js assess` on the frozen fixture.
const PLUGIN_TRUTH = { brsFiles: 1, xmlFiles: 1 }
const C2_FIELDS = ['brsFiles', 'xmlFiles', 'components', 'tasks', 'urlTransferLiteral', 'createObjectDynamic', 'syncGet', 'asyncGet', 'certificateCalls']

const cellId = (fixture, arm, run) => `${fixture}/${arm}/run${run}`
const cellDir = (root, fixture, arm, run) => path.join(root, fixture, arm, `run${run}`)

function buildPrompt({ arm, appDir, reportPath, repoRoot = REPO_ROOT, skillFiles = SKILL_FILES }) {
  const lines = [TASK_PROMPT, '', `Your working directory is ${appDir} (the app). Write the report to ${reportPath}.`]
  if (arm === 'with-skills') {
    lines.push('', `The brighttest CLI is available locally: run it as \`node ${path.join(repoRoot, 'bin', 'cli.js')} assess\` (add the app path, \`--json\` for machine output).`,
      '', 'Guidance (inlined for you; follow it):')
    for (const f of skillFiles) lines.push('', `--- ${path.basename(path.dirname(f))}/${path.basename(f)} ---`, fs.readFileSync(f, 'utf8').trim())
  } else if (arm !== 'baseline') throw new Error(`unknown arm: ${arm}`)
  return lines.join('\n') + '\n'
}

module.exports = { REPO_ROOT, DEFAULT_RUN_ROOT, FIXTURES, ARMS, RUNS, TASK_PROMPT, SKILL_FILES, PLUGIN_TRUTH, C2_FIELDS, cellId, cellDir, buildPrompt }
