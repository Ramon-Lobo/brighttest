# Builds

The build store keeps a history of the packages brighttest built or sideloaded, so you can list them, label and pin
them, and put an earlier one back on a device without rebuilding. It is used by `brighttest builds`, by the Studio
Builds page and (read-only) by the `builds_list` [MCP tool](/guide/mcp).

## What gets recorded

- `brighttest instrument build` records its package unless `builds.record` is `false`. `instrument build --sideload`
  and `builds install` append the install result (ok or failed, how, when) to the build's record.
- `builds add <zip>` and a Studio upload add any package. The same bytes are stored once: adding them again only
  adds a source to the existing record.
- A package is inspected without being extracted: its `manifest` (title and version), and whether it carries instrument
  markers (`kind` is `instrumented` or `store`). A zip without a manifest, an unsafe zip, or one over `builds.maxZipMB`
  is refused.

An id is `b` plus 12 hex characters; any unique prefix of 4 or more characters works in every command.

## Where the store lives

`.brighttest/builds` in the project (git-ignore it), or `~/.brighttest/builds` when no `brighttest.json` is found.
`BRIGHTTEST_BUILDS_DIR` (an absolute path), `builds.dir` in `brighttest.json` or `--builds-dir <dir>` for one call
override it. Studio and the CLI share the same store.

```json
{ "builds": { "record": true, "maxCount": 30, "maxTotalMB": 1024, "maxZipMB": 64 } }
```

## Commands

```sh
npx brighttest builds add build/sample-1.4.0.zip --label "sample 1.4.0" --tag qa
npx brighttest builds list --pinned            # --kind store|instrumented, --tag <t>, --json, --all (warnings)
npx brighttest builds show b3f9a1c0 --json
npx brighttest builds pin b3f9a1c0             # a pinned build is never pruned or removed without --force
npx brighttest builds edit b3f9a1c0 --note "release candidate" --untag qa
npx brighttest builds install b3f9a1c0 --host 192.0.2.5 --as "$BRIGHTTEST_AGENT" --purpose "check rc"
npx brighttest builds install --latest --host 192.0.2.5   # newest build made by "instrument build"
npx brighttest builds prune --dry-run
```

- **install** replaces the dev channel on the device. It takes the [device lease](/guide/device-lease) and queues behind
  other users (`--wait`); it never bypasses it. The host comes only from `--host` or `ROKU_HOST` (shell or project
  `.env`), never from the device cache. The dev password comes from `ROKU_PASSWORD` and is never printed. A zip path is
  added to the store first.
- **prune** removes the least recently used unpinned builds until the store is within `maxCount` and `maxTotalMB`, and
  sweeps orphan files. Recording a build prunes automatically. Pinned builds are never removed by prune.
- Exit codes are in the [CLI reference](/guide/cli-reference#brighttest-builds).

## The Studio Builds page

The Builds page lists the store with search, filters (kind, source, tag, pinned) and sorting. Drop zip files on it (or
pick them) to add them. Selecting a build shows its details and install history, and lets you edit the label, tags and
notes, pin, download or delete it. **Install** asks for confirmation, because it replaces the dev channel on the
connected device (a "don't ask again in this browser" box is available), and runs under the same device lease as the
other device pages. One install runs at a time and a flow run blocks it (and the other way round). A progress panel shows the steps, with
**Cancel**; after a success **Inspect** and **Launch again** are offered. Studio does not offer Install in simulator
mode. The routes are listed under [Builds API](/guide/studio#builds-api).

## Token check

An instrumented package contains a hub token. Before installing, Studio compares the token in the package with the
one its own hub uses (in memory, the token is never shown, stored or sent to the browser) and warns on a mismatch,
because the State and Network panels will not connect to that build. Rebuild with the matching
`BRIGHTTEST_HUB_TOKEN`, or install anyway. Treat a stored instrumented zip like a credential: do not share or attach it.

## For agents

The `builds_list` MCP tool returns the records (id, title, version, kind, size, date, pinned, tags, last install result)
and never a host, a path, a token or the hub URL. It cannot install; use `builds install` under the lease, and only when
a human asked for it, since an install replaces someone's dev channel.
