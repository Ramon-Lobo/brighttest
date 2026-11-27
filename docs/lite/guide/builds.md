# Builds

::: info At a glance
**What it is for:** a history of built or sideloaded packages, so you can reinstall one without rebuilding.

**You will:**
- add, list, label, tag and pin builds
- install a stored build under the lease
- prune the store

**First command:** `npx brighttest builds list`
:::

Used by `brighttest builds`, the Studio Builds page and (read-only) the `builds_list` [MCP tool](/guide/mcp).

## What gets recorded

| Source | Recorded |
|---|---|
| `brighttest instrument build` | Its package, unless `builds.record` is `false` |
| `instrument build --sideload`, `builds install` | Install result (ok/failed, how, when) on the record |
| `builds add <zip>`, Studio upload | Any package; identical bytes stored once (only a source is added) |

- Packages are read, not extracted: `manifest` title and version, and `kind` (`instrumented` or `store`).
- Refused: no manifest, unsafe zip, or over `builds.maxZipMB`.
- Id: `b` + 12 hex. Any unique prefix of 4+ characters works.

## Where the store lives

`.brighttest/builds` in the project (git-ignore it), or `~/.brighttest/builds` with no `brighttest.json`. Override with `BRIGHTTEST_BUILDS_DIR` (absolute), `builds.dir`, or `--builds-dir <dir>` for one call. Studio and CLI share it.

```json
{ "builds": { "record": true, "maxCount": 30, "maxTotalMB": 1024, "maxZipMB": 64 } }
```

## Commands

```sh
npx brighttest builds add build/sample-1.4.0.zip --label "sample 1.4.0" --tag qa
npx brighttest builds list --pinned            # --kind store|instrumented, --tag <t>, --json, --all (warnings)
npx brighttest builds show b3f9a1c0 --json
npx brighttest builds pin b3f9a1c0             # never pruned or removed without --force
npx brighttest builds edit b3f9a1c0 --note "release candidate" --untag qa
npx brighttest builds install b3f9a1c0 --host 192.0.2.5 --as "$BRIGHTTEST_AGENT" --purpose "check rc"
npx brighttest builds install --latest --host 192.0.2.5   # newest "instrument build" build
npx brighttest builds prune --dry-run
```

| Command | Notes |
|---|---|
| `install` | Replaces the dev channel. Takes the [device lease](/guide/device-lease), queues (`--wait`), never bypasses it. Host only from `--host` or `ROKU_HOST` (shell or project `.env`), never the device cache. Password from `ROKU_PASSWORD`, never printed. A zip path is added to the store first. |
| `prune` | Removes least recently used unpinned builds until within `maxCount` and `maxTotalMB`; sweeps orphan files. Runs automatically on record. Never removes pinned builds. |

Exit codes: [CLI reference](/guide/cli-reference#brighttest-builds).

## The Studio Builds page

The store in Studio ([Builds API](/guide/studio#builds-api)).

- Search, filters (kind, source, tag, pinned), sorting. Drop or pick zips to add.
- A selected build shows details and install history; edit label, tags, notes; pin, download, delete.
- **Install** confirms first (it replaces the dev channel; "don't ask again in this browser" box) and uses the device lease.
- One install at a time; a flow run and an install block each other.
- Progress panel with **Cancel**; on success, **Inspect** and **Launch again**.
- No Install in simulator mode.

## Token check

An instrumented package holds a hub token. On a mismatch, State and Network panels will not connect to that build.

- **Studio** compares it with its hub's token in memory (never shown, stored or sent to the browser) and warns. Rebuild with the matching `BRIGHTTEST_HUB_TOKEN`, or install anyway.
- **`brighttest builds install`** reads `BRIGHTTEST_HUB_TOKEN`, then the project `.env`. A mismatch stops with exit 2 and `TOKEN_MISMATCH (<kind>)` before the lease. `--allow-token-mismatch` installs anyway, warning with the kind only. `--json` adds `tokenCheck`.

::: warning
Treat a stored instrumented zip like a credential: do not share or attach it.
:::

## For agents

`builds_list` returns id, title, version, kind, size, date, pinned, tags and last install result; never a host, path, token or hub URL. It cannot install: use `builds install` under the lease, only when a human asked, since it replaces someone's dev channel.

## Related

- [Device lease](/guide/device-lease): how install waits
- [Studio](/guide/studio#builds-api): Builds API

**Full guide:** [Builds](full:/guide/builds) — the original wording.
