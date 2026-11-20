---
description: Have the developer agent implement an approved design/task with tests and docs
argument-hint: <design doc path and/or task numbers>
---
Use the `developer` agent to implement: $ARGUMENTS

Precondition: the design doc status is `Approved` (or the task is a small, clearly scoped fix). If not, stop and ask me. Ensure work happens on a feature branch off `main` (create one if needed, with my OK if the tree has unrelated uncommitted changes). Pass the design doc path, task list, and ADRs to the agent. Prefer one task or a tight group of tasks per run.

Afterwards: report what changed, test results, and what was NOT verified (device-only items with exact commands for me). Before handing device checks to `device-qa`, check `brighttest device status`; one device-qa at a time per device unless queuing is intended. Mark progress in `<planning>/design/ROADMAP.md`. Do not commit unless I ask.
