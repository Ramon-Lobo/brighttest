# Flow reference

A flow is a small YAML file (`*.e2e.yaml`) describing a scripted UI journey. It parses to an internal
step model that the runner executes against the device.

## File shape

```yaml
appId: dev              # channel to launch (default: dev). --app overrides it.
config: { timeout: 8 }  # optional per-flow overrides (currently: timeout, in seconds)
steps:
  - launch
  - assertVisible: { id: homeScreen }
  - ...
```

A step is either a **bare word** (`launch`, `back`, `home`) or a **single-key map** (`press: Select`,
`assertVisible: { id: x }`). Values are scalars or inline maps like `{ id: foo, count: 2 }`, which may
nest. This is a deliberately small YAML subset — anything outside it raises a clear, line-referenced
error rather than being silently misparsed.

## Steps

| Step | Meaning |
|---|---|
| `launch` / `launch: { contentId, mediaType }` | Start the app, optionally deep-linking |
| `press: <Key>` / `press: { key, count }` | One or N keypresses (`Up`/`Down`/`Left`/`Right`/`Select`/`Back`/…) |
| `pressUntil: { key, visible: <selector>, max }` | Repeat a key until a selector appears (e.g. scroll a row) |
| `focus: <selector>` | Arrow-key **path-find** focus onto a node (see below) |
| `text: "hello"` | Type text into the focused field via `Lit_` keypresses |
| `assertVisible: <selector>` | Poll until the selector is present (else fail) |
| `assertGone: <selector>` | Poll until the selector is absent |
| `assertText: { …selector, equals \| contains }` | Assert a node's text |
| `assertFocused: <selector>` | Assert the node currently has focus |
| `waitFor: { …selector, timeout }` | Explicit wait for a selector |
| `screenshot: <name>` | Save a PNG/JPG artifact |
| `back` / `home` | Convenience for `press: Back` / `press: Home` |

Assertions **poll** until satisfied or the step timeout elapses (`config.timeout`, `--timeout`, default
10s), so you rarely need explicit waits — screens are given time to settle. A flow stops at its first
failing step (fail-fast within a flow).

## Selectors

A selector matches nodes in the live tree. Combine keys to narrow (all must hold):

```yaml
{ id: settingsTile }                 # built-in id — the stable, preferred hook (matched as name=)
{ subtype: Poster }                  # node type
{ text: "Play" }                     # exact visible text
{ textContains: "Continue" }         # substring of visible text
{ uri: "pkg:/images/hero.png" }      # image/poster uri
{ subtype: RowList, index: 0 }       # the Nth match (0-based)
```

Extra filters: `visible: true|false`, `focusable: true`, `focused: true`.

::: warning Selectors use `id`, not `testId`
A dedicated `testId` field is **invisible** to `sgnodes` — Roku only dumps a fixed set of built-in
fields, and a node's `id` surfaces there as the `name=` attribute. So the selectable hook is the
built-in **`id`**. If your app has none, use `text`/`subtype`, or auto-inject ids at build time — see
[Authoring flows](/e2e/authoring).
:::

Stability preference: `id` → `text`/`subtype`. Prefer ids for anything you assert on repeatedly.

## Focus navigation

Roku has no tap: "click X" means moving focus to X with the D-pad. `focus: <selector>` runs a bounded,
deterministic loop — read the focused node and the target's geometry, press toward it, wait for the UI to
settle, re-read; back off to the orthogonal axis at an edge; give up with a clear error (and a screenshot)
after `maxPresses`.

```yaml
- focus: { id: settingsTile }              # navigate, then stop (does not Select)
- press: Select
# tune the guard when a grid is large:
- focus: { id: farTile, maxPresses: 40 }
```

Because it drives from wherever focus currently is, lead your flow with a `focus:` to a known anchor
rather than assuming the initial focus position (relaunching a running channel does not reset it).

## Text entry

`text: "…"` types into the **focused** field by sending one `Lit_<char>` keypress per character —
directly, without navigating the on-screen keyboard grid. This works on the standard Roku `Keyboard`
(spaces and punctuation included). Focus the field first:

```yaml
- focus: { id: searchKeyboard }
- press: { key: Backspace, count: 40 }   # clear — a Keyboard persists text across relaunches
- text: "the wire"
- assertText: { id: searchQuery, equals: "the wire" }
```

## A complete example

```yaml
# flows/search.e2e.yaml
appId: dev
config: { timeout: 8 }
steps:
  - launch
  - focus: { id: searchTab }
  - press: Select
  - focus: { id: searchKeyboard }
  - text: "news"
  - assertVisible: { id: searchResults }
  - assertText: { id: firstResultTitle, contains: "News" }
  - screenshot: search-results.png
```
