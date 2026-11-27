# What matters

Report, in this order of value:

1. **Silent or wrong results**: the run reported success while the outcome was wrong or incomplete (label
   `silent-failure`). These cost the most because nobody notices.
2. **Crashes and hangs** in a brighttest command, with the exit code and the first error line.
3. **Costly workarounds**: you had to leave the documented path to get work done.
4. **Rough edges**: confusing messages, missing docs, wrong flag help.

Skip: things already covered by a documented limit, problems in the app under test, one-off network trouble, and
anything you cannot describe in steps. Search the existing issues for the first error line before drafting.

Split rule: one issue answers one question, "what is wrong, with which command". Two findings with different commands
or fixes are two issues. A shared root cause across several findings gets one tracking issue that links the others.
Keep each finding short: the first error line, its cause, the exit code, then a small excerpt. Counts beat long logs.
