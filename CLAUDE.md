# brighttest — project directives

brighttest is a Node (>=22, CommonJS, no build step for the CLI) test runner for BrightScript/Roku apps.
Write Rooibos specs once; run **headless** (brs-node simulator, default), **on-device** (coverage), or
**cross-check** both. It also ships an **e2e lane** (ECP-driven UI flows in YAML) and **Studio**
(`brighttest studio`: Svelte web app mirroring a live Roku). Read `README.md`, `docs/architecture.md`,
`docs/maintainers.md`, the planning folder before non-trivial work.

**Planning folder:** `<planning>` below means the owner-local planning folder (never in git, never pushed): `$BRIGHTTEST_PLANNING_DIR`, default `../brighttest-planning`. It holds `design/` working docs, `research/`, `decisions/` and test packs. If it is missing, ask the owner; do not recreate it inside the repo.

## Layout
- `bin/cli.js` — arg parsing + dispatch. `lib/` — runner (`headless`, `device`, `cross-check`, coverage, `config`, `reporter`).
- `lib/device-lease.js` — cross-process device lease (`lib/device-command.js`: `brighttest device status|with|unlock|log`).
- `lib/e2e/` — on-device UI lane. `lib/studio/` — Studio server; `lib/studio/web/` — Svelte client (own package.json).
- `brs/headless_runner.brs` — Rooibos driver run on the simulator. `skills/` — bundled agent skills (shipped).
- `docs/` VitePress site · `design/` RFCs · `experiments/` device spikes · `examples/` sample apps · `test/` Vitest.
- Shipped to npm: only what `package.json#files` lists. `docs/ design/ experiments/ examples/ test/` are repo-only.

## Hard rules
1. **Never `npm audit fix`.** It downgrades the postman-request chain and reintroduces a critical advisory (see `package.json` `//overrides`).
2. Engine/framework behavior lives in **patch queues on upstream** (`Ramon-Lobo/brs-engine`, `Ramon-Lobo/rooibos`,
   branches `bt/<upstream-version>`): an exact upstream tag plus an ordered queue of small patches, published as
   `@ramonlobo/brs-node` / `@ramonlobo/rooibos-roku` `<upstream>-bt.<N>`. Don't patch or vendor engines in this repo:
   make the change in the fork, publish, bump the exact pin. Each patch is written so it can be offered upstream;
   whether and when to offer it is an owner decision, and nothing is sent upstream until the owner says so.
   brighttest must also run on stock engines: any behavior that depends on a patch is capability-gated with a fallback.
3. CLI stays **zero-build, plain CommonJS, minimal runtime deps**. Adding a dependency needs an architect decision record.
4. Device-lane / e2e / Studio behavior can only be confirmed on a real Roku. If no device is reachable, say so — never claim device verification you didn't do.
5. Don't push, merge to `main`, publish, or bump versions unless asked. Developer agents MAY commit (Conventional Commits; plain messages with no Claude or co-author trailers, owner decision 2026-11-20) on their own `feat/*`/`fix/*` worktree branches (owner decision OD-03, 2026-11-19); everyone else commits only when asked. Branch off `main` (or the owner-designated base branch); never work on `main` directly.
6. If you touch `skills/`, or change the version, a dependency range, any CLI flag/subcommand/help text, or a lease/instrument default, run `npm run skills:manifest` (it also regenerates `skills/facts.json`). If you touch `docs/`, run `npm run docs:build`.
7. Behavior changes ship with tests (`test/`) and docs in the same change.
8. **No client references.** Never mention the client or employer, or any client-owned app, source or fixtures (including the names in this folder's parent path), in code, docs, designs, tests, fixtures, commits, PRs or issues. Use generic, self-contained fixture apps. Every feature's tests and acceptance steps must be writable as a hand-off brief that another agent or person can execute without any private context.
9. **The Roku is a leased, serialized resource.** Every device access goes through a brighttest lane or `brighttest device with -- <cmd>` (session: `device lock` + inline `BRIGHTTEST_LEASE=`, Phase 2). Never hold the lease while not using the device; never pass `--no-lease`/`BRIGHTTEST_NO_LEASE`.

## Verification
- `npm run test:unit` (fast) · `npm run test:integration` (spawns CLI + simulator) · `npm test` (both).
- Studio client: `npm run studio:build`. Docs: `npm run docs:build`.
- "Done" = relevant tests green, docs updated, and you state exactly what you ran and what you could not run.

## Conventions
- Conventional Commits: `type(scope): imperative summary` (<72 chars). One logical change per PR.
- Match surrounding style; keep code simple and readable. No speculative abstraction.

## Team workflow (agents in `.claude/agents/`)
`researcher` → `architect` → `developer` → `reviewer` (+ `device-qa` for anything hardware-facing), orchestrated by the main session via slash commands:
- `/resume` — re-enter the project: git/branch/WIP triage, refresh `<planning>/design/ROADMAP.md`.
- `/research <topic>` — researcher writes a cited brief to `<planning>/design/research/`.
- `/plan <feature>` — architect (using research) writes/updates a design doc in `<planning>/design/` + decision records in `<planning>/design/decisions/`.
- `/implement <design doc or task>` — developer builds from an approved design, with tests + docs.
- `/feature <idea>` — runs the full chain with an approval gate after the plan.

Rules of the road:
- Artifacts hand off through files, not chat: research → `<planning>/design/research/`, plans → `<planning>/design/`, ADRs → `<planning>/design/decisions/NNNN-title.md`.
- **Human approval gate after the plan, before implementation.** Developer does not start without an approved design.
- Subagents can't spawn subagents; the main session routes between them. If an agent finds a gap upstream (e.g. developer hits an unplanned design question), it stops and reports rather than improvising architecture.
- Research claims need sources (URL + date, or `file:line`) and a confidence note. Distinguish verified-on-device vs. docs vs. inference.
- `<planning>/design/ROADMAP.md` is the single source of truth for what's in flight; update it when state changes.
- **`<planning>/design/BACKLOG.md` is the task list. When a task completes (merged, or its gate passes), the orchestrator marks its master-table row ✅ (🟡 while built but unmerged or unverified) and updates the Progress ledger in the same turn, before reporting to the owner.**

Device scheduling (the device lease, `docs/guide/device-lease.md`):
1. **Device use is allowed for developer and device-qa agents, always through the lease.** Developers may run a brighttest lane or one `device with` command for a short check; long or exploratory device work (flake hunts, Studio sessions, spikes) goes to one device-qa agent. Reviewers stay headless.
2. **Batch device work.** Prefer one device-qa agent per batch of verification requests over several that just queue. Before launching one, run `brighttest device status` and tell the agent what is queued.
3. **Name every agent.** The prompt sets `BRIGHTTEST_AGENT=<role>#<n>` and a one-line purpose; the agent passes `--as/--purpose` (or prefixes device commands with those variables).
4. **Lease only around device-touching commands.** Use a brighttest lane (it leases itself) or `brighttest device with -- <cmd>`. Never hold a lease while reading code, thinking or writing reports.
5. **Wait visibly, don't spin.** Run lease-waiting commands with Bash `run_in_background: true` and a generous `--wait`; report "waiting for the device: held by X for Y, I am #N" from the stderr line. On exit 75, report and stop instead of re-queueing silently.
6. **Parallelism.** Headless work (developers, reviewers, unit/integration tests) runs fully in parallel; the device is serialized, so plan the critical path around it. Never `brighttest device unlock --force` without the owner.
