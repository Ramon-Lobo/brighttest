# Agent skills

If your team writes tests with AI coding agents, brighttest can install **skills** into your project that
teach the agent how to work with the tool — authoring correct Rooibos specs, setting the project up, and
debugging failing runs. Skills follow the open [Agent Skills format](https://agentskills.io) (a `SKILL.md`
plus `references/`), and the content is authored once and adapted to whichever agent your project uses.

## The skills

| Skill | Teaches |
|---|---|
| `writing-rooibos-tests` | Suite/test annotations, assertions, test doubles, parameterized tests, headless-vs-device rules, and the pitfalls that make specs silently fail. |
| `setting-up-brighttest` | Installing the package, `brighttest.json`, where specs live, choosing a lane, npm scripts, and CI. |
| `debugging-failing-tests` | Reading the output, isolating causes, `--cross-check` fidelity, `globalFields` seeding, and testing the Task/API layer. |

## Install

```sh
npx brighttest skills install
```

With no `--agent`, this **auto-detects** the agents your project already uses and installs to each:

| Detected | Installs to |
|---|---|
| `.claude/` | `.claude/skills/<skill>/` (native Claude Code skill, with reference files) |
| `.agents/` | `.agents/skills/<skill>/` (generic Agent Skills folder; override root with `--skills-dir`) |
| `.cursor/` | `.cursor/rules/<skill>.mdc` (scoped to `**/*.spec.bs`) |
| `.windsurf/` | `.windsurf/rules/<skill>.md` |
| `.clinerules` | `.clinerules/<skill>.md` |
| `.rules` | managed block in `.rules` (Zed) |
| `AGENTS.md` / `opencode.json` | managed block in `AGENTS.md` (also covers opencode, Codex) |
| `.github/` | managed block in `.github/copilot-instructions.md` |

Target explicitly with `--agent` (creates the folders if needed):

```sh
npx brighttest skills install --agent claude
npx brighttest skills install --agent all
npx brighttest skills install --skill writing-rooibos-tests --agent cursor
```

`--agent` accepts `claude`, `agentskills`, `cursor`, `windsurf`, `cline`, `zed`, `agents`, `copilot`,
`opencode`, `hermes`, or `all`.

## Keep them up to date

`skills update` pulls the newest skills straight from the brighttest repository — independent of your
installed package version:

```sh
npx brighttest skills update              # from the default branch (main)
npx brighttest skills update --ref v0.3.0 # pin a tag/branch
```

It reads the skills manifest over HTTPS, fetches each file, and re-installs to your agents, reporting
`vOLD → vNEW` where it can tell. Requires network access.

## List and remove

```sh
npx brighttest skills list        # available skills + detected agents
npx brighttest skills uninstall   # remove installed skills (respects --agent / --skill)
```

## Safe to re-run

`AGENTS.md`, `.rules`, and `.github/copilot-instructions.md` are updated **in place** inside a managed
block, one per skill:

```
<!-- BEGIN brighttest:writing-rooibos-tests -->
…
<!-- END brighttest:writing-rooibos-tests -->
```

Re-running replaces only that block — everything else in the file is preserved. The folder- and file-based
targets (Claude Code, Agent Skills, Cursor, Windsurf, Cline) are brighttest-owned; re-running refreshes
them. If one of those paths already exists and wasn't created by brighttest, it's skipped with a hint —
pass `--force` to overwrite.

## Export for manual placement

```sh
npx brighttest skills export --out ./brighttest-skills
```

Writes each skill as a standard Agent Skills folder so you can drop it wherever your agent reads skills.

## Scaffolding a new project

`brighttest init` sets up a project for testing — `brighttest.json`, a first spec at
`source/tests/Example.spec.bs`, git-ignore entries, and an npm `test` script — then points you at
`skills install`:

```sh
npx brighttest init
```
