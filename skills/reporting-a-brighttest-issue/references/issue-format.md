# Issue format

Use the field report (`.github/ISSUE_TEMPLATE/field_report.yml`). Headings, in order (`issue check` lints them; the
first eight below, plus Before filing, are required):

`Summary`, `Severity`, `Area`, `Environment`, `Steps to reproduce`, `Expected behavior`, `Actual behavior`, `Evidence`,
`Minimal reproduction`, `Before filing`.

Rules: Summary is one or two sentences (what, which command, impact). Environment has the brighttest version
(`npx brighttest --version`), Node, OS, lane, and device model and firmware if a device was involved. Steps are numbered
with exact commands. Actual behavior has the first error line, cause, exit code, short excerpt. Evidence says what was
checked headless, on a device, or not at all.

## Worked example (generic)

```md
## Summary
`instrument build --sideload` fails with `fetch failed` when the device closes the connection after its
authentication challenge. The build is fine; the install step aborts.

## Severity
high

## Area
Instrument

## Environment
brighttest 0.7.x, Node 22, macOS, device lane, Roku <model> firmware <version>

## Steps to reproduce
1. Copy `examples/greenfield-app` to `my-app/`.
2. `npx brighttest instrument build --sideload --host <ip-1> --password <password>`

## Expected behavior
The package installs, or a message names the failing step.

## Actual behavior
`fetch failed` with no step named; exit 1. The request that failed is the install POST after the digest challenge.

## Evidence
Reproduced once on a device. Not tested headless (the sideload step needs a device).

## Minimal reproduction
`examples/greenfield-app`, command above.

## Before filing
- [x] I removed names of companies, clients and apps, hosts, IPs, tokens, passwords, serials and personal paths.
- [x] This report is about one problem.
```

## Tracking issue template

```md
## Summary
One cause, several symptoms: <cause in one sentence>.

## Findings
- [ ] <link to issue 1>: <one line>
- [ ] <link to issue 2>: <one line>

## Shared cause
<what the findings have in common, and what is not yet known>
```
