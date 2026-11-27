# Severity and labels

Severity (the form's dropdown; `issue check` flags any other value):

| Severity | Meaning |
| --- | --- |
| blocker | Stops the lane, no workaround. |
| high | Wrong or silent result, or a costly workaround. |
| medium | A workaround exists. |
| low | Cosmetic, docs, rough edge. |

Area options: Headless, Headless + coverage, Device, Cross-check, End-to-end (e2e), Studio, Instrument, Net (hub,
mocks), Assess / features, MCP, Skills, Device lease, CLI / config, Docs, Other.

Labels live in `.github/labels.json`. The field report form applies `field-report` and `needs-triage`. Other labels
you may suggest in the draft, never apply: `silent-failure` (success reported, result wrong), `needs-repro`, `needs-device`
(only a real Roku can verify), `bug`, `enhancement`, `documentation`. Maintainers set labels and area at triage.
