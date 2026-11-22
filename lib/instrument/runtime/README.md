# Injected runtime notes

The files under `source/` are concatenated into the staged `source/bt/BT_runtime.brs` and ship to the device (the staged copy has full-line comments and blank lines stripped), so
long explanations live here instead of in the BrightScript (ADR 0020, STA-S-T9). This file is never staged: the plugin
copies named runtime files only.

## Write path (BT_write.brs)

    Two halves share this file. The apply half (BT_wApply, BT_wHandle) runs on the render thread; the transport half
    (BT_wHello, BT_wPollStart, BT_wPostEvents, BT_wParsePoll) runs in BT_AgentTask. Neither half touches `m`: callers pass
    a context { global, scene, cfg, state } so the same code runs headless (brs-cli) and on a device.
    
    Allow-list (design D8): ping, get, set, merge, snapshot, restore, registry.read, registry.write, callFunc, subscribe.
    focus focuses the node `args.node.id` (NODE_NOT_FOUND otherwise). dispatch is allowed hub-side; its BTStore op is STA-S-T11 (the app-side route is the dispatch wrap below, STA-S-T10). Anything else answers
    "op not allowed". Writes are type-checked (a string into an integer field is refused, the app keeps running), never go
    below a node reference, and registry writes are limited to the configured registrySections and flushed. There is no op
    for the file system and none that deletes registry data. callFunc runs only names listed in the config's callFuncAllow.
    Payloads over 64 KB (command args, results) answer a typed STATE_TOO_LARGE error and are never truncated.
    Every ack is { v, kind:"cmd.ack", session, data: { id, seq, phase, ok, error?, result? } } with phase received, applied
    or reflected; errors read "<CODE>: <message>".

### `set` with `ops`

    `set` with `ops: [{ path, value }, ...]` is one command with one ack. All-or-nothing on validation (design D6: validated
    as a whole): every op's path, value type and node reference is checked against the current state first, and if any op
    fails nothing is applied and the error names the op as ops[N] (0-based). The checks cannot see changes an earlier op of
    the same batch makes (for example op 0 sets `a` to a number and op 1 writes `a.b`); if such an op fails while applying,
    the ops before it stay applied (no rollback, as in D6) and the error says how many were.

## `/input` mailbox (BT_write.brs)

    A command too long for one /input request arrives as chunks: query keys bt (command id), tk (the per-build hub token),
    s (0-based seq), n (total chunks) and d (a slice of the command's JSON text). State `st` is { pending: {}, done: [] }
    (see BT_inputNew). Rules:
     - A chunk whose tk differs from the build token (constant-time compare) is dropped silently: no state, no ack.
     - A command is returned only once every chunk 0..n-1 is present, joined in seq order; a partial one is never returned.
     - A single-chunk command (n=1) completes at once and takes no pending slot.
     - A repeated chunk is ignored (the first data wins); a command id that already completed (last 32 kept) is ignored;
       n changing mid-sequence, s >= n and n above BT_inputMaxChunks are ignored.
     - A sequence is dropped by BT_inputSweep once BT_inputTtlMs passed since its last accepted chunk (sliding window).
     - At most BT_inputMaxPending sequences are kept; a new one evicts the oldest.

## Serializer (BT_core.brs)

    Pure functions: they take the nodes and caps as arguments and never touch `m`, so the same code runs headless (brs-cli)
    and on a device. Output is deterministic (keys sorted) and bounded:
      - containers deeper than caps.depth become "$truncated:depth"; arrays keep caps.arrayItems items;
        strings keep caps.stringBytes characters (the JSON output is ASCII, so characters = bytes after FormatJson);
      - nodes become {"$node": id, "subtype": type}; functions and other objects become "$type:<name>";
      - keys that look secret (token, password, ...) and configured redact paths become "<redacted:key>";
      - the whole document is cut to maxBytes by replacing the largest top-level entries with "$truncated:bytes".
    Every cut is recorded in the truncated list as "<path>:<kind>" (kind depth, items, string, bytes), at most 200 entries.
    Read-only: nothing here writes a field, the registry or a node.

## Network (BT_net.brs)

    BT_url(u) wraps an http(s) URL as <hub netBase><original> once a hub session is live, and is the identity function in
    every other case (non-string, pkg:/ tmp:/ file:/ and other schemes, no hub, URL already on the hub).
    BT_unurl(u) strips the hub prefix again so app code that compares getUrl() keeps working.
    This file lives under source/bt/ (never rewritten), so the SetUrl calls below talk to the real roUrlTransfer.
    
    The first call per thread does one bounded hello (at most 1.5 s). roUrlTransfer has no total timeout on a device
    [DV], so the hello is asynchronous, sets SetMinimumTransferRate and runs its own timer that calls AsyncCancel.
    A failed hello is cached as "no hub" for 30 s, then retried; a successful one is cached for the thread's lifetime.
    The cache is per thread (GetGlobalAA()), so each Task does its own hello. The hub host comes from BT_config().hub.host;
    "auto" means the build did not bake a host, so the build stays inactive (identity).
    CreateObject("roUrlTransfer") returns invalid on the render thread on some firmware [DV fw 16.0.4], so a BT_url call
    from a Scene init before any Task has run gets a failed hello (identity, retried after 30 s) instead of a crash.

## `m` layer (btop/BT_mOp.brs)

    BT_op is the callFunc entry point injected on every instrumented component; it runs in the component's own scope, so `m`
    is that component's `m`. The agent reaches it with node.callFunc("BT_op", { op, path, value }) on the render thread.
    Rules (every one is a refusal, never a crash):
     - get and set only; a missing or unknown op answers { ok:true, btop:true } (the marker the host looks for).
     - `top`, `global` and any `__bt*` key are not reachable; set never creates a key (existing fields only);
     - a path never crosses a node reference (PATH_UNDER_NODE); every write is type-checked with BT_wCompat.
    Redaction, caps and the 64 KB limit are applied by the host (BT_wMGet) on the value this returns.

## Rate cap and m-layer errors

- `BT_wMCall` passes any `{ ok: false, error: <string> }` reply from `BT_mOp` through unchanged (M_PATH_FORBIDDEN, FIELD_NOT_FOUND, TYPE_MISMATCH, PATH_UNDER_NODE, BAD_PATH). `M_NOT_AVAILABLE` is only for a missing `BT_op`, a non-object reply, or an `ok: true` reply without the `btop` marker.
- The publish size that drives the rate cap is `Len(label.text)`, which counts characters, not bytes. The `agent.rate` event reports it as `docChars` and carries the real period in `clampedMs`; it is logged once when clamping starts, not every tick.

- The `get` on the m, scene, global and node layers redacts when any segment of the path is a secret key, or any prefix matches a redact pattern in dotted form (`m.list.0`) or `[i]` form (`m.list[0]`, numeric segments). The registry layer (`get` on `registry.<section>` and `registry.<section>.<key>`, and the `registry.read` op) honours the same rules through `BT_wRedSeg`, matching the section and key segments in dotted and `[i]` form. Known gap: key reads (`registry.read`, `get <section>.<key>`) return the raw stored string, so a JSON value holding nested secrets is not masked, and patterns deeper than the exact key do not apply.
- `BT_wClampStep` decides the `agent.rate` event: it fires once when clamping starts and only after a hub session is live (a clamp that starts before hello is held and reported after), then re-arms when the clamp ends.

## Wrap and task hooks (BT_write.brs, STA-S-T10)

    Both hooks are emitted by the plugin (lib/instrument/wrap.js) around functions the config names; the runtime only holds
    the three helpers. The original function is renamed `__bt_orig_<name>` on its own line and a wrapper with the original
    name is appended to the file, so every caller (including observeField callback names) reaches the wrapper.
    A defaulted parameter keeps its name and default expression in the wrapper signature, so the original default applies
    when the caller omits the argument. A dispatch target used as a value (`{ dispatch: fn }`) is not wrapped (the wrapper
    would lose the AA method `m`); it is reported as `wrap-target-unknown`, as is a `.bs` default that is not a plain literal. `function ... as void` is wrapped like a `sub`.

    `instrument.state.dispatch: ["fn"]` wraps each non-excluded, non-namespaced function with that name. The wrapper takes
    BT_dwHash(m.global) before and after the call (CRC32 of the serialized global fields as JSON, hex; nodes become markers) and calls BT_dwEmit, which sets
    the global string field `__btEv` to { source:"wrap:<fn>", type, payload, hashBefore, hashAfter }. type and payload
    come from the first argument when it is an associative array; the payload is serialized with the configured caps
    (secret-looking keys are masked). The render-thread agent observes `__btEv` and forwards it to the hub as a
    `state.action` event. Any thread may emit: setting a global field is thread-safe.

    `instrument.state.tasks: ["TaskComponent"]` wraps the Task's entry function, found as the string assigned in a
    top-level `m.top.functionName = "<fn>"` of the component's `init`. BT_taskSnap(m.global, name, event, m) stores
    { event, m } (m without top, global and `__bt*`, serialized with the caps) in the global field `__btTask_<name>` at
    "entry" and "exit". BT_layers moves those fields out of the `global` layer into a `task` layer, and drops `__btEv`.
    A timer snapshot is not automatic: a Task blocked in `wait` cannot be interrupted, so an app that wants mid-run
    snapshots calls BT_taskSnap(m.global, "<name>", "timer", m) itself. A name that matches nothing is reported as
    `wrap-target-unknown` (it trips `instrument.strict`).
