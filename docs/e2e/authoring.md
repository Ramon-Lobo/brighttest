# Authoring flows

Three tools help you go from a running app to a working flow: `inspect` (see the tree), `record`
(capture a session), and `stamp` (make an un-annotated app selectable).

## `inspect` — see the live tree

Dumps a readable summary of what's on screen: node counts by subtype, the ids present (as `name=`), the
focused node, and sample text. Use it to discover what to target.

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

If it reports `Channel not running`, pass `--app dev` to launch first. If it reports `Limited mode`, set
the device to **Permissive** (see [Overview](/e2e/)).

## `record` — scaffold a flow interactively

Roku's ECP doesn't stream the physical remote to us, so recording is an **interactive terminal session**:
you press keys on your keyboard, `record` sends the matching ECP keypress live, watches the UI settle, and
transcribes each action into a flow file. Assertions and text are added with command keys.

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

Repeated presses coalesce (`press: { key: Right, count: 3 }`) and each recorded assertion uses the
focused node's best selector (`id` → `text` → `subtype`). The output is a **starting point** — review and
tighten it (replace raw press chains with `focus:` where it reads better) before committing.

## Making an app selectable — `stamp`

The only reliable named selector is a node's built-in `id`. If your app doesn't set ids, you have three
options:

1. **Use `text` / `subtype` selectors** — works with zero app changes, but is less stable across copy
   and layout changes.
2. **Add `id`s by hand** to the nodes your flows target — the most robust, and hand-picked ids always win.
3. **Auto-inject ids at build time** with `stamp` — stamps `id="e2e_<Subtype>_<n>"` onto every id-less
   node in a component's `<children>`, so an un-annotated app becomes fully selectable. Nodes that already
   have an id are left alone; re-running is idempotent.

```bash
# Copy a project, injecting ids on the way, and build/sideload the stamped copy for your E2E runs:
npx brighttest e2e stamp ./my-app --out ./my-app-e2e
```

Or use it as a **BrighterScript plugin** in an E2E `bsconfig.json` (it rewrites component XML before
parse, so the compiled output carries the ids):

```json
{
  "plugins": ["brighttest/lib/e2e/stamp-ids"]
}
```

After stamping, `e2e inspect` shows the injected ids (e.g. `e2e_Label_1`, `e2e_RowList_1`) as `name=`,
and you can select them like any other id.

::: tip Keep the stamp for E2E builds only
Injected ids are for tests. Stamp a **copy/branch** of the app for the E2E build so the shipping build
stays untouched — and prefer meaningful hand-written ids for the nodes you assert on most.
:::
