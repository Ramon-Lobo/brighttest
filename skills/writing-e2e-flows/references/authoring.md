# Authoring flows

Three tools take you from a running app to a working flow: `inspect` (see the tree), `record` (capture a
session), and `stamp` (make an un-annotated app selectable).

## `inspect` — see the live tree

Dumps a readable summary of what's on screen: node counts by subtype, the ids present (as `name=`), the
focused node, and sample text. Use it to discover what to target — before and while writing a flow.

```bash
npx brighttest e2e inspect --host <roku-ip> --app dev
```

```
Live tree: 58 nodes, 5 subtypes
  subtypes: Poster×37, Label×10, Button×9, HomeScene×1, Node×1
  ids (name=): homeScreen, settingsTile, searchTab, ...
  focused: Button#settingsTile "Settings"
  sample text: "Home", "Settings", "Search", ...
```

- `Channel not running` → pass `--app dev` to launch first.
- `Limited mode` → set the device to **Permissive** (see the skill's Requirements).

## `inspect <selector>` — one node's full detail + assertions

Pass a selector and `inspect` targets a single node instead of summarizing the tree: it prints **every
field** Roku dumps for that node and generates assertions from its *actual* state. This is the tool for
"the user sees X on screen and wants an assertion for it" — verify the fields, then take the snippet.

```bash
npx brighttest e2e inspect --host <ip> --id playButton    # by built-in id
npx brighttest e2e inspect --host <ip> --text "Play"      # by exact visible text
npx brighttest e2e inspect --host <ip> --subtype Button --index 0   # Nth of a subtype
npx brighttest e2e inspect --host <ip> --focused          # whatever is focused right now
```

Selector flags mirror the flow selectors and combine (AND): `--id`, `--subtype`, `--text`,
`--text-contains`, `--uri`, `--focused`, `--index <n>`.

```
Node  Button #playButton "Play"
  fields (all sgnodes attrs):
    name    = playButton
    text    = Play
    focused = true
    visible = true
    bounds  = {820, 400, 280, 64}
  children: 0
  match: unique (1 node)

  Suggested assertions (copy into a flow):
    - assertVisible: { id: playButton }
    - assertText: { id: playButton, equals: Play }
    - assertFocused: { id: playButton }
```

- **Selector stability is handled for you.** The suggestion uses `id` → `text` → `subtype`; if that still
  matches several nodes, it appends `index:` and the `match:` line reports the count — so you can confirm
  you're asserting on the right one.
- **Which assertions appear** depends on the node: `assertVisible` always; `assertText` when it has text
  (its current text becomes `equals:`); `assertFocused` when it's focused.
- **Any field in the dump is assertable.** Beyond the suggested snippets, take any line under *fields* and
  assert it with `assertField: { …selector, field: <name>, equals|contains: … }` — see the
  [flow reference](flow-reference.md).
- **The `children:` line** reports the node's child count (direct, plus the total descendant count when
  they differ) — a quick way to check a row/grid populated.

### Append straight into a flow

```bash
npx brighttest e2e inspect --host <ip> --id playButton --out flows/home.e2e.yaml --assert text
#   → appended to flows/home.e2e.yaml   - assertText: { id: playButton, equals: Play }
```

`--out <file>` appends the chosen assertion (created as a minimal flow if the file is missing). `--assert`
selects the kind: `visible` (default) · `text` · `focused` · `gone` · `field` (with `--field <name>`, which
captures that field's current value as `equals:`). If several nodes match, it appends for
the first and warns — narrow the selector or add `--index` to target another. Appends land at end-of-file,
so the flow's `steps:` block should be the last thing in the file (the normal layout).

## `record` — scaffold a flow interactively

Roku's ECP doesn't stream the physical remote to us, so recording is an **interactive terminal session**:
you press keys on your keyboard, `record` sends the matching ECP keypress live, watches the UI settle, and
transcribes each action into a flow file.

```bash
npx brighttest e2e record --host <roku-ip> --out flows/new.e2e.yaml
```

| Key | Action |
|---|---|
| arrows | D-pad move |
| enter | Select |
| backspace | Back · `h` Home |
| `a` / `v` / `x` | record assertFocused / assertVisible / assertText on the focused node |
| `t` | type text (prompts for a line) |
| `p` | record a screenshot |
| `?` / `q` | help / save & quit |

Repeated presses coalesce (`press: { key: Right, count: 3 }`) and each recorded assertion uses the focused
node's best selector (`id` → `text` → `subtype`). The output is a **starting point** — review and tighten
it (replace raw press chains with `focus:` where it reads better) before committing.

## Making an app selectable — `stamp`

The only reliable named selector is a node's built-in `id`. If your app doesn't set ids, you have three
options:

1. **Use `text` / `subtype` selectors** — zero app changes, but less stable across copy/layout changes.
2. **Add `id`s by hand** to the nodes your flows target — most robust; hand-picked ids always win.
3. **Auto-inject ids at build time with `stamp`** — stamps `id="e2e_<Subtype>_<n>"` onto every id-less node
   in a component's `<children>`, so an un-annotated app becomes fully selectable. Nodes that already have
   an id are left alone; re-running is idempotent.

```bash
# Copy a project, injecting ids on the way, then build/sideload the stamped copy for E2E runs:
npx brighttest e2e stamp ./my-app --out ./my-app-e2e
```

Or use it as a **BrighterScript plugin** in an E2E `bsconfig.json` (it rewrites component XML before parse,
so the compiled output carries the ids):

```json
{ "plugins": ["brighttest/lib/e2e/stamp-ids"] }
```

After stamping, `e2e inspect` shows the injected ids (e.g. `e2e_Label_1`, `e2e_RowList_1`) as `name=`.

**Keep the stamp for E2E builds only.** Injected ids are for tests — stamp a copy/branch so the shipping
build stays untouched, and prefer meaningful hand-written ids for the nodes you assert on most.
