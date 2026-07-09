# Agent skills

If your team writes tests with AI coding agents, brighttest can install a **skill** into your project
that teaches the agent how to write correct Rooibos specs — the authoring rules, the pitfalls that make
specs silently fail, the headless-vs-device limitations, and copy-paste examples. The knowledge is
authored once and adapted to whichever agent format your project uses.

## Install

```sh
npx brighttest skills install
```

With no `--agent`, this **auto-detects** which agents your project already uses and installs to each:

| Detected | Installs to |
|---|---|
| `.claude/` | `.claude/skills/writing-rooibos-tests/` (a native Claude Code skill, with reference files) |
| `.cursor/` | `.cursor/rules/writing-rooibos-tests.mdc` (scoped to `**/*.spec.bs`) |
| `AGENTS.md` | a managed block inside `AGENTS.md` |
| `.github/` | a managed block inside `.github/copilot-instructions.md` |

Target a specific agent (creating the folders if needed) with `--agent`:

```sh
npx brighttest skills install --agent claude
npx brighttest skills install --agent all
```

`--agent` accepts `claude`, `cursor`, `agents`, `copilot`, or `all`.

## What gets written

The Claude Code target is the full skill — a concise `SKILL.md` plus reference files (`pitfalls.md`,
`limitations.md`, `examples.md`, `cheatsheet.md`) that the agent opens only when relevant (progressive
disclosure). The single-file targets (Cursor, AGENTS.md, Copilot) receive the same content flattened into
one self-contained document.

## Safe to re-run

`AGENTS.md` and `.github/copilot-instructions.md` are updated **in place** inside a managed block:

```
<!-- BEGIN brighttest:writing-rooibos-tests -->
…
<!-- END brighttest:writing-rooibos-tests -->
```

Re-running `install` replaces only that block — anything else in those files is preserved. The Claude
Code skill folder and the Cursor `.mdc` are brighttest-owned; re-running refreshes them. If one of those
paths already exists and wasn't created by brighttest, it's skipped with a hint — pass `--force` to
overwrite.

## Export for manual placement

To drop the raw files somewhere and wire them into an agent yourself:

```sh
npx brighttest skills export --out ./brighttest-skills
```

This writes the canonical `writing-rooibos-tests/` folder (`SKILL.md` + the four reference files) so you
can paste the content wherever your agent reads project instructions.
