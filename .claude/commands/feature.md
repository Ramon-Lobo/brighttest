---
description: Full pipeline for a new feature — research → architect plan → approval gate → implement → review
argument-hint: <feature idea>
---
Run the full team workflow for: $ARGUMENTS

1. **Research** — decide which unknowns matter; launch `researcher` agents (parallel if independent). Read their briefs.
2. **Plan** — launch `architect` with the briefs. It writes the design doc, ADRs, and task breakdown (`Proposed`).
3. **GATE** — present the design summary and decisions needed. Wait for my explicit approval or edits. Do not proceed without it. On approval set the design status to `Approved`.
4. **Implement** — launch `developer` task by task (on a feature branch). Relay any design gaps back to `architect` instead of letting the developer improvise.
5. **Review** — launch `reviewer` on the diff (and `device-qa` if the change touches device/e2e/Studio and a Roku is available: check `brighttest device status` first; one device-qa at a time per device unless queuing is intended); fix confirmed findings via `developer`.
6. **Wrap-up** — update `<planning>/design/ROADMAP.md`; report results, unverified device-only items (with commands), and a suggested Conventional Commit/PR description. Don't commit or push unless I ask.
