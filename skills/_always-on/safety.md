## brighttest: rules that always apply (installed by `brighttest skills`, v<version>)
Start any brighttest adoption or test work by loading the `adopting-brighttest` skill (when it is installed).

Device (a Roku is a shared, leased resource):
- Every device access goes through a brighttest lane (`--device`, `--cross-check`, `e2e`, `studio`,
  `instrument build --sideload`, MCP device tools) or `npx brighttest device with --as <you> --purpose "<why>" -- <cmd>`.
  Raw curl/telnet/nc to ports 8060, 80, 8080, 8085 outside `device with` is not allowed.
- Never pass `--no-lease` or set `BRIGHTTEST_NO_LEASE`. Never run `device unlock --force`; only a human may.
- Name yourself: `BRIGHTTEST_AGENT=<role>#<n>` or `--as`. Check `npx brighttest device status` first.
- Exit 75 = device busy or wait timed out (not a test failure): report who holds it and stop; do not retry in a loop.
  77 = lease lost. 78 = lease directory unusable.
- Do not hold a lease while reading, thinking or writing. Run long waits in the background with a generous `--wait`.
- Never use sudo, change a firewall, or change settings on someone's Roku to make something work; ask the human.
- If `ROKU_HOST` is unset, MCP and lanes may target the cached device: confirm the target before pressing keys.

Secrets:
- Never print, log, commit or paste the dev password, `BRIGHTTEST_HUB_TOKEN`, or a device serial.
- Keep credentials in env or a gitignored `.env`; make sure `.env` is in `.gitignore`.
- Never commit raw (unredacted) state snapshots or network logs; do not use Studio "show raw" for artifacts.

Releases:
- An instrumented package (`*.bt-instrumented.zip`) is debug-only. `npx brighttest instrument verify <store.zip>`
  must exit 0 before any publish.

Claims:
- Headless is a simulator. Never claim device behavior you did not observe on a real Roku; say "not device-verified".
- A green exit code is not enough on a device: read the Rooibos summary; use `--cross-check` for suspicious greens.
- Show the exact commands you ran and what you could not run.
