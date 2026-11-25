'use strict'
// Shared constants and prompt builder for the T1 harness. Plain Node, no dependencies.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_RUN_ROOT = path.join(os.homedir(), 'adopt-eval-runs', 't1')
const FIXTURES = ['legacy-app', 'bsconfig-plugin-app']
const ARMS = ['with-skills', 'baseline']
const RUNS = [1, 2, 3]
const TASK_PROMPT = 'Assess this Roku app and tell me how to adopt brighttest. Do not change any files except a report.'
// Order matters to the tests: [0] safety.md, [1] SKILL.md, then every references/* file (sorted).
const skillFiles_ = (repoRoot = REPO_ROOT) => {
  const dir = path.join(repoRoot, 'skills', 'assessing-a-roku-app')
  const refs = fs.existsSync(path.join(dir, 'references')) ? fs.readdirSync(path.join(dir, 'references')).sort().map((f) => path.join(dir, 'references', f)).filter((f) => fs.statSync(f).isFile()) : []
  return [path.join(repoRoot, 'skills', '_always-on', 'safety.md'), path.join(dir, 'SKILL.md'), ...refs]
}
const SKILL_FILES = skillFiles_()
// Baseline isolation text. The harness cannot switch off tools, so this is a rule in the prompt plus a post-run check (score.js).
const BASELINE_RULES = 'Use only file reads and standard shell commands inside your working directory. Do not run any tool or CLI named in the task, do not read README files, and do not read or list anything outside your working directory.'
const REPLY_RULE = 'Also include the complete report in your final reply (if you cannot write the report file, the final reply is the report).'
// Ground truth fields compared by C2. legacy-app: examples/legacy-app/EXPECTED-CENSUS.json (read at score time).
// bsconfig-plugin-app has no census file; these two values are from `bin/cli.js assess` on the frozen fixture.
const PLUGIN_TRUTH = { brsFiles: 1, xmlFiles: 1 }
const C2_FIELDS = ['brsFiles', 'xmlFiles', 'components', 'tasks', 'urlTransferLiteral', 'createObjectDynamic', 'syncGet', 'asyncGet', 'certificateCalls']

const cellId = (fixture, arm, run) => `${fixture}/${arm}/run${run}`
// Each arm has its own root so a baseline agent walking up from its cell cannot reach the with-skills prompts or reports.
const armRoot = (root, arm) => (arm === 'baseline' ? `${root.replace(/[\\/]+$/, '')}-baseline` : root)
const cellDir = (root, fixture, arm, run) => path.join(armRoot(root, arm), fixture, `run${run}`)

function buildPrompt({ arm, appDir, reportPath, repoRoot = REPO_ROOT, skillFiles = skillFiles_(repoRoot) }) {
  const lines = [TASK_PROMPT, '', `Your working directory is ${appDir} (the app). Write the report to ${reportPath}. ${REPLY_RULE}`]
  if (arm === 'with-skills') {
    lines.push('', `The brighttest CLI is available locally: run it as \`node ${path.join(repoRoot, 'bin', 'cli.js')} assess\` (add the app path, \`--json\` for machine output).`,
      '', 'Guidance (inlined for you; follow it):')
    for (const f of skillFiles) lines.push('', `--- ${path.relative(path.join(repoRoot, 'skills'), f).split(path.sep).join('/')} ---`, fs.readFileSync(f, 'utf8').trim())
  } else if (arm === 'baseline') lines.push('', BASELINE_RULES)
  else throw new Error(`unknown arm: ${arm}`)
  return lines.join('\n') + '\n'
}

module.exports = { REPO_ROOT, DEFAULT_RUN_ROOT, FIXTURES, ARMS, RUNS, TASK_PROMPT, SKILL_FILES, PLUGIN_TRUTH, C2_FIELDS, armRoot, BASELINE_RULES, REPLY_RULE, skillFiles: skillFiles_, cellId, cellDir, buildPrompt }
