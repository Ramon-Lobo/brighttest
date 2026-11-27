# Reporting issues

::: info At a glance
**What it is for:** filing a report a maintainer can reproduce without asking you anything. You file it yourself; brighttest sends nothing.

**You will:**
- pick the right form
- fill in a field report
- remove private details (with `brighttest issue redact` and `check`)
- file it in the browser or with `gh`

**First command:** `npx brighttest issue check <file>`
:::

## Which form

One issue per problem: if a session found several, file several.

| You have | Use |
| --- | --- |
| A short bug with a minimal reproduction | **Bug report** |
| One structured finding from real use (a wrong or silent result, a rough edge, a device failure) | **Field report** |
| An idea or a missing capability | **Feature request** |
| A question | [Discussions](https://github.com/Ramon-Lobo/brighttest/discussions) |

Open them from the [new issue page](https://github.com/Ramon-Lobo/brighttest/issues/new/choose).

## What a field report contains

The form's fields, in order. 1 to 7 are required.

1. **Summary:** one or two sentences: what broke, in which command, the impact.
2. **Severity:** blocker (stops the lane, no workaround), high (wrong or silent result, or a costly workaround), medium (a workaround exists), low (cosmetic, docs, rough edge).
3. **Area:** headless, device, e2e, Studio, and so on.
4. **Environment:** brighttest version (`npx brighttest --version`), Node, OS, lane; device model and firmware if a device was involved.
5. **Steps to reproduce:** numbered, with exact commands and the config keys that matter.
6. **Expected behavior.**
7. **Actual behavior:** first error line, its cause, the exit code, then a short excerpt. Counts or a summary beat a long log.
8. **Evidence:** redacted excerpts, and what you checked on a real device, headless, or not at all.
9. **Minimal reproduction:** the smallest generic project that shows it (an `examples/` app or a fresh `brighttest init` project). If not possible yet, say why.

::: tip Say what you did not verify
"Not tested on a device" is useful; a guess presented as a result is not.
:::

## Remove private details first

Read your text once and replace with placeholders like `<ip-1>` or `<token>`:

- company, client, app and channel names (use generic names such as `my-app`);
- host names, IP addresses, device serial numbers;
- tokens, passwords, cookies, `Authorization` values, also in command lines and URLs;
- personal paths (home directory, user name);
- screenshots and `tree.xml` dumps of a real app (they show its text and images).

The form has a checkbox to confirm you did this.

```sh
brighttest issue redact <file>   # masks the usual shapes
brighttest issue check <file>    # lists what is left
```

::: warning Removal is your job
Neither command knows every private name; read the text line by line either way. See the [CLI reference](/guide/cli-reference#brighttest-issue).
:::

## Filing

Use the browser forms, or the GitHub CLI after reading the final text:

```sh
gh issue create --template field_report.yml
```

Maintainers add area and severity labels at triage ([`.github/labels.json`](https://github.com/Ramon-Lobo/brighttest/blob/main/.github/labels.json)).

## Related

- [Troubleshooting](/guide/troubleshooting): check for a known fix first
- [CLI reference: issue](/guide/cli-reference#brighttest-issue): `redact`, `check`, `collect`
- [Contributing](full:/contributing): the contributing guide

**Full guide:** [Reporting issues](full:/guide/reporting-issues) — the original wording.
