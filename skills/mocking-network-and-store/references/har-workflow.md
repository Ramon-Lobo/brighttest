# HAR record and replay

Source: `docs/writing-tests/http-fixtures.md`, `node bin/cli.js --help`. Headless lanes only.

## Record

Recording passes requests to the real origin, so it needs the human's OK for each upstream host.

1. The human (or you, with their OK) lists the hosts in `brighttest.json`:
   `{ "instrument": { "net": { "upstreamHosts": ["api.example.test"], "redact": { "jsonPaths": ["$.user.email"] } } } }`
2. Run `npx brighttest --net-record fixtures/net/home.har` (without a file name the HAR goes to
   `.brighttest/net/<run>.har`).
3. Without `upstreamHosts` the command exits 2 with `net.record requires net.upstreamHosts`. `--net-record` with
   `--device` or `--cross-check` also exits 2. Verified at this version.
4. Open the HAR before keeping it. Redaction covers the configured headers, query keys and `jsonPaths`; it does not
   know your secrets. Check for cookies, tokens, user ids and real hostnames, and do not commit a HAR you have not
   read. Do not paste its contents into a report.

## Replay

Add the HAR to `instrument.net.fixtures` (for example `"fixtures/net/*.har"`), drop `--net-record`, and set
`"unmatched": "fail"` so a request the HAR does not cover fails loudly. The suite then runs offline.

## Turn the HAR into rules to edit

```bash
npx brighttest net convert fixtures/net/home.har -o fixtures/net/home.rules.json
```

- One rule per entry (`har-1`, `har-2`, ...) in recorded order. A URL requested more than once gets `times: 1` on all
  but the last rule.
- Redacted values stay redacted (query values become `*`, headers are blanked); entries whose body still holds a
  redacted value are reported on stderr.
- Exit 0 on success (a `wrote N rule(s)` line); exit 1 for a missing or non-HAR file. Both checked in bash and zsh.
- Without `-o` the rules print to stdout.

Then edit the rule file by hand, for example to turn one response into a fault or a `responses` sequence, and list
it under `instrument.net.fixtures`.

## Not covered

Recording on a device, WebSocket traffic and anything not made through a rewritten `setUrl`: unverified, do not
claim them.
