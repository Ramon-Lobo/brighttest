# Command cheat sheet

::: info At a glance
**What it is for:** the 15 commands people use most, grouped by task. Every option is in the
[CLI reference](/guide/cli-reference) and in `npx brighttest <command> --help`.

**You will:** find a command fast, and check an exit code.

**First command:** `npx brighttest`
:::

## Synopsis

```text
npx brighttest [--no-sgnode | --coverage | --device | --cross-check] [--junit <file>] [--lcov [file]]
npx brighttest <command> [options]
```

## Set up

| Command | What it does |
|---|---|
| `brighttest init` | Creates `brighttest.json`, a sample spec, `.gitignore` entries and an npm `test` script |
| `brighttest setup --host 192.0.2.10` | Saves a Roku as the project default (`ROKU_HOST` in `.env`) |
| `brighttest doctor` | Checks that the device is ready and prints the exact fixes |

## Run unit tests

| Command | What it does |
|---|---|
| `brighttest` | Runs every test headless, with no device |
| `brighttest --no-sgnode` | Runs faster by skipping `@SGNode` suites |
| `brighttest --coverage --lcov coverage/lcov.info` | Runs headless with coverage and writes LCOV |
| `brighttest --device` | Runs on the Roku, with coverage |
| `brighttest --cross-check` | Runs headless and on the device, and fails on any difference |

## Test the UI on a device

| Command | What it does |
|---|---|
| `brighttest e2e inspect` | Shows the live screen tree, so you can find ids to target |
| `brighttest e2e run flows/` | Runs the YAML flows |
| `brighttest studio --open` | Opens the Studio web app for the device |

## Debug builds

| Command | What it does |
|---|---|
| `brighttest instrument build --sideload --host 192.0.2.10` | Builds a debug package and installs it |
| `brighttest instrument verify <store.zip>` | Release gate. Exits with code 3 if debug code is found |
| `brighttest builds install --latest --host 192.0.2.10` | Installs the newest instrumented build again |

## Share the device

| Command | What it does |
|---|---|
| `brighttest device status` | Shows who holds the device and who is waiting |

## Common exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | A test or check failed |
| 2 | Usage or configuration error |
| 75 / 77 / 78 | Device lease: busy, lost, or lease directory unusable |

## Common problems

- **A flag seems to be ignored.** `e2e` ignores unknown flags without a message, so check the spelling.
- **"Several cached devices" error.** Pass `--host`, or run `brighttest setup` to pin one.
- **Unsure about an option.** `--help` is the authority. When it and the docs disagree, `--help` wins.

## Related

- [CLI reference](/guide/cli-reference): every command, flag and exit code
- [Troubleshooting](/guide/troubleshooting): symptom and fix table

**Full guide:** [CLI reference](full:/guide/cli-reference)
