# greenfield-skeleton

Evaluation fixture for the greenfield start: the smallest valid Roku app (`manifest`,
`source/main.brs`, one Scene `HomeScene` with one Label).

It deliberately has no specs, no flows, no fixtures, no `brighttest.json` and no other
brighttest files. Use it to try `brighttest init --greenfield` and writing a first feature with tests.

## Expected `brighttest assess` output

No blockers. Real output (`node bin/cli.js assess examples/greenfield-skeleton`), key lines:

```
project:   Roku app; 1 brs, 0 bs, 1 xml; specs 0
bsconfig:  none
census:    1 scenes, 0 tasks, setUrl 0/0 covered, 0 could not instrument
recommend: greenfield; edit permission unknown
```
