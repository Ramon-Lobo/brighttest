#if BT_AGENT
' brighttest instrument runtime: agent write path (STA-S-T6, app-state-devtools.md 4.4 and 4.6).
' Two halves share this file. The apply half (BT_wApply, BT_wHandle) runs on the render thread; the transport half
' (BT_wHello, BT_wPollStart, BT_wPostEvents, BT_wParsePoll) runs in BT_AgentTask. Neither half touches `m`: callers pass
' a context { global, scene, cfg, state } so the same code runs headless (brs-cli) and on a device.
'
' Allow-list (design D8): ping, get, set, merge, snapshot, restore, registry.read, registry.write, callFunc, subscribe.
' dispatch and focus are allowed hub-side but answer "not supported" until STA-S-T10. Anything else answers
' "op not allowed". Writes are type-checked (a string into an integer field is refused, the app keeps running), never go
' below a node reference, and registry writes are limited to the configured registrySections and flushed. There is no op
' for the file system and none that deletes registry data. callFunc runs only names listed in the config's callFuncAllow.
' Payloads over 64 KB (command args, results) answer a typed STATE_TOO_LARGE error and are never truncated.
' Every ack is { v, kind:"cmd.ack", session, data: { id, seq, phase, ok, error?, result? } } with phase received, applied
' or reflected; errors read "<CODE>: <message>".

function BT_wMaxBytes() as integer
    return 65536
end function

function BT_wErr(code as string, msg as string) as object
    return { ok: false, error: code + ": " + msg }
end function

function BT_wKind(v as dynamic) as string
    t = type(v)
    if v = invalid then return "invalid"
    if t = "String" or t = "roString" then return "string"
    if t = "Boolean" or t = "roBoolean" then return "boolean"
    if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return "number"
    if t = "roAssociativeArray" then return "object"
    if t = "roArray" or t = "roList" then return "array"
    if t = "roSGNode" then return "node"
    return "other"
end function

' Strict equality that never raises on a type mismatch (BrightScript compares only like types).
function BT_wIs(v as dynamic, want as dynamic) as boolean
    if BT_wKind(v) <> BT_wKind(want) then return false
    return v = want
end function

function BT_wIsStr(v as dynamic) as boolean
    return BT_wKind(v) = "string"
end function

function BT_wIsWhole(v as dynamic) as boolean
    t = type(v)
    return t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger"
end function

' New value acceptable over the old one? An unknown old value (invalid) accepts anything. A whole-number field refuses
' a fractional value.
function BT_wMismatch(name as string, old as dynamic, nv as dynamic) as object
    if BT_wKind(old) = "number" and BT_wKind(nv) = "number" then return BT_wErr("TYPE_MISMATCH", name + " holds a whole number; got a fractional value")
    return BT_wErr("TYPE_MISMATCH", name + " holds a " + BT_wKind(old) + "; got a " + BT_wKind(nv))
end function

function BT_wCompat(old as dynamic, nv as dynamic) as boolean
    ok = BT_wKind(old)
    nk = BT_wKind(nv)
    if ok = "invalid" then return nk <> "node" and nk <> "other"
    if nk = "node" or nk = "other" or nk = "invalid" then return false
    if ok <> nk then return false
    if ok = "number" and BT_wIsWhole(old) and not BT_wIsWhole(nv) then
        if nv <> Int(nv) then return false
    end if
    return true
end function

function BT_wSplit(path as dynamic) as object
    out = []
    if not BT_wIsStr(path) then return out
    if path = "" then return out
    for each s in path.split(".")
        out.push(s)
    end for
    return out
end function

function BT_wIsIndex(s as string) as boolean
    if Len(s) = 0 then return false
    for i = 1 to Len(s)
        c = Asc(Mid(s, i, 1))
        if c < 48 or c > 57 then return false
    end for
    return true
end function

' One step down a container: { found, value }.
function BT_wChild(cur as dynamic, seg as string) as object
    k = BT_wKind(cur)
    if k = "object" then
        if cur.doesExist(seg) then return { found: true, value: cur[seg] }
    else if k = "array" and BT_wIsIndex(seg) then
        i = Val(seg)
        if i < cur.count() then return { found: true, value: cur[i] }
    end if
    return { found: false, value: invalid }
end function

function BT_wCfgList(ctx as object, key as string) as object
    cfg = ctx.cfg
    if type(cfg) = "roAssociativeArray" and type(cfg[key]) = "roArray" then return cfg[key]
    return []
end function

function BT_wInList(list as object, name as dynamic) as boolean
    if not BT_wIsStr(name) then return false
    for each item in list
        if BT_wIsStr(item) then
            if LCase(item) = LCase(name) then return true
        end if
    end for
    return false
end function

' ---- layer roots -----------------------------------------------------------------------------------------------------

function BT_wNodeById(ctx as object, sel as dynamic) as dynamic
    if BT_wKind(sel) <> "object" then return invalid
    id = sel.id
    if not BT_wIsStr(id) or id = "" then return invalid
    if type(ctx.scene) <> "roSGNode" then return invalid
    if ctx.scene.id = id then return ctx.scene
    return ctx.scene.findNode(id)
end function

' { ok:true, node, layer } or an error. `registry` is not a node root; callers route it.
function BT_wRoot(args as object, ctx as object) as object
    layer = args.layer
    if layer = invalid then layer = "global"
    if not BT_wIsStr(layer) then return BT_wErr("BAD_LAYER", "layer must be a string")
    if layer = "global" then
        if type(ctx.global) <> "roSGNode" then return BT_wErr("BAD_LAYER", "no global node")
        return { ok: true, node: ctx.global, layer: layer }
    else if layer = "scene" then
        if type(ctx.scene) <> "roSGNode" then return BT_wErr("BAD_LAYER", "no scene node")
        return { ok: true, node: ctx.scene, layer: layer }
    else if layer = "node" then
        n = BT_wNodeById(ctx, args.node)
        if type(n) <> "roSGNode" then return BT_wErr("NODE_NOT_FOUND", "no node with that id")
        return { ok: true, node: n, layer: layer }
    end if
    return BT_wErr("BAD_LAYER", "layer must be global, scene, node or registry")
end function

' ---- registry --------------------------------------------------------------------------------------------------------

function BT_wRegRead(ctx as object, section as dynamic, key as dynamic) as object
    if not BT_wIsStr(section) or not BT_wIsStr(key) or section = "" or key = "" then return BT_wErr("BAD_COMMAND", "section and key must be non-empty strings")
    if not BT_wInList(BT_wCfgList(ctx, "registrySections"), section) then return BT_wErr("REGISTRY_SECTION_NOT_ALLOWED", "section is not in instrument.state.registrySections")
    sec = CreateObject("roRegistrySection", section)
    if sec = invalid or not sec.Exists(key) then return { ok: true, result: { found: false } }
    if BT_isSecretKey(key) then return { ok: true, result: { found: true, value: "<redacted:" + key + ">" } }
    return { ok: true, result: { found: true, value: sec.Read(key) } }
end function

function BT_wRegWrite(ctx as object, section as dynamic, key as dynamic, value as dynamic) as object
    if not BT_wIsStr(section) or not BT_wIsStr(key) or section = "" or key = "" then return BT_wErr("BAD_COMMAND", "section and key must be non-empty strings")
    if not BT_wInList(BT_wCfgList(ctx, "registrySections"), section) then return BT_wErr("REGISTRY_SECTION_NOT_ALLOWED", "section is not in instrument.state.registrySections")
    k = BT_wKind(value)
    if k = "invalid" or k = "node" or k = "other" then return BT_wErr("TYPE_MISMATCH", "registry values are strings, numbers, booleans, arrays or objects")
    text = value
    if k <> "string" then text = FormatJson(value)
    if Len(text) > BT_wMaxBytes() then return BT_wErr("STATE_TOO_LARGE", "registry value is over the 64 KB limit")
    sec = CreateObject("roRegistrySection", section)
    if sec = invalid then return BT_wErr("REGISTRY_UNAVAILABLE", "cannot open the section")
    sec.Write(key, text)
    sec.Flush()
    return { ok: true, result: { section: section, key: key, bytes: Len(text) } }
end function

' ---- get -------------------------------------------------------------------------------------------------------------

function BT_wGet(args as object, ctx as object) as object
    caps = BT_capsFrom(ctx.cfg)
    redact = invalid
    if type(ctx.cfg) = "roAssociativeArray" and type(ctx.cfg.redact) = "roAssociativeArray" then redact = ctx.cfg.redact.paths
    segs = BT_wSplit(args.path)
    trunc = []
    if BT_wIs(args.layer, "registry") then
        if segs.count() = 2 then return BT_wRegRead(ctx, segs[0], segs[1])
        if segs.count() <> 0 and segs.count() <> 1 then return BT_wErr("BAD_PATH", "registry paths are <section> or <section>.<key>")
        regs = BT_registryRaw(ctx.cfg)
        if regs = invalid then return { ok: true, result: { found: false } }
        v = regs
        if segs.count() = 1 then
            r = BT_wChild(regs, segs[0])
            if not r.found then return { ok: true, result: { found: false } }
            v = r.value
        end if
        return BT_wGetDone(BT_serialize(v, caps, "registry", 0, trunc, redact), trunc)
    end if
    root = BT_wRoot(args, ctx)
    if not root.ok then return root
    if segs.count() = 0 then return BT_wGetDone(BT_serialize(BT_nodeFields(root.node), caps, root.layer, 0, trunc, redact), trunc)
    if not root.node.hasField(segs[0]) then return { ok: true, result: { found: false } }
    cur = root.node.getField(segs[0])
    for i = 1 to segs.count() - 1
        if BT_wKind(cur) = "node" then return BT_wErr("PATH_UNDER_NODE", "paths do not cross a node reference; address the node with layer node")
        r = BT_wChild(cur, segs[i])
        if not r.found then return { ok: true, result: { found: false } }
        cur = r.value
    end for
    return BT_wGetDone(BT_serialize(cur, caps, root.layer + "." + args.path, 0, trunc, redact), trunc)
end function

function BT_wGetDone(value as dynamic, trunc as object) as object
    if Len(FormatJson({ value: value })) > BT_wMaxBytes() then return BT_wErr("STATE_TOO_LARGE", "the value is over the 64 KB limit; read a smaller path")
    return { ok: true, result: { found: true, value: value, truncated: trunc } }
end function

' ---- set and merge ---------------------------------------------------------------------------------------------------

' Set `value` at segs (non-empty) under the node field segs[0]. Returns { ok } or an error. A missing leaf is created
' inside an object; a missing top-level field is created on the global node only.
function BT_wSetPath(root as object, segs as object, value as dynamic) as object
    return BT_wSetPathX(root, segs, value, false)
end function

' dry = true runs every check of a real write but changes nothing (used to validate a whole `ops` batch first). A path that
' runs into a missing object in dry mode is accepted: the real write would create it.
function BT_wSetPathX(root as object, segs as object, value as dynamic, dry as boolean) as object
    node = root.node
    name = segs[0]
    k = BT_wKind(value)
    if k = "node" or k = "other" or k = "invalid" then return BT_wErr("TYPE_MISMATCH", "value must be a string, number, boolean, array or object")
    if segs.count() = 1 then
        if node.hasField(name) then
            if not BT_wCompat(node.getField(name), value) then return BT_wMismatch("field " + name, node.getField(name), value)
            if dry then return { ok: true }
            if not node.setField(name, value) then return BT_wErr("SET_FAILED", "the node refused field " + name)
            return { ok: true }
        end if
        if root.layer <> "global" then return BT_wErr("FIELD_NOT_FOUND", "no field " + name + " on that node")
        if dry then return { ok: true }
        fld = {}
        fld[name] = value
        node.addFields(fld)
        return { ok: true }
    end if
    base = invalid
    if node.hasField(name) then
        base = node.getField(name)
    else if root.layer <> "global" then
        return BT_wErr("FIELD_NOT_FOUND", "no field " + name + " on that node")
    else
        base = {}
    end if
    if BT_wKind(base) = "node" then return BT_wErr("PATH_UNDER_NODE", "paths do not cross a node reference; address the node with layer node")
    if BT_wKind(base) <> "object" and BT_wKind(base) <> "array" then return BT_wErr("PATH_NOT_CONTAINER", "field " + name + " is not an object or array")
    cur = base
    for i = 1 to segs.count() - 2
        r = BT_wChild(cur, segs[i])
        if not r.found then
            if BT_wKind(cur) <> "object" then return BT_wErr("BAD_PATH", "no element " + segs[i])
            if dry then return { ok: true }
            cur[segs[i]] = {}
            r = BT_wChild(cur, segs[i])
        end if
        if BT_wKind(r.value) = "node" then return BT_wErr("PATH_UNDER_NODE", "paths do not cross a node reference; address the node with layer node")
        if BT_wKind(r.value) <> "object" and BT_wKind(r.value) <> "array" then return BT_wErr("PATH_NOT_CONTAINER", segs[i] + " is not an object or array")
        cur = r.value
    end for
    last = segs[segs.count() - 1]
    r = BT_wChild(cur, last)
    if r.found then
        if not BT_wCompat(r.value, value) then return BT_wMismatch(last, r.value, value)
    else if BT_wKind(cur) <> "object" then
        return BT_wErr("BAD_PATH", "no element " + last)
    end if
    if dry then return { ok: true }
    if BT_wKind(cur) = "array" then
        cur[Val(last)] = value
    else
        cur[last] = value
    end if
    if not node.setField(name, base) then return BT_wErr("SET_FAILED", "the node refused field " + name)
    return { ok: true }
end function

' `set` with `ops: [{ path, value }, ...]` is one command with one ack. All-or-nothing on validation (design D6: validated
' as a whole): every op's path, value type and node reference is checked against the current state first, and if any op
' fails nothing is applied and the error names the op as ops[N] (0-based). The checks cannot see changes an earlier op of
' the same batch makes (for example op 0 sets `a` to a number and op 1 writes `a.b`); if such an op fails while applying,
' the ops before it stay applied (no rollback, as in D6) and the error says how many were.
function BT_wSetBatch(args as object, ctx as object) as object
    ops = args.ops
    if BT_wKind(ops) <> "array" or ops.count() = 0 then return BT_wErr("BAD_COMMAND", "ops must be a non-empty list of { path, value }")
    if args.doesExist("path") or args.doesExist("value") then return BT_wErr("BAD_COMMAND", "ops cannot be combined with path or value")
    root = BT_wRoot(args, ctx)
    if not root.ok then return root
    all = []
    for i = 0 to ops.count() - 1
        o = ops[i]
        tag = " (ops[" + i.toStr() + "]; nothing was applied)"
        if BT_wKind(o) <> "object" then return BT_wErr("BAD_COMMAND", "each op must be { path, value }" + tag)
        segs = BT_wSplit(o.path)
        if segs.count() = 0 then return BT_wErr("BAD_PATH", "op needs a path" + tag)
        if not o.doesExist("value") then return BT_wErr("BAD_COMMAND", "op needs a value" + tag)
        r = BT_wSetPathX(root, segs, o.value, true)
        if not r.ok then
            r.error = r.error + tag
            return r
        end if
        all.push(segs)
    end for
    for i = 0 to ops.count() - 1
        r = BT_wSetPath(root, all[i], ops[i].value)
        if not r.ok then
            r.error = r.error + " (ops[" + i.toStr() + "]; " + i.toStr() + " op(s) applied before it)"
            return r
        end if
    end for
    return { ok: true, result: { ops: ops.count() } }
end function

function BT_wSet(args as object, ctx as object) as object
    if BT_wIs(args.layer, "registry") then return BT_wErr("BAD_LAYER", "use registry.write for the registry")
    if args.doesExist("ops") then return BT_wSetBatch(args, ctx)
    segs = BT_wSplit(args.path)
    if segs.count() = 0 then return BT_wErr("BAD_PATH", "set needs a path")
    if not args.doesExist("value") then return BT_wErr("BAD_COMMAND", "set needs a value")
    root = BT_wRoot(args, ctx)
    if not root.ok then return root
    r = BT_wSetPath(root, segs, args.value)
    if not r.ok then return r
    return { ok: true, result: { path: args.path } }
end function

function BT_wMerge(args as object, ctx as object) as object
    if BT_wIs(args.layer, "registry") then return BT_wErr("BAD_LAYER", "use registry.write for the registry")
    if BT_wKind(args.value) <> "object" then return BT_wErr("BAD_COMMAND", "merge needs an object value")
    root = BT_wRoot(args, ctx)
    if not root.ok then return root
    prefix = BT_wSplit(args.path)
    n = 0
    for each k in args.value
        segs = []
        for each p in prefix
            segs.push(p)
        end for
        segs.push(k)
        r = BT_wSetPath(root, segs, args.value[k])
        if not r.ok then
            r.error = r.error + " (at key " + k + ", " + n.toStr() + " keys applied before it)"
            return r
        end if
        n = n + 1
    end for
    return { ok: true, result: { merged: n } }
end function

' ---- snapshot and restore --------------------------------------------------------------------------------------------

function BT_wSnapshot(args as object, ctx as object) as object
    trunc = []
    layers = BT_layers(ctx.global, ctx.scene, ctx.cfg, trunc)
    layers.delete("focus")
    if BT_wKind(args.nodes) = "array" then
        caps = BT_capsFrom(ctx.cfg)
        redact = invalid
        if type(ctx.cfg) = "roAssociativeArray" and type(ctx.cfg.redact) = "roAssociativeArray" then redact = ctx.cfg.redact.paths
        nodes = {}
        for each id in args.nodes
            n = BT_wNodeById(ctx, { id: id })
            if type(n) = "roSGNode" then nodes[id] = BT_serialize(BT_nodeFields(n), caps, "node." + id, 0, trunc, redact)
        end for
        layers["node"] = nodes
    end if
    out = { layers: layers, truncated: trunc }
    if Len(FormatJson(out)) > BT_wMaxBytes() then return BT_wErr("STATE_TOO_LARGE", "the snapshot is over the 64 KB limit; nothing was truncated")
    return { ok: true, result: out }
end function

' A serialized value that must not be written back: a cut, a redaction, a node reference or an unsupported type.
function BT_wIsMarker(v as dynamic) as boolean
    k = BT_wKind(v)
    if k = "string" then
        return Left(v, 11) = "$truncated:" or Left(v, 10) = "<redacted:" or Left(v, 6) = "$type:"
    else if k = "object" then
        if v.doesExist("$node") then return true
        for each key in v
            if BT_wIsMarker(v[key]) then return true
        end for
    else if k = "array" then
        for each item in v
            if BT_wIsMarker(item) then return true
        end for
    end if
    return false
end function

' Fields every node has and restore must not write (read-only or identity).
function BT_wBuiltinField(name as string) as boolean
    return BT_wInList(["change", "focusedChild", "focusable", "id"], name)
end function

' Restore writes values back. It is best effort: values that were cut, redacted or are node references are skipped and
' listed; fields added after the snapshot are listed in `added` and left alone (a global field cannot be removed).
function BT_wRestore(args as object, ctx as object) as object
    layers = args.layers
    if BT_wKind(layers) <> "object" then return BT_wErr("BAD_COMMAND", "restore needs layers")
    restored = 0
    skipped = []
    added = []
    if BT_wKind(layers.global) = "object" and type(ctx.global) = "roSGNode" then
        root = { ok: true, node: ctx.global, layer: "global" }
        for each k in layers.global
            v = layers.global[k]
            if BT_wBuiltinField(k) or v = invalid then
                ' not restorable: nothing to write
            else if BT_wIsMarker(v) then
                skipped.push("global." + k + ": cut, redacted or a node reference")
            else
                r = BT_wSetPath(root, [k], v)
                if r.ok then
                    restored = restored + 1
                else
                    skipped.push("global." + k + ": " + r.error)
                end if
            end if
        end for
        for each k in BT_nodeFields(ctx.global)
            if not layers.global.doesExist(k) and not BT_wBuiltinField(k) then added.push("global." + k)
        end for
    end if
    if BT_wKind(layers.node) = "object" then
        for each id in layers.node
            n = BT_wNodeById(ctx, { id: id })
            if type(n) <> "roSGNode" or BT_wKind(layers.node[id]) <> "object" then
                skipped.push("node." + id + ": node not found")
            else
                root = { ok: true, node: n, layer: "node" }
                for each k in layers.node[id]
                    v = layers.node[id][k]
                    if BT_wBuiltinField(k) or v = invalid then
                        ' not restorable: nothing to write
                    else if BT_wIsMarker(v) then
                        skipped.push("node." + id + "." + k + ": cut, redacted or a node reference")
                    else
                        r = BT_wSetPath(root, [k], v)
                        if r.ok then
                            restored = restored + 1
                        else
                            skipped.push("node." + id + "." + k + ": " + r.error)
                        end if
                    end if
                end for
            end if
        end for
    end if
    if BT_wKind(layers.registry) = "object" then
        for each sname in layers.registry
            sec = layers.registry[sname]
            if BT_wKind(sec) = "object" then
                for each k in sec
                    v = sec[k]
                    if BT_wIsMarker(v) then
                        skipped.push("registry." + sname + "." + k + ": cut or redacted")
                    else
                        r = BT_wRegWrite(ctx, sname, k, v)
                        if r.ok then
                            restored = restored + 1
                        else
                            skipped.push("registry." + sname + "." + k + ": " + r.error)
                        end if
                    end if
                end for
                if BT_wInList(BT_wCfgList(ctx, "registrySections"), sname) then
                    live = CreateObject("roRegistrySection", sname)
                    if live <> invalid then
                        for each k in live.GetKeyList()
                            if not sec.doesExist(k) then added.push("registry." + sname + "." + k)
                        end for
                    end if
                end if
            end if
        end for
    end if
    return { ok: true, result: { restored: restored, skipped: skipped, added: added, bestEffort: true } }
end function

' ---- callFunc --------------------------------------------------------------------------------------------------------

function BT_wCallFunc(args as object, ctx as object) as object
    fn = args.fn
    if not BT_wIsStr(fn) or fn = "" then return BT_wErr("BAD_COMMAND", "callFunc needs fn")
    if not BT_wInList(BT_wCfgList(ctx, "callFuncAllow"), fn) then return BT_wErr("CALLFUNC_NOT_ALLOWED", fn + " is not in the callFuncAllow list")
    n = BT_wNodeById(ctx, args.node)
    if type(n) <> "roSGNode" then return BT_wErr("NODE_NOT_FOUND", "no node with that id")
    list = args.args
    a = invalid
    if BT_wKind(list) = "array" and list.count() > 0 then a = list[0]
    out = invalid
    if a = invalid then
        out = n.callFunc(fn)
    else
        out = n.callFunc(fn, a)
    end if
    trunc = []
    return { ok: true, result: { value: BT_serialize(out, BT_capsFrom(ctx.cfg), "callFunc", 0, trunc, invalid) } }
end function

' ---- dispatch --------------------------------------------------------------------------------------------------------

' Apply one command. Returns { ok, result?, error? }. Never raises: a failure inside an op becomes an error ack.
function BT_wApply(cmd as dynamic, ctx as object) as object
    if BT_wKind(cmd) <> "object" then return BT_wErr("BAD_COMMAND", "command must be an object")
    op = cmd.op
    args = cmd.args
    if BT_wKind(args) <> "object" then args = {}
    if not BT_wIsStr(op) then return BT_wErr("BAD_COMMAND", "op must be a string")
    known = ["ping", "get", "set", "merge", "snapshot", "restore", "registry.read", "registry.write", "callFunc", "subscribe", "dispatch", "focus"]
    if not BT_wInList(known, op) then return { ok: false, error: "op not allowed: " + op }
    if Len(FormatJson(args)) > BT_wMaxBytes() then return BT_wErr("STATE_TOO_LARGE", "command args are over the 64 KB limit; nothing was applied")
    res = invalid
    try
        if op = "ping" then
            res = { ok: true, result: { pong: true } }
        else if op = "get" then
            res = BT_wGet(args, ctx)
        else if op = "set" then
            res = BT_wSet(args, ctx)
        else if op = "merge" then
            res = BT_wMerge(args, ctx)
        else if op = "snapshot" then
            res = BT_wSnapshot(args, ctx)
        else if op = "restore" then
            res = BT_wRestore(args, ctx)
        else if op = "registry.read" then
            res = BT_wRegRead(ctx, args.section, args.key)
        else if op = "registry.write" then
            res = BT_wRegWrite(ctx, args.section, args.key, args.value)
        else if op = "callFunc" then
            res = BT_wCallFunc(args, ctx)
        else if op = "subscribe" then
            on = true
            if BT_wIs(args.on, false) then on = false
            ctx.state.subscribed = on
            res = { ok: true, result: { subscribed: on } }
        else
            res = BT_wErr("NOT_SUPPORTED", op + " is not supported by this build yet")
        end if
    catch e
        res = BT_wErr("APPLY_FAILED", "the op raised an error; the app keeps running")
    end try
    if res.ok and res.result <> invalid then
        if Len(FormatJson(res.result)) > BT_wMaxBytes() then return BT_wErr("STATE_TOO_LARGE", "the result is over the 64 KB limit; nothing was truncated")
    end if
    return res
end function

' ---- acks ------------------------------------------------------------------------------------------------------------

function BT_wAck(cmd as object, session as string, phase as string, res as dynamic) as string
    data = { id: cmd.id, seq: cmd.seq, phase: phase, ok: true }
    if res <> invalid then
        data.ok = res.ok
        if res.error <> invalid then data.error = res.error
        if res.result <> invalid then data.result = res.result
    end if
    return FormatJson({ v: 1, kind: "cmd.ack", session: session, data: data })
end function

' Handle one command from the hub: the `received` ack, the op, then the `applied` ack. Returns the ack lines in order.
' The caller adds the `reflected` ack (BT_wAck(cmd, session, "reflected", invalid)) after it republished the Label,
' when BT_wIs(cmd.ack, "reflected") and the op succeeded.
function BT_wHandle(cmd as object, ctx as object, session as string) as object
    acks = [BT_wAck(cmd, session, "received", invalid)]
    res = BT_wApply(cmd, ctx)
    acks.push(BT_wAck(cmd, session, "applied", res))
    return { acks: acks, ok: res.ok }
end function

' ---- cadence ---------------------------------------------------------------------------------------------------------

' Sampler period: the configured interval (500 ms by default) while a hub session is live and a client subscribed, or
' whenever there is no hub session (ECP readers need the fresh Label); ten times that (5 s) while a live hub session has
' no subscriber.
function BT_wCadence(cfg as dynamic, subscribed as boolean, hubLive as boolean) as integer
    base = BT_pubIntervalMs(cfg)
    if hubLive and not subscribed then return base * 10
    return base
end function

' ---- transport (BT_AgentTask) ----------------------------------------------------------------------------------------

function BT_wOrigin(cfg as dynamic) as string
    if type(cfg) <> "roAssociativeArray" then return ""
    hub = cfg.hub
    if type(hub) <> "roAssociativeArray" or not BT_wIsStr(cfg.token) then return ""
    if hub.port = invalid or not BT_wIsStr(hub.host) then return ""
    if hub.host = "" or LCase(hub.host) = "auto" then return ""
    return "http://" + hub.host + ":" + hub.port.toStr()
end function

function BT_wUrl(cfg as object, route as string, query as string) as string
    u = BT_wOrigin(cfg) + "/bt/" + cfg.token + "/" + route
    if query <> "" then u = u + "?" + query
    return u
end function

' One bounded hello (at most 1.5 s). Returns the session id or "".
function BT_wHello(cfg as object) as string
    if BT_wOrigin(cfg) = "" then return ""
    mp = CreateObject("roMessagePort")
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(mp)
    x.SetUrl(BT_wUrl(cfg, "hello", ""))
    x.SetMinimumTransferRate(1, 1)
    if not x.AsyncGetToString() then return ""
    clock = CreateObject("roTimespan")
    while true
        left = 1500 - clock.TotalMilliseconds()
        if left < 1 then exit while
        msg = Wait(left, mp)
        if msg = invalid then exit while
        if type(msg) = "roUrlEvent" and msg.GetInt() = 1 then
            if msg.GetResponseCode() <> 200 then return ""
            j = ParseJson(msg.GetString())
            if type(j) <> "roAssociativeArray" then return ""
            if j.active <> true or not BT_wIsStr(j.session) then return ""
            return j.session
        end if
    end while
    x.AsyncCancel()
    return ""
end function

' Start the one outstanding long-poll. Returns the transfer (keep it: its identity matches the roUrlEvent).
function BT_wPollStart(cfg as object, session as string, after as integer, port as object) as object
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(port)
    x.SetUrl(BT_wUrl(cfg, "cmd", "after=" + after.toStr() + "&session=" + session))
    x.SetMinimumTransferRate(1, 40)
    if not x.AsyncGetToString() then return invalid
    return x
end function

' Post ack lines (NDJSON) to the hub. Returns the transfer or invalid.
function BT_wPostEvents(cfg as object, session as string, lines as object, port as object) as object
    body = ""
    for each l in lines
        body = body + l + Chr(10)
    end for
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(port)
    x.SetUrl(BT_wUrl(cfg, "events", "session=" + session))
    x.SetRequest("POST")
    x.AddHeader("content-type", "application/x-ndjson")
    x.SetMinimumTransferRate(1, 10)
    if not x.AsyncPostFromString(body) then return invalid
    return x
end function

' Read a poll answer. Returns { kind, cmds?, session? } with kind: cmds (200), idle (204), resync (409), stop (404 or 423,
' the lease is gone or the token is wrong), error (transport failure or anything else).
function BT_wParsePoll(msg as object) as object
    code = msg.GetResponseCode()
    if code = 200 then
        j = ParseJson(msg.GetString())
        if type(j) = "roArray" then return { kind: "cmds", cmds: j }
        return { kind: "error" }
    else if code = 204 then
        return { kind: "idle" }
    else if code = 409 then
        j = ParseJson(msg.GetString())
        s = ""
        if type(j) = "roAssociativeArray" and BT_wIsStr(j.session) then s = j.session
        return { kind: "resync", session: s }
    else if code = 404 or code = 423 then
        return { kind: "stop" }
    end if
    return { kind: "error" }
end function

' Headless pump (tests and scene lanes without a Task): one long-poll round done synchronously on this thread. Hello when
' there is no session, poll, apply each command in seq order, post the acks (a `reflected` ack after `publish()` when asked).
' `st` carries { session, after } between calls. Returns the number of commands handled, or -1 when the hub said stop.
function BT_wPumpOnce(ctx as object, st as object, waitMs as integer) as integer
    cfg = ctx.cfg
    if st.session = "" then
        st.session = BT_wHello(cfg)
        st.after = 0
        if st.session = "" then return 0
    end if
    port = CreateObject("roMessagePort")
    poll = BT_wPollStart(cfg, st.session, st.after, port)
    if poll = invalid then return 0
    msg = Wait(waitMs, port)
    if type(msg) <> "roUrlEvent" then
        poll.AsyncCancel()
        return 0
    end if
    r = BT_wParsePoll(msg)
    if r.kind = "stop" then return -1
    if r.kind = "resync" then
        st.session = r.session
        st.after = 0
        return 0
    end if
    if r.kind <> "cmds" then return 0
    lines = []
    for each cmd in r.cmds
        if BT_wKind(cmd) = "object" and BT_wKind(cmd.seq) = "number" then
            if cmd.seq > st.after then
                h = BT_wHandle(cmd, ctx, st.session)
                for each a in h.acks
                    lines.push(a)
                end for
                if h.ok and BT_wIs(cmd.ack, "reflected") then lines.push(BT_wAck(cmd, st.session, "reflected", invalid))
                st.after = cmd.seq
            end if
        end if
    end for
    if lines.count() > 0 then
        pp = CreateObject("roMessagePort")
        post = BT_wPostEvents(cfg, st.session, lines, pp)
        if post <> invalid then Wait(3000, pp)
    end if
    return r.cmds.count()
end function
#end if
