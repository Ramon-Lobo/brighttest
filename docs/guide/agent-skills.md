# Agent skills

If your team writes tests with AI coding agents, brighttest can install **skills** into your project that
teach the agent how to work with the tool — authoring correct Rooibos specs, setting the project up, and
debugging failing runs. Skills follow the open [Agent Skills format](https://agentskills.io) (a `SKILL.md`
plus `references/`), and the content is authored once and adapted to whichever agent your project uses.

## The skills

| Skill | Teaches |
|---|---|
| `adopting-brighttest` | The router: where to start, whether brighttest fits, the existing-app or new-app path, the hard rules, and what "adopted" means. |
| `assessing-a-roku-app` | Running the read-only `brighttest assess`, reading its output (path, blockers, census, secrets, risky patterns), and filling an assessment report without editing the app. |
| `adopting-brighttest-brownfield` | Adding brighttest to an existing, long-lived Roku app, with or without permission to edit its code: mapping bsconfig.json into brighttest.json, the first green headless run, characterization tests, seam extraction, the no-edit path, exclusions and the strict ramp. |
| `adopting-brighttest-greenfield` | Starting a new Roku channel that is testable from day one: `init --greenfield`, BTStore and BTHttp and their limits, ids on nodes, thin Tasks, the spec-first loop, and when a feature needs a device. |
| `instrumenting-a-roku-app` | Building a debug-only instrumented package without editing the app: reading the census, `instrument.exclude`, exit codes and BT9001 to BT9005, the `instrument verify` release gate and the package size budget. |
| `writing-rooibos-tests` | Suite/test annotations, assertions, test doubles, parameterized tests, headless-vs-device rules, and the pitfalls that make specs silently fail. |
| `setting-up-brighttest` | Installing the package, `brighttest.json`, where specs live, choosing a lane, npm scripts, and CI. |
| `debugging-failing-tests` | Reading the output, isolating causes, `--cross-check` fidelity, `globalFields` seeding, and testing the Task/API layer. |
| `testing-app-state` | Reading, setting, snapshotting and asserting app state (`m.global`, scene fields, registry) with `__bt_state`, `assertState`, and the state flow steps. |
| `mocking-network-and-store` | Faking what the app talks to in headless specs: BTNet rules and faults, HAR record and replay, `csfake` roChannelStore fixtures and the `BTMedia_*` Video/Audio driver, and what none of them prove about a device. |
| `using-brighttest-mcp` | Driving a real Roku through the `brighttest mcp` server: the eight tools, the per-call device lease, budgets, and typed errors. |
| `using-a-roku-device-safely` | Before any command that touches a real Roku: the device lease, exit codes 75, 77 and 78, doctor, ECP Permissive, ports, keepalive and the 10-minute stall, secrets, and what an agent must never do. |
| `using-brighttest-studio` | Using `brighttest studio` in the browser: live SceneGraph, remote, flow runs with a step trace, and the Profile page. |
| `writing-e2e-flows` | Authoring/running on-device UI flows (`*.e2e.yaml`): the inspect → write → run workflow, steps, selectors (`id` not `testId`), focus navigation, `record`/`stamp`, multi-device sharding, and CI. |
| `wiring-brighttest-into-ci` | Adding brighttest to GitHub Actions: the headless gate with JUnit and LCOV, the `instrument verify` release gate, the strict debug build, an opt-in device job on a self-hosted runner under the lease (exit 75), and the Windows status. |

## Install

```sh
npx brighttest skills install
```

With no `--agent`, this **auto-detects** the agents your project already uses and installs to each:

| Detected | Skills go to | Always-on safety rules go to |
|---|---|---|
| `.claude/` or `CLAUDE.md` | `.claude/skills/<skill>/` | managed block in `CLAUDE.md` |
| `.agents/` | `.agents/skills/<skill>/` (override root with `--skills-dir`) | managed block in `AGENTS.md` |
| `.cursor/` | `.agents/skills/<skill>/` | `.cursor/rules/brighttest-safety.mdc` (`alwaysApply: true`) |
| `.windsurf/` | `.windsurf/rules/<skill>.md` (SKILL.md body; references copied to `.agents/skills/<skill>/references/`) | `.windsurf/rules/brighttest-safety.md` |
| `.clinerules` | `.clinerules/<skill>.md` (same shape as Windsurf) | `.clinerules/brighttest-safety.md` |
| `.rules` | `.agents/skills/<skill>/` | managed block in `.rules` (Zed) |
| `AGENTS.md` / `opencode.json` | `.agents/skills/<skill>/` (also covers opencode, Codex) | managed block in `AGENTS.md` |
| `.github/` | `.github/skills/<skill>/` | managed block in `.github/copilot-instructions.md` |

The always-on safety rules (device lease, secrets, claims; under 6 KB per file) are written for every target.
Block targets get one managed block named `brighttest` holding the rules plus a short skill index, never full
skill bodies. Pass `--no-safety` to skip it.

### Subagent definitions (Claude target)

For the `claude` target, `install` and `update` also write each shipped subagent definition to
`.claude/agents/<name>.md`. Pass `--no-agents` to skip them. Other targets get no agent files. A `--skill <name>` run
does not touch agents.

Every rendered file carries an ownership marker line (`<!-- brighttest agent:<name> v<version> ... -->`) right after
its frontmatter. Rules:

- A file at the same path **without** our marker is yours: it is reported as `skipped` and never overwritten, and
  `--force` does not change that.
- `uninstall` removes only files carrying the marker (and `.claude/agents/` itself if that leaves it empty). Your own
  agent files are left alone. `--no-agents` makes `uninstall` leave agents in place too.
- Editing a marked file is pointless: the next `install` or `update` rewrites it.

The four bundled agents, each preloaded with the skills it needs:

| Agent | What it does | Skills it loads |
|---|---|---|
| `adoption-assessor` | Read-only assessment of an app: does brighttest fit, what state is it in, which path. Never edits files or touches a device. | `assessing-a-roku-app`, `adopting-brighttest` |
| `ci-integrator` | Adds brighttest to CI, including the release-verify step. Edits CI files and package.json scripts only; never pushes. | `wiring-brighttest-into-ci`, `instrumenting-a-roku-app` |
| `device-debugger` | Leased, bounded investigation on a real Roku. Needs a `BRIGHTTEST_AGENT` name and reports NOT VERIFIED when no device is reachable. | `using-a-roku-device-safely`, `using-brighttest-mcp`, `debugging-failing-tests` |
| `test-author` | Writes Rooibos specs, e2e flows, fixtures and csfake mocks, and proves each new test can fail. Headless unless given a lease name and purpose. | `writing-rooibos-tests`, `writing-e2e-flows`, `mocking-network-and-store` |

Copilot gets skills and the instructions block only. There are no agent definitions for Copilot or any other
non-Claude target in this release.

New to brighttest on an existing app? Start with the [adoption guide](./adopting.md).

Target explicitly with `--agent` (creates the folders if needed):

```sh
npx brighttest skills install --agent claude
npx brighttest skills install --agent all
npx brighttest skills install --skill writing-rooibos-tests --agent cursor
```

`--agent` accepts `claude`, `agentskills`, `cursor`, `windsurf`, `cline`, `zed`, `agents`, `copilot`,
`opencode`, `hermes`, or `all`.

### Guard hook and MCP server (opt-in, Claude target)

Two flags merge brighttest entries into your own config files. Neither is on by default, and both apply to the
`claude` target only.

```sh
npx brighttest skills install --agent claude --with-hook   # .claude/settings.json
npx brighttest skills install --agent claude --with-mcp    # .mcp.json
```

- `--with-hook` appends one `PreToolUse` entry (matcher `Bash`, command
  `node "$CLAUDE_PROJECT_DIR/node_modules/brighttest/bin/cli.js" device hook`, timeout 5 s) to `hooks.PreToolUse` in
  `.claude/settings.json`. It denies raw device access (for example `curl` to port 8060) unless the command goes through
  a lease-aware brighttest command; see [Sharing a device](./device-lease.md#the-claude-code-guard-hook). It assumes
  brighttest is installed in the project's `node_modules`.
- `--with-mcp` adds a `brighttest` server (`node node_modules/brighttest/bin/cli.js mcp`) under `mcpServers` in
  `.mcp.json`.

Rules: existing keys, hooks and servers are kept; running again reports `unchanged`. A file that is not strict JSON
(comments and trailing commas count), a key of the wrong type, or a different existing `brighttest` server is refused:
the run prints the entry to add by hand, exits 1, and the file is not touched. Files are written via a temp file and
rename. Neither entry contains a host, password or token.

To undo, run `skills uninstall --agent claude` (no flag needed): it removes only an entry identical to the one
installed, leaves everything else, and keeps the file. You can also delete the entry by hand. Re-running `install`
without the flags does not remove them.

### Migrating from older, flattened installs

Earlier versions wrote every skill and reference into always-on files (one block per skill, or one file per skill
for Cursor). Running `npx brighttest skills install` again moves you to the current layout:

- Folder targets (Claude, `.agents`, Copilot, Cursor) get real skill folders, and the old per-skill blocks and
  `.cursor/rules/<skill>.mdc` files are removed and reported as `migrated`.
- Windsurf and Cline keep one file per skill, now holding the SKILL.md body only, with references copied to
  `.agents/skills/<skill>/references/`.
- Only blocks and files carrying the brighttest marker are touched. Anything you wrote yourself stays.

## Keep them up to date

`skills update` pulls the newest skills straight from the brighttest repository — independent of your
installed package version:

```sh
npx brighttest skills update              # from the default branch (main)
npx brighttest skills update --ref v0.3.0 # pin a tag/branch
```

It reads the skills manifest over HTTPS, fetches each file, and re-installs to your agents, reporting
`vOLD → vNEW` where it can tell. Requires network access. A ref whose manifest is the older v1 format installs
skills only (no safety block, no migration) and says so.

## List and remove

```sh
npx brighttest skills list        # available skills, detected agents, installed vs CLI version
npx brighttest skills uninstall   # remove installed skills (respects --agent / --skill)
```

## Safe to re-run

`CLAUDE.md`, `AGENTS.md`, `.rules`, and `.github/copilot-instructions.md` are updated **in place** inside one
managed block (a missing or empty file is created or filled; CRLF files stay CRLF):

```
<!-- BEGIN brighttest -->
…
<!-- END brighttest -->
```

Re-running replaces only that block and reports `unchanged` when nothing differs; everything else in the file is
preserved. Older installs used one block per skill (`<!-- BEGIN brighttest:<skill> -->`) and Cursor used
`.cursor/rules/<skill>.mdc`: those are removed on the next install and reported as `migrated`. Anything without
the brighttest marker is left alone. A full `skills install` also migrates old blocks and Cursor files of skills that
are no longer shipped; a `--skill <name>` run migrates only that skill. If an old block cannot be removed (for example
its END marker is missing), that target is reported as `failed` and the new safety block is not written for it. Other old
blocks in the same file are still removed; only the stuck one stays: fix it and re-run. A read-only file is reported as `failed` and not touched; on Windows a
rename that fails with `EPERM`/`EBUSY` is retried a few times and then reported as a transient error (another program
has the file open), not as read-only. A symlink whose target does not exist is refused rather than replaced by a regular
file. A file holding only a line break or other whitespace gets the block appended and is restored byte for byte on
uninstall; when you have added text after the block, uninstall leaves one blank line between your text before and after,
never two.
`skills uninstall` removes the block and index and restores the file's other bytes; a file left empty is kept,
not deleted. Uninstalling `agents` removes the shared `AGENTS.md` block that `agentskills` also uses. A
single-skill `--skill` run leaves the block as it is. Unbalanced, duplicated or reordered markers are reported as
`failed` with the file name and the file is left untouched; brighttest also refuses to write through a symlink that
leaves the project, writes via a temp file and rename, and leaves read-only files alone.

The folder- and file-based targets are brighttest-owned; re-running refreshes them. If one of those paths already
exists and wasn't created by brighttest, it's skipped with a hint — pass `--force` to overwrite.
`skills list` shows, per target, the version brighttest last wrote next to the CLI version.

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

For an app built with brighttest in mind, `npx brighttest init --greenfield` also copies the `BTStore` and `BTHttp`
templates into `source/brighttest/` and adds `BT_AGENT=false` to `bs_const`. See
[Instrument: greenfield setup](./instrument.md#greenfield-setup-init-greenfield) for the script-tag wiring, `--force`
behavior and current limitations.
