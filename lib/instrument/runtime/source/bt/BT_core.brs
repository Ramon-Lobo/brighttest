#if BT_AGENT
' brighttest instrument runtime: state serializer (STA-S-T1, app-state-devtools.md 4.6).
' Pure functions: they take the nodes and caps as arguments and never touch `m`, so the same code runs headless (brs-cli)
' and on a device. Output is deterministic (keys sorted) and bounded:
'   - containers deeper than caps.depth become "$truncated:depth"; arrays keep caps.arrayItems items;
'     strings keep caps.stringBytes characters (the JSON output is ASCII, so characters = bytes after FormatJson);
'   - nodes become {"$node": id, "subtype": type}; functions and other objects become "$type:<name>";
'   - keys that look secret (token, password, ...) and configured redact paths become "<redacted:key>";
'   - the whole document is cut to maxBytes by replacing the largest top-level entries with "$truncated:bytes".
' Every cut is recorded in the truncated list as "<path>:<kind>" (kind depth, items, string, bytes), at most 200 entries.
' Read-only: nothing here writes a field, the registry or a node.

function BT_capsDefault() as object
    return { depth: 6, arrayItems: 50, stringBytes: 2048 }
end function

function BT_capsFrom(cfg as dynamic) as object
    caps = BT_capsDefault()
    if type(cfg) = "roAssociativeArray" and type(cfg.caps) = "roAssociativeArray" then
        for each k in caps
            v = cfg.caps[k]
            if v <> invalid and (type(v) = "Integer" or type(v) = "roInt" or type(v) = "roInteger") and v > 0 then caps[k] = v
        end for
    end if
    return caps
end function

function BT_pubInt(cfg as dynamic, key as string, def as integer, lo as integer, hi as integer) as integer
    if type(cfg) = "roAssociativeArray" and type(cfg.publish) = "roAssociativeArray" then
        v = cfg.publish[key]
        if v <> invalid and (type(v) = "Integer" or type(v) = "roInt" or type(v) = "roInteger") and v >= lo and v <= hi then return v
    end if
    return def
end function

function BT_pubMaxBytes(cfg as dynamic) as integer
    return BT_pubInt(cfg, "maxBytes", 65536, 1024, 1048576)
end function

function BT_pubIntervalMs(cfg as dynamic) as integer
    return BT_pubInt(cfg, "intervalMs", 500, 100, 60000)
end function

sub BT_mark(trunc as object, path as string, kind as string)
    n = trunc.count()
    if n < 200 then
        trunc.push(path + ":" + kind)
    else if n = 200 then
        trunc.push("...")
    end if
end sub

function BT_isSecretKey(key as string) as boolean
    k = LCase(key)
    for each frag in ["token", "password", "passwd", "secret", "sessionid", "authorization", "apikey", "api_key"]
        if Instr(1, k, frag) > 0 then return true
    end for
    return false
end function

' Pattern forms: "a.b.c" (exact) and "a.b.*" (everything below a.b). Case-insensitive.
function BT_redactMatch(path as string, patterns as dynamic) as boolean
    if type(patterns) <> "roArray" then return false
    p = LCase(path)
    for each pat in patterns
        if type(pat) = "String" or type(pat) = "roString" then
            q = LCase(pat)
            if Right(q, 2) = ".*" then
                if Left(p, Len(q) - 1) = Left(q, Len(q) - 1) then return true
            else if p = q then
                return true
            end if
        end if
    end for
    return false
end function

function BT_serialize(v as dynamic, caps as object, path as string, depth as integer, trunc as object, redact as dynamic) as dynamic
    t = type(v)
    if v = invalid then return invalid
    if t = "roAssociativeArray" then
        if depth >= caps.depth then
            BT_mark(trunc, path, "depth")
            return "$truncated:depth"
        end if
        keys = []
        for each k in v
            keys.push(k)
        end for
        keys.sort()
        out = {}
        for each k in keys
            kp = path + "." + k
            if BT_isSecretKey(k) or BT_redactMatch(kp, redact) then
                out[k] = "<redacted:" + k + ">"
            else
                out[k] = BT_serialize(v[k], caps, kp, depth + 1, trunc, redact)
            end if
        end for
        return out
    else if t = "roArray" or t = "roList" then
        if depth >= caps.depth then
            BT_mark(trunc, path, "depth")
            return "$truncated:depth"
        end if
        out = []
        i = 0
        for each item in v
            if i >= caps.arrayItems then
                BT_mark(trunc, path, "items")
                exit for
            end if
            out.push(BT_serialize(item, caps, path + "[" + i.toStr() + "]", depth + 1, trunc, redact))
            i = i + 1
        end for
        return out
    else if t = "roSGNode" then
        return { "$node": v.id, "subtype": v.subtype() }
    else if t = "String" or t = "roString" then
        if Len(v) > caps.stringBytes then
            BT_mark(trunc, path, "string")
            return Left(v, caps.stringBytes)
        end if
        return v
    else if t = "Boolean" or t = "roBoolean" then
        return v
    else if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" then
        return v
    else if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then
        if v <> v then return "$type:" + t
        return v
    end if
    return "$type:" + t
end function

' Fields of a node as a serializable AA; an object without getFields yields {}.
function BT_nodeFields(node as dynamic) as object
    if type(node) = "roSGNode" then
        flds = node.getFields()
        if type(flds) = "roAssociativeArray" then return flds
    end if
    return {}
end function

' Focus chain as a path of node ids from the scene down to the focused leaf ("" for an unnamed node).
function BT_focusChain(scene as dynamic) as object
    chain = []
    n = scene
    guard = 0
    while type(n) = "roSGNode" and guard < 32
        chain.push({ "id": n.id, "subtype": n.subtype() })
        c = n.focusedChild
        if type(c) <> "roSGNode" then exit while
        if c.isSameNode(n) then exit while
        n = c
        guard = guard + 1
    end while
    return chain
end function

' Replaces top-level entries of every layer, largest first, until the document fits maxBytes.
function BT_fit(doc as object, maxBytes as integer) as string
    json = FormatJson(doc)
    if Len(json) <= maxBytes then return json
    sizes = []
    for each lname in doc.snapshot.layers
        layer = doc.snapshot.layers[lname]
        if type(layer) = "roAssociativeArray" then
            for each k in layer
                sizes.push({ layer: lname, key: k, size: Len(FormatJson(layer[k])) })
            end for
        end if
    end for
    sizes.sortBy("size", "r")
    for each s in sizes
        if Len(json) <= maxBytes then exit for
        doc.snapshot.layers[s.layer][s.key] = "$truncated:bytes"
        BT_mark(doc.truncated, s.layer + "." + s.key, "bytes")
        json = FormatJson(doc)
    end for
    if Len(json) > maxBytes then
        doc.snapshot = { layers: {} }
        doc.truncated = ["*:bytes"]
        json = FormatJson(doc)
    end if
    return json
end function

' Registry layer (STA-S-T1b): the configured sections (cfg.registrySections) read as {section: {key: value}},
' so assertState reaches a value with the dotted path "registry.<section>.<key>" (the reader splits paths on dots). A value that
' parses as JSON is kept structured, anything else stays a string. Read-only (GetKeyList/Read only). No sections = invalid,
' and the layer is then not published. Redaction and caps are applied by BT_serialize on the path "registry.<section>.<key>".
function BT_registryRaw(cfg as dynamic) as dynamic
    if type(cfg) <> "roAssociativeArray" or type(cfg.registrySections) <> "roArray" then return invalid
    if cfg.registrySections.count() = 0 then return invalid
    out = {}
    for each name in cfg.registrySections
        if type(name) = "String" or type(name) = "roString" then
            sec = CreateObject("roRegistrySection", name)
            if sec <> invalid then
                out[name] = {}
                keys = sec.GetKeyList()
                if type(keys) = "roArray" or type(keys) = "roList" then
                    for each k in keys
                        raw = sec.Read(k)
                        parsed = invalid
                        ' only values shaped like JSON containers are parsed: ParseJson logs the offending text on failure
                        if (type(raw) = "String" or type(raw) = "roString") and (Left(raw, 1) = "{" or Left(raw, 1) = "[") then parsed = ParseJson(raw)
                        if parsed <> invalid then
                            out[name][k] = parsed
                        else
                            out[name][k] = raw
                        end if
                    end for
                end if
            end if
        end if
    end for
    return out
end function

' The layers published and snapshotted: {global, scene, focus, registry?}. `trunc` collects every cut.
function BT_layers(globalNode as dynamic, scene as dynamic, cfg as dynamic, trunc as object) as object
    caps = BT_capsFrom(cfg)
    redact = invalid
    if type(cfg) = "roAssociativeArray" and type(cfg.redact) = "roAssociativeArray" then redact = cfg.redact.paths
    layers = {}
    layers["focus"] = BT_serialize(BT_focusChain(scene), caps, "focus", 0, trunc, redact)
    layers["global"] = BT_serialize(BT_nodeFields(globalNode), caps, "global", 0, trunc, redact)
    layers["scene"] = BT_serialize(BT_nodeFields(scene), caps, "scene", 0, trunc, redact)
    reg = BT_registryRaw(cfg)
    if reg <> invalid then layers["registry"] = BT_serialize(reg, caps, "registry", 0, trunc, redact)
    return layers
end function

' The published document: {v, seq, instrumented, thread, renderMs, snapshot: {layers: {global, scene, focus, registry?}}, truncated}.
function BT_labelJson(seq as integer, globalNode as dynamic, scene as dynamic, cfg as dynamic, renderMs as integer, lastInput = invalid as dynamic) as string
    trunc = []
    layers = BT_layers(globalNode, scene, cfg, trunc)
    doc = { v: 1, seq: seq, instrumented: true, thread: "render", renderMs: renderMs, snapshot: { layers: layers }, truncated: trunc }
    if type(lastInput) = "roAssociativeArray" then doc.input = lastInput ' STA-S-T13: last ECP /input mailbox result { id, phase, ok }
    return BT_fit(doc, BT_pubMaxBytes(cfg))
end function
#end if
