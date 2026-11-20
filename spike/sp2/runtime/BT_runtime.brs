' SPIKE runtime (SP2). Injected by the plugin as pkg:/source/bt/BT_runtime.brs. Not production code.
function BT_url(u as dynamic) as dynamic
    if type(u) <> "String" and type(u) <> "roString" then return u
    s = u
    if Left(s, 7) = "http://" and Instr(1, s, "/bt/") > 0 and Instr(1, s, "/net/;") > 0 then return s
    print "BT:url " + s
    return "http://127.0.0.1:8790/bt/TOKEN/net/;" + s
end function

function BT_unurl(u as dynamic) as dynamic
    if type(u) <> "String" and type(u) <> "roString" then return u
    p = Instr(1, u, "/net/;")
    if p > 0 then return Mid(u, p + 6)
    return u
end function

sub BT_bootstrap(top as object)
    if not top.isSubtype("Scene") then return
    if top.hasField("__bt_boot") then return
    top.addField("__bt_boot", "boolean", false)
    print "BT:bootstrap " + top.subtype()
end sub

function BT_op(args as dynamic) as dynamic
    return { ok: true }
end function
