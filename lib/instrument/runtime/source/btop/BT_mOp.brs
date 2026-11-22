#if BT_AGENT
' brighttest instrument runtime: the `m` layer, component side (STA-S-T9, app-state-devtools.md 4.6).

function BT_mBad(seg as string, first as boolean) as boolean
    k = LCase(seg)
    if Left(k, 4) = "__bt" then return true
    return first and (k = "top" or k = "global")
end function

function BT_mOp(mm as object, args as dynamic) as object
    r = { ok: true, btop: true }
    if BT_wKind(args) <> "object" or not BT_wIsStr(args.op) then return r
    segs = []
    if BT_wKind(args.path) = "array" then segs = args.path
    for i = 0 to segs.count() - 1
        if not BT_wIsStr(segs[i]) then return BT_wErr("BAD_PATH", "path segments must be strings")
        if BT_mBad(segs[i], i = 0) then return BT_wErr("M_PATH_FORBIDDEN", "top, global and __bt keys are not reachable through m")
    end for
    cur = mm
    if args.op = "get" and segs.count() = 0 then
        cur = {}
        for each k in mm
            if not BT_mBad(k, true) then cur[k] = mm[k]
        end for
    end if
    par = invalid
    for i = 0 to segs.count() - 1
        if BT_wKind(cur) = "node" then return BT_wErr("PATH_UNDER_NODE", "paths do not cross a node reference; address the node with layer node")
        c = BT_wChild(cur, segs[i])
        if not c.found then
            if args.op = "set" then return BT_wErr("FIELD_NOT_FOUND", "m has no existing field " + segs[i])
            r.found = false
            return r
        end if
        par = cur
        cur = c.value
    end for
    if args.op = "get" then
        r.found = true
        r.value = cur
    else if args.op = "set" then
        if segs.count() = 0 then return BT_wErr("BAD_PATH", "set needs a path")
        if not BT_wCompat(cur, args.value) then return BT_wMismatch("m." + segs.join("."), cur, args.value)
        if args.dry = true then return r
        if BT_wKind(par) = "array" then
            par[Val(segs[segs.count() - 1])] = args.value
        else
            par[segs[segs.count() - 1]] = args.value
        end if
    end if
    return r
end function
#end if
