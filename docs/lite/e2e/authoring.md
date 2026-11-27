# Authoring flows

::: info At a glance
**What it is for:** going from a running app to a working flow.

**You will:**
- See the live tree with `inspect`
- Get assertions for one node and append them to a flow
- Record a flow with `record`
- Make an un-annotated app selectable with `stamp`

**First command:** `npx brighttest e2e inspect --host <roku-ip> --app dev`
:::

## `inspect` — see the live tree

Prints node counts by subtype, ids (as `name=`), the focused node and sample text.

```bash
npx brighttest e2e inspect --host <roku-ip> --app dev
```

```
Live tree: 58 nodes, 5 subtypes
  subtypes: Poster×37, Label×10, Button×9, HomeScene×1, Node×1
  ids (name=): homeScreen, settingsTile, searchTab, ...
  focused: Button#settingsTile "Settings"
```

| Message | Fix |
|---|---|
| `Channel not running` | Pass `--app dev` to launch first. |
| `Limited mode` | Set the device to **Permissive** ([Overview](/e2e/)). |

::: warning What the tree does not show
A node created as `Group` is listed as `RenderableNode`: use the subtype names `inspect` prints. Custom fields do not appear in the node query at all (re-confirmed on firmware 16.0.4).
:::

## `inspect <selector>` — one node's full detail + assertions

With a selector, `inspect` prints **every field** Roku dumps for one node, then assertions built from its actual state.

```bash
npx brighttest e2e inspect --host <roku-ip> --id playButton   # or --text "Play", or --focused
```

Selector flags mirror flow selectors and combine (AND): `--id`, `--subtype`, `--text`, `--text-contains`, `--uri`, `--focused`, `--index <n>`.

```
Node  Button #playButton "Play"
  fields (all sgnodes attrs):
    text    = Play
    focused = true
  match: unique (1 node)
  Suggested assertions (copy into a flow):
    - assertVisible: { id: playButton }
    - assertText: { id: playButton, equals: Play }
    - assertFocused: { id: playButton }
```

- **Selector:** picked for stability, `id` → `text` → `subtype`. If it still matches several nodes, `index:` is added and `match:` gives the count.
- **Assertions:** `assertVisible` always; `assertText` when the node has text (becomes `equals:`); `assertFocused` when focused.
- **Other fields:** any field in the dump works with [`assertField`](/e2e/flows#asserting-arbitrary-node-fields).

### Append to a flow

| Flag | Meaning |
|---|---|
| `--out <file>` | Append to this flow (created as a minimal flow if missing). |
| `--assert <kind>` | `visible` (default), `text`, `focused`, `gone`, `field`. |
| `--field <name>` | With `field`: its current value becomes `equals:`. |

```bash
npx brighttest e2e inspect --host <roku-ip> --id playButton --out flows/home.e2e.yaml --assert text
```

::: tip Appends land at end-of-file
Keep `steps:` last in the file (the normal layout). Reorder if you meant the assertion earlier.
:::

## `record` — scaffold a flow interactively

ECP does not stream the physical remote, so you press keyboard keys: `record` sends each ECP keypress live, waits for the UI to settle and writes the action into a flow.

```bash
npx brighttest e2e record --host <roku-ip> --out flows/new.e2e.yaml
```

| Key | Action |
|---|---|
| arrows / enter | D-pad move / Select |
| backspace / `h` | Back / Home |
| `a` / `v` / `x` | assertFocused / assertVisible / assertText on the focused node |
| `t` / `p` | type text (prompts) / screenshot |
| `?` / `q` | help / save & quit |

Repeats coalesce (`press: { key: Right, count: 3 }`); assertions use the best selector (`id` → `text` → `subtype`). Treat the output as a **starting point**: tighten it (for example `focus:` instead of press chains) before committing.

## Making an app selectable — `stamp`

The only reliable named selector is the built-in `id`. Without ids you have three options:

1. **`text` / `subtype` selectors**: no app changes, less stable across copy and layout changes.
2. **Hand-added `id`s**: most robust; hand-picked ids always win.
3. **`stamp`**: adds `id="e2e_<Subtype>_<n>"` to every id-less node in a component's `<children>`. Existing ids are kept; re-running is idempotent.

::: code-group
```bash [CLI copy]
npx brighttest e2e stamp ./my-app --out ./my-app-e2e
```
```json [BrighterScript plugin]
{ "plugins": ["brighttest/lib/e2e/stamp-ids"] }
```
:::

The CLI copies the project with ids injected; build and sideload that copy. The plugin (in an E2E `bsconfig.json`) rewrites component XML before parse. `inspect` then shows ids such as `e2e_Label_1` as `name=`.

::: tip Keep the stamp for E2E builds only
Stamp a **copy/branch** so the shipping build stays untouched, and prefer meaningful hand-written ids for nodes you assert on most.
:::

## Related

- [Flows reference](/e2e/flows): steps, selectors, `assertField`
- [Scaling & CI](/e2e/scaling): screenshots, devices, JUnit

**Full guide:** [Authoring flows](full:/e2e/authoring) — the original wording.
