# Reporting issues

A good report lets a maintainer reproduce the problem without asking you anything. This page covers which form to
use, what to include, and what to remove before you file. You file the issue yourself; brighttest sends nothing.

## Which form

| You have | Use |
| --- | --- |
| A short bug with a minimal reproduction | **Bug report** |
| One structured finding from real use (a wrong or silent result, a rough edge, a failure on a device) | **Field report** |
| An idea or a missing capability | **Feature request** |
| A question | [Discussions](https://github.com/Ramon-Lobo/brighttest/discussions) |

Open them from the [new issue page](https://github.com/Ramon-Lobo/brighttest/issues/new/choose). File one issue per
problem. If a session found several, file several.

## What a field report contains

The field report form has these fields, in this order. Required ones are marked.

1. **Summary** (required): one or two sentences. What broke, in which command, and the impact.
2. **Severity** (required): blocker (stops the lane, no workaround), high (wrong or silent result, or a costly
   workaround), medium (a workaround exists), low (cosmetic, docs, rough edge).
3. **Area** (required): headless, device, e2e, Studio, and so on.
4. **Environment** (required): brighttest version (`npx brighttest --version`), Node version, OS, lane, and the
   device model and firmware if a device was involved.
5. **Steps to reproduce** (required): numbered, with the exact commands and the config keys that matter.
6. **Expected behavior** (required).
7. **Actual behavior** (required): the first error line, its cause, the exit code, then a short excerpt. Counts or a
   summary are better than a long log.
8. **Evidence**: redacted excerpts, and what you checked on a real device, headless, or not at all.
9. **Minimal reproduction**: the smallest generic project that shows it, such as one of the `examples/` apps or a
   fresh `brighttest init` project. If that is not possible yet, say why.

Say plainly what you did not verify. "Not tested on a device" is useful; a guess presented as a result is not.

## Remove private details first

Before you file, read your text once and remove or replace:

- names of companies, clients, apps and channels (use generic names such as `my-app`);
- host names, IP addresses and device serial numbers;
- tokens, passwords, cookies and `Authorization` values, including inside command lines and URLs;
- personal paths such as your home directory or user name;
- screenshots and `tree.xml` dumps of a real app, which show its text and images.

Replace values with a placeholder like `<ip-1>` or `<token>` so the structure stays readable. The form has a
checkbox where you confirm you did this. Removal is your job: `brighttest issue redact <file>` masks the usual
shapes and `brighttest issue check <file>` lists what is left (see the
[CLI reference](/guide/cli-reference#brighttest-issue)), but neither knows every private name, so read the text line
by line either way.

## Filing

Use the forms in the browser, or from the terminal with the GitHub CLI after you have read the final text:

```sh
gh issue create --template field_report.yml
```

Maintainers add the area and severity labels at triage. The labels used are defined in
[`.github/labels.json`](https://github.com/Ramon-Lobo/brighttest/blob/main/.github/labels.json).

See also [Troubleshooting](/guide/troubleshooting) and the [contributing guide](/contributing).
