---
description: Have the architect agent produce a design doc, ADRs, and task breakdown for a feature
argument-hint: <feature, or path to research brief>
---
Use the `architect` agent to plan: $ARGUMENTS

Point it at the relevant research briefs in `design/research/` and existing `design/*.md`. If key unknowns lack research, first run the `researcher` agent on them (in parallel if independent) and pass the briefs in. Architect writes `design/<feature>.md` (+ ADRs in `design/decisions/`, + ROADMAP update), status `Proposed`.

When done, summarize the design, list the decisions that need my approval, and STOP. Do not start implementation.
