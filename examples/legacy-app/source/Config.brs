' Plain legacy-style helpers: global functions, string concatenation, no namespaces.
function Config_get() as object
    return {
        baseUrl: "http://127.0.0.1:8787"
        apiPath: "api"
        version: "v2"
        netDiagUrl: "http://127.0.0.1:8787/status/503"
        renderThreadSync: false
    }
end function

function Config_registrySections() as object
    return ["legacy_prefs", "legacy_session"]
end function

function Util_buildUrl(cfg as object, kind as string, id as string) as string
    url = cfg.baseUrl + "/" + cfg.apiPath + "/" + cfg.version + "/" + kind
    if id <> "" then url = url + "/" + id
    return url
end function

function Util_countKeys(aa as object) as integer
    if type(aa) <> "roAssociativeArray" then return 0
    n = 0
    for each k in aa
        n = n + 1
        if type(aa[k]) = "roAssociativeArray" then n = n + Util_countKeys(aa[k])
    end for
    return n
end function

' Hand-rolled serializer with redaction of obviously secret keys.
function Util_serialize(value as dynamic, depth = 0 as integer) as string
    t = type(value)
    if depth > 6 then return "..."
    if t = "roAssociativeArray"
        parts = []
        keys = value.keys()
        keys.sort()
        for each k in keys
            v = "<redacted>"
            lk = lcase(k)
            if lk <> "authtoken" and lk <> "sessionid" and lk <> "password" then v = Util_serialize(value[k], depth + 1)
            parts.push(k + ":" + v)
        end for
        return "{" + parts.join(",") + "}"
    else if t = "roArray"
        if value.count() > 50 then return "[array:" + value.count().toStr() + "]"
        parts = []
        for each item in value
            parts.push(Util_serialize(item, depth + 1))
        end for
        return "[" + parts.join(",") + "]"
    else if t = "roString" or t = "String"
        if value.len() > 2048 then return "<string:" + value.len().toStr() + ">"
        return chr(34) + value + chr(34)
    else if t = "roSGNode"
        return "<node:" + value.subtype() + ">"
    else if t = "roInt" or t = "roInteger" or t = "Integer" or t = "roBoolean" or t = "Boolean" or t = "roFloat" or t = "Float"
        return value.toStr()
    end if
    return "<" + t + ">"
end function

' Deliberately faulty: used by the induced-crash spec. Call site spans several lines on purpose.
function Legacy_explode(a as object, b as object) as integer
    return a.count + b.missing.count
end function

' Pure launch-param parsing for the stress knobs. Unknown or out-of-range values fall back to the defaults.
function Legacy_stressArgs(args as dynamic) as object
    out = { stress: false, stressKb: 256, stressFields: 500, stressTree: "both" }
    if type(args) <> "roAssociativeArray" then return out
    if args.stress <> invalid then out.stress = true
    if args.stresskb <> invalid
        kb = Val(args.stresskb)
        if kb = 1 or kb = 16 or kb = 64 or kb = 256 then out.stressKb = Int(kb)
    end if
    if args.stressfields <> invalid
        nf = Val(args.stressfields)
        if nf = 100 or nf = 500 or nf = 1000 then out.stressFields = Int(nf)
    end if
    if args.stresstree <> invalid
        st = LCase(args.stresstree)
        if st = "1500" or st = "6000" or st = "both" then out.stressTree = st
    end if
    return out
end function
