---
description: Have the architect agent produce a design doc, ADRs, and task breakdown for a feature
argument-hint: <feature, or path to research brief>
---
Use the `architect` agent to plan: $ARGUMENTS

Point it at the relevant research briefs in `<planning>/design/research/` and existing `<planning>/design/*.md`. If key unknowns lack research, first run the `researcher` agent on them (in parallel if independent) and pass the briefs in. Architect writes `<planning>/design/<feature>.md` (+ ADRs in `<planning>/design/decisions/`, + ROADMAP update), status `Proposed`.

When done, summarize the design, list the decisions that need my approval, and STOP. Do not start implementation.
