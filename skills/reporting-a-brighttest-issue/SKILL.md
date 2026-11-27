---
name: reporting-a-brighttest-issue
description: Use when a session found a brighttest bug, a silent or wrong result, or a rough edge and the person wants it written up as a public issue — pick what matters, split one issue per finding, reproduce on a generic fixture, anonymize with `brighttest issue redact` and `issue check`, format to the field-report schema, and hand the text over without filing it.
triggers: report a brighttest issue; write up a brighttest bug; field report; file a bug against brighttest; issue redact; issue check; anonymize an issue; draft a github issue for brighttest
when-not-to-use: Do not use to debug why a run fails (use debugging-failing-tests), or to decide whether brighttest fits an app (use adopting-brighttest). For device rules while reproducing, use using-a-roku-device-safely.
license: MIT
metadata:
  source: brighttest
---

# Reporting a brighttest issue

Turn findings from a session into issues a maintainer can reproduce without asking anything. You draft the text and
stop. **Never run `gh`, open a browser or send anything** unless the person asks you to after `brighttest issue check`
exits 0 (a separate step, tracked as ISSUE-SKILL-FILING). brighttest itself sends nothing.

## Steps

1. **Pick what matters.** Keep wrong or silent results, crashes, and costly workarounds; drop noise. See
   `references/what-matters.md`.
2. **One issue per finding.** If two problems have different causes or fixes, write two drafts. If several share one
   cause, write one issue plus a tracking issue that lists them (template in `references/issue-format.md`).
3. **Reproduce on a generic fixture** (`examples/greenfield-app`, `examples/legacy-app`, or a fresh `brighttest init`
   project), not on the real app. If you cannot, say why in the Minimal reproduction section.
4. **Write the draft** to a file in the field-report shape: `references/issue-format.md`. Say what you did not verify
   (for example "not tested on a device").
5. **Anonymize.** `references/anonymizing.md`:

   ```sh
   brighttest issue redact draft.md -o draft.redacted.md
   brighttest issue check draft.redacted.md
   ```

   `issue check` exits 0 clean, 1 findings, 2 usage. Fix findings by hand and re-run until it exits 0. Then read the
   text line by line yourself: the tools do not know every private name.
6. **Pick severity and labels** (`references/severity-and-labels.md`). Maintainers set labels at triage.
7. **Hand off.** Give the person the path of the checked file, its `fingerprint: bt-xxxxxxxx` and the form to use
   (`field_report.yml`). Stop. Filing is theirs unless they ask you to file after exit 0.

## Rules

- Never put a token, password, hub token, host, IP, serial, personal path, or the name of a company, client or app in a
  draft. Never print a process environment.
- Do not paste `tree.xml` dumps or screenshots of a real app.
- A guess is not a result: label it as a guess.
