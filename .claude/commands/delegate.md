---
description: Run the backlog in a loop through the delegator agent until told to stop
argument-hint: [status | stop | cycle-minutes]
---

Run the delegation loop for brighttest.

0. Unless the argument is `status` or `stop`, start a history session first: `node <planning>/delegator/history.mjs session new --title "<one line goal>"`. Agents' own entries land in it. After each agent finishes, if it did not log its result (check `history.mjs get --task <ID> --kind completion --brief`), log one for it (`add --agent <role> ...`). Log owner decisions you receive as `--kind decision`. `/delegate status` may use `history.mjs get --session last --brief` instead of reading files.
1. Spawn the `delegator` agent (Haiku) with any completions since the last cycle. It returns a dispatch list and writes briefs under `<planning>/delegator/briefs/`.
2. For each dispatch entry, read its brief and spawn the named agent in the background with that brief as the prompt (only what the delegator listed; do not add work).
3. When agents complete, first mark the finished tasks ✅ (or 🟡 if unmerged) in the `<planning>/design/BACKLOG.md` master table and Progress ledger, then collect their reports into the next delegator call. Merges and anything under "Needs owner" go to me; don't do them.
   After each agent finishes, check for leftovers it started (`ps -axo pid,ppid,etime,command | grep -E "while :|until \[|sleep "`) and kill orphans before treating it as done; an agent that still says it is waiting on background work is usually blocked on its own stale poll loop.
4. Report to me every cycle or every ~20 minutes: **done**, **in progress**, **next**, **needs you**. Keep it short.
5. Keep looping until I say stop (`/delegate stop`) or the delegator reports nothing runnable. `/delegate status` prints the last status only.

Never exceed the delegator's caps, never push or merge, never start device work unless I have confirmed the device is reachable and `ROKU_PASSWORD` is exported.
