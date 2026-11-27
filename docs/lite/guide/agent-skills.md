# Agent skills

::: info At a glance
**What it is for:** installing **skills** that teach your AI coding agent to use brighttest: correct Rooibos specs, project setup, debugging. Skills use the open [Agent Skills format](https://agentskills.io) (`SKILL.md` plus `references/`), written once and adapted to each agent.

**You will:**
- Pick from the 17 skills and 4 bundled subagents
- Install, update, list, export and uninstall them
- Opt in to the guard hook and MCP server

**First command:** `npx brighttest skills install`
:::

## The skills

Seventeen skills ship; `adopting-brighttest` is the entry point.

| Skill | Teaches |
|---|---|
| `adopting-brighttest` | The router: where to start, whether brighttest fits, existing-app or new-app path, hard rules, what "adopted" means. |
| `mapping-a-roku-app` | Named features via `brighttest features graph`, `check`, `render`: feature tree, leaf-first and base-first paths, headless vs device, CI checklist. No app edits. |
| `assessing-a-roku-app` | Read-only `brighttest assess`: path, blockers, census, secrets, risky patterns, assessment report. No app edits. |
| `adopting-brighttest-brownfield` | Existing long-lived apps, with or without edit permission: bsconfig.json to brighttest.json, first green headless run, characterization tests, seam extraction, no-edit path, exclusions, strict ramp. |
| `adopting-brighttest-greenfield` | New channels testable from day one: `init --greenfield`, BTStore and BTHttp and their limits, node ids, thin Tasks, spec-first loop, when a device is needed. |
| `instrumenting-a-roku-app` | Debug-only instrumented package without app edits: census, `instrument.exclude`, exit codes, BT9001 to BT9005, `instrument verify` release gate, package size budget. |
| `writing-rooibos-tests` | Annotations, assertions, test doubles, parameterized tests, headless-vs-device rules, pitfalls that make specs silently fail. |
| `setting-up-brighttest` | Install, `brighttest.json`, spec location, lane choice, npm scripts, CI. |
| `debugging-failing-tests` | Reading output, isolating causes, `--cross-check` fidelity, `globalFields` seeding, testing the Task/API layer. |
| `reporting-a-brighttest-issue` | One issue per finding, generic repro, `issue redact` and `issue check`, field-report format, a hand-off that never files on its own. |
| `testing-app-state` | Reading, setting, snapshotting, asserting state (`m.global`, scene fields, registry) with `__bt_state`, `assertState` and state flow steps. |
| `mocking-network-and-store` | Headless fakes: BTNet rules and faults, HAR record/replay, `csfake` roChannelStore fixtures, the `BTMedia_*` Video/Audio driver, and what none prove about a device. |
| `using-brighttest-mcp` | Driving a Roku through `brighttest mcp`: the ten tools, per-call lease, budgets, typed errors. |
| `using-a-roku-device-safely` | Before touching a Roku: lease, exit codes 75, 77 and 78, doctor, ECP Permissive, ports, keepalive and the 10-minute stall, secrets, what an agent must never do. |
| `using-brighttest-studio` | `brighttest studio` in the browser: live SceneGraph, remote, flow runs with step trace, Profile page. |
| `writing-e2e-flows` | `*.e2e.yaml` flows: inspect → write → run, steps, selectors (`id` not `testId`), focus navigation, `record`/`stamp`, multi-device sharding, CI. |
| `wiring-brighttest-into-ci` | GitHub Actions: headless gate with JUnit and LCOV, `instrument verify` gate, strict debug build, opt-in self-hosted device job under the lease (exit 75), Windows status. |

::: tip "The ten tools" is out of date
The `using-brighttest-mcp` row says "the ten tools", but the [MCP page](/guide/mcp) and `brighttest mcp --help` list 16.
:::

## Install

With no `--agent`, `install` **auto-detects** the agents your project uses and installs to each.

```sh
npx brighttest skills install
```

| Detected | Skills go to | Always-on safety rules go to |
|---|---|---|
| `.claude/` or `CLAUDE.md` | `.claude/skills/<skill>/` | managed block in `CLAUDE.md` |
| `.agents/` | `.agents/skills/<skill>/` (root: `--skills-dir`) | managed block in `AGENTS.md` |
| `.cursor/` | `.agents/skills/<skill>/` | `.cursor/rules/brighttest-safety.mdc` (`alwaysApply: true`) |
| `.windsurf/` | `.windsurf/rules/<skill>.md` (SKILL.md body; references in `.agents/skills/<skill>/references/`) | `.windsurf/rules/brighttest-safety.md` |
| `.clinerules` | `.clinerules/<skill>.md` (like Windsurf) | `.clinerules/brighttest-safety.md` |
| `.rules` | `.agents/skills/<skill>/` | managed block in `.rules` (Zed) |
| `AGENTS.md` / `opencode.json` | `.agents/skills/<skill>/` (also opencode, Codex) | managed block in `AGENTS.md` |
| `.github/` | `.github/skills/<skill>/` | managed block in `.github/copilot-instructions.md` |

Safety rules (lease, secrets, claims; under 6 KB per file) go to every target. Block targets get one managed `brighttest` block with the rules and a short skill index, never full skill bodies. `--no-safety` skips it.

### Target an agent

`--agent` creates folders as needed. Values: `claude`, `agentskills`, `cursor`, `windsurf`, `cline`, `zed`, `agents`, `copilot`, `opencode`, `hermes`, `all`.

```sh
npx brighttest skills install --agent claude
npx brighttest skills install --skill writing-rooibos-tests --agent cursor
```

New to brighttest on an existing app? Start with the [adoption guide](/guide/adopting).

### Subagent definitions

For `claude`, `install` and `update` also write each shipped subagent to `.claude/agents/<name>.md`.

| Agent | What it does | Skills it loads |
|---|---|---|
| `adoption-assessor` | Read-only assessment and feature map: fit, state, path, features to test first. Edits no app file (in the features folder only `graph.json`, `tree.json`, `report.html` and its `.gitignore`); never touches a device. | `assessing-a-roku-app`, `adopting-brighttest`, `mapping-a-roku-app` |
| `ci-integrator` | Adds brighttest to CI, with the release-verify step. Edits CI files and package.json scripts only; never pushes. | `wiring-brighttest-into-ci`, `instrumenting-a-roku-app` |
| `device-debugger` | Leased, bounded investigation on a real Roku. Needs a `BRIGHTTEST_AGENT` name; reports NOT VERIFIED with no device. | `using-a-roku-device-safely`, `using-brighttest-mcp`, `debugging-failing-tests` |
| `test-author` | Rooibos specs, e2e flows, fixtures, csfake mocks; proves each new test can fail. Headless unless given a lease name and purpose. | `writing-rooibos-tests`, `writing-e2e-flows`, `mocking-network-and-store` |

Ownership rules (each file has a marker line `<!-- brighttest agent:<name> v<version> ... -->` after its frontmatter):

- A file at the same path **without** the marker is yours: reported `skipped`, never overwritten, even with `--force`.
- `uninstall` removes only marked files (and `.claude/agents/` if left empty).
- Editing a marked file is pointless: the next `install` or `update` rewrites it.
- `--no-agents` skips agents on install and leaves them in place on uninstall. A `--skill <name>` run does not touch agents.

::: details Copilot and other targets
All four agents are Claude-only (`hosts: [claude]`). Copilot gets skills and the instructions block, and would get `.github/agents/<name>.agent.md` for a definition listing `copilot` in `hosts` (none do in this release). No other target gets agent files. `brighttest skills --check` compares `skills/manifest.json` with the `skills/` tree without writing and exits 1 on drift (for CI). Copilot cannot preload skills, so a rendered Copilot agent opens by telling it to load them. Tool names map to Copilot aliases (`Read` → `read`, `Edit`/`Write` → `edit`, `Grep`/`Glob` → `search`, `Bash` → `execute`).
:::

::: warning Not verified on Copilot
The Copilot tool aliases are not yet verified on a Copilot install.
:::

### Guard hook and MCP server (opt-in, Claude target)

Two opt-in flags merge brighttest entries into your config files, `claude` target only.

::: code-group
```sh [Guard hook]
npx brighttest skills install --agent claude --with-hook   # .claude/settings.json
```
```sh [MCP server]
npx brighttest skills install --agent claude --with-mcp    # .mcp.json
```
:::

| Flag | Adds |
|---|---|
| `--with-hook` | One `PreToolUse` entry (matcher `Bash`, command `node "$CLAUDE_PROJECT_DIR/node_modules/brighttest/bin/cli.js" device hook`, timeout 5 s) in `hooks.PreToolUse`. Denies raw device access (for example `curl` to port 8060) outside lease-aware brighttest commands ([guard hook](/guide/device-lease#the-claude-code-guard-hook)). Assumes brighttest is in `node_modules`. |
| `--with-mcp` | A `brighttest` server (`node node_modules/brighttest/bin/cli.js mcp`) under `mcpServers`. |

- Existing keys, hooks and servers are kept; a re-run reports `unchanged`.
- Refused (prints the entry to add by hand, exits 1, file untouched): non-strict JSON (comments, trailing commas), a key of the wrong type, or a different existing `brighttest` server.
- Written via temp file and rename. No host, password or token in either entry.
- **Undo:** `skills uninstall --agent claude` removes only an identical entry and keeps the file; or delete it by hand. Re-running `install` without the flags does not remove them.

### Migrating from older, flattened installs

Older versions wrote every skill into always-on files. Re-running `npx brighttest skills install` moves you to the current layout:

- Folder targets (Claude, `.agents`, Copilot, Cursor) get skill folders; old per-skill blocks and `.cursor/rules/<skill>.mdc` files are removed and reported `migrated`.
- Windsurf and Cline keep one file per skill (SKILL.md body only), references in `.agents/skills/<skill>/references/`.
- Only brighttest-marked blocks and files are touched.

## For AI agents
<!-- covers: Reading these docs as an agent -->

Agents can read this site as plain Markdown. The site has two tiers: a short version of each page at the usual address, and the full guide at `/full/<path>` (see [the full guide](full:/guide/agent-skills) and [the MCP page](full:/guide/mcp)).

- **`llms.txt`** at the released docs root (for example `https://ramon-lobo.github.io/brighttest/llms.txt`) lists every page by sidebar group, with a one-line description and a link to its Markdown copy.
- **Every page has a `.md` twin**: `/guide/studio` → `/guide/studio.md`; `/writing-tests/` → `/writing-tests/index.md`. Add `.md` to the page path of either tier's address to get the **full** Markdown copy. Each HTML page names its twin in a `<link rel="alternate" type="text/markdown">` tag.
- Copies are built from the same sources, and their links point at other `.md` copies. Only released docs have them, not `/next/`.

::: warning Docs do not replace skills
The skills carry the safety rules for using a real device. Install them rather than relying on the docs alone.
:::

## Keep them up to date

`skills update` pulls the newest skills from the repository over HTTPS, independent of your package version, re-installs and reports `vOLD → vNEW` where it can. Needs network access.

```sh
npx brighttest skills update              # default branch (main)
npx brighttest skills update --ref v0.3.0 # pin a tag/branch
```

A ref with an older v1 manifest installs skills only (no safety block, no migration) and says so.

## List and remove

```sh
npx brighttest skills list        # skills, detected agents, installed vs CLI version
npx brighttest skills uninstall   # respects --agent / --skill
```

## Safe to re-run

`CLAUDE.md`, `AGENTS.md`, `.rules` and `.github/copilot-instructions.md` are edited **in place** inside one managed block (missing or empty files are created or filled; CRLF stays CRLF):

```
<!-- BEGIN brighttest -->
…
<!-- END brighttest -->
```

### Install and re-run

- Only the block is replaced; `unchanged` when nothing differs.
- Old per-skill blocks (`<!-- BEGIN brighttest:<skill> -->`) and `.cursor/rules/<skill>.mdc` are removed and reported `migrated`. Unmarked content is left alone.
- A full install also migrates retired skills; a `--skill <name>` run migrates only that skill.
- Folder- and file-based targets are brighttest-owned and refreshed. An existing path brighttest did not create is skipped with a hint; `--force` overwrites.
- `skills list` shows, per target, the last version written next to the CLI version.

### Uninstall

- Removes the block and index and restores the file's other bytes; an emptied file is kept.
- Uninstalling `agents` removes the shared `AGENTS.md` block that `agentskills` also uses. A `--skill` run leaves the block.
- A whitespace-only file gets the block appended and is restored byte for byte. With your text after the block, one blank line separates your text, never two.

::: details Failure and edge cases
- An old block that cannot be removed (for example missing END marker): that target is `failed` and its new safety block is not written. Other old blocks in the file are still removed; fix it and re-run.
- Unbalanced, duplicated or reordered markers: `failed` with the file name, file untouched.
- Read-only file: `failed`, not touched.
- Windows: a rename failing with `EPERM`/`EBUSY` is retried a few times, then reported as transient (another program has the file open), not read-only.
- A symlink to a missing target is refused, not replaced. Writing through a symlink that leaves the project is refused.
- All writes go via temp file and rename.
:::

## Export for manual placement

Writes each skill as a standard Agent Skills folder to drop wherever your agent reads skills.

```sh
npx brighttest skills export --out ./brighttest-skills
```

## Scaffolding a new project

`brighttest init` creates `brighttest.json`, a first spec at `source/tests/Example.spec.bs`, git-ignore entries and an npm `test` script, then points you at `skills install`.

```sh
npx brighttest init
```

`npx brighttest init --greenfield` also copies the `BTStore` and `BTHttp` templates into `source/brighttest/` and adds `BT_AGENT=false` to `bs_const`. See [Instrument: greenfield setup](/guide/instrument#greenfield-setup-init-greenfield) for script-tag wiring, `--force` behavior and limits.

## Related

- [MCP server](/guide/mcp): the tools behind `using-brighttest-mcp`
- [Adopting brighttest](/guide/adopting): where to start on an existing app

**Full guide:** [Agent skills](full:/guide/agent-skills) — the original wording.
