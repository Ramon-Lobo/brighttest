---
description: Have the researcher agent investigate a topic and write a cited brief to design/research/
argument-hint: <topic or question>
---
Use the `researcher` agent to investigate: $ARGUMENTS

Give it the precise question, the decision it feeds, and pointers to relevant local material (`design/`, `experiments/`, `docs/`). It must write `design/research/YYYY-MM-DD-<slug>.md` with evidence levels and sources. When it returns, relay the TL;DR, open unknowns (especially anything needing a real device), and the file path. For multiple independent topics, launch researchers in parallel.
