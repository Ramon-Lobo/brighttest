# Injected runtime notes

The files under `source/` are concatenated into the staged `source/bt/BT_runtime.brs` and ship to the device (the staged copy has full-line comments and blank lines stripped), so
long explanations live here instead of in the BrightScript (ADR 0020, STA-S-T9). This file is never staged: the plugin
copies named runtime files only.

## Write path (BT_write.brs)

    Two halves share this file. The apply half (BT_wApply, BT_wHandle) runs on the render thread; the transport half
    (BT_wHello, BT_wPollStart, BT_wPostEvents, BT_wParsePoll) runs in BT_AgentTask. Neither half touches `m`: callers pass
    a context { global, scene, cfg, state } so the same code runs headless (brs-cli) and on a device.
    
    Allow-list (design D8): ping, get, set, merge, snapshot, restore, registry.read, registry.write, callFunc, subscribe.
    dispatch and focus are allowed hub-side but answer "not supported" until STA-S-T10. Anything else answers
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

- The `get` on the m, scene, global and node layers redacts when any segment of the path is a secret key, or any prefix matches a redact pattern in dotted form (`m.list.0`) or `[i]` form (`m.list[0]`, numeric segments). The registry layer is unchanged.
- `BT_wClampStep` decides the `agent.rate` event: it fires once when clamping starts and only after a hub session is live (a clamp that starts before hello is held and reported after), then re-arms when the clamp ends.
