---
description: Re-enter the project after a gap — triage git state, WIP, branches, deps, and refresh the roadmap
---
Re-orient on brighttest after a long pause. Do NOT change source code.

1. Read `CLAUDE.md`, `README.md`, `<planning>/design/ROADMAP.md`, and skim `<planning>/design/*.md` statuses.
2. Git triage (in this repo): current branch, `git status`, unmerged local/remote branches vs `main` (ahead/behind, last commit date), open dependabot branches, stash. Group uncommitted changes by theme and guess the intent of each group from the diff.
3. Health check: `npm ci` state OK? Run `npm run test:unit` and report. Check `npm outdated` and whether `@ramonlobo/brs-node` / `@ramonlobo/rooibos-roku` / `brighterscript` / `rooibos` have newer upstream releases.
4. Update `<planning>/design/ROADMAP.md`: In-flight work (with branch + state), Stale branches to merge/close, Decisions needed from me, and a proposed prioritized backlog.
5. Report: what state the project is in, risks (e.g. uncommitted work that could be lost), and the 3 best next moves. Ask me which to pursue.

Input/focus (optional): $ARGUMENTS
