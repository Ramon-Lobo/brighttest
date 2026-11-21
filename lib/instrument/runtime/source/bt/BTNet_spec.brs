#if BT_AGENT
' brighttest spec API for network fixtures (NET-N-T6, design network-interception.md 4.4). Headless lanes only: it is
' injected into spec builds when the run uses `net` and never into `instrument build` packages.
' Every call is one bounded request to the loopback hub's /bt/<token>/ctl/net/<op> route (POST, JSON in, JSON out).
' A failed call (no hub, a rejected rule, a timeout) throws a string, so a mis-set rule fails the test loudly.
' This file lives under source/bt/ (never rewritten), so it talks to the real roUrlTransfer.

function BTNet_call(op as string, payload as object) as object
    cfg = BT_config()
    if type(cfg) <> "roAssociativeArray" then throw "BTNet_" + op + ": no brighttest config in this build"
    hub = cfg.hub
    token = cfg.token
    if type(hub) <> "roAssociativeArray" or token = invalid or hub.port = invalid then throw "BTNet_" + op + ": no hub in this build"
    host = hub.host
    if host = invalid or host = "" or LCase(host) = "auto" then throw "BTNet_" + op + ": no hub host in this build"
    mp = CreateObject("roMessagePort")
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(mp)
    x.SetUrl("http://" + host + ":" + hub.port.toStr() + "/bt/" + token + "/ctl/net/" + op)
    x.AddHeader("Content-Type", "application/json")
    x.SetMinimumTransferRate(1, 1)
    if not x.AsyncPostFromString(FormatJson(payload)) then throw "BTNet_" + op + ": could not start the request to the hub"
    clock = CreateObject("roTimespan")
    while true
        left = 5000 - clock.TotalMilliseconds()
        if left < 1 then exit while
        msg = Wait(left, mp)
        if msg = invalid then exit while
        if type(msg) = "roUrlEvent" and msg.GetInt() = 1 then
            j = ParseJson(msg.GetString())
            if msg.GetResponseCode() <> 200 then
                why = "HTTP " + msg.GetResponseCode().toStr()
                if type(j) = "roAssociativeArray" and j.error <> invalid then why = j.error
                throw "BTNet_" + op + ": " + why
            end if
            if type(j) <> "roAssociativeArray" then throw "BTNet_" + op + ": the hub sent an unreadable reply"
            return j
        end if
    end while
    x.AsyncCancel()
    throw "BTNet_" + op + ": the hub did not answer within 5 s"
end function

' Clear the rules added by specs and hide the request log up to now. Config fixtures stay. Call it in setup().
sub BTNet_reset()
    BTNet_call("reset", {})
end sub

' Add a mock rule (first match wins, newest first; config fixtures come after). `rule` is the same object a rules
' file uses: { method, url, status, json | body | file, headers, responses: [...], times, reqHeaders, reqBody }.
sub BTNet_mock(rule as object)
    BTNet_call("mock", rule)
end sub

' Add a fault rule: { url, kind: "timeout" | "reset" | "status", status, holdMs, partialBytes, method, times }.
sub BTNet_fault(rule as object)
    BTNet_call("fault", rule)
end sub

' Load a .har or .rules.json file (path relative to the project root, confined to it) as run-time rules.
sub BTNet_useFixture(path as string)
    BTNet_call("fixture", { path: path })
end sub

' Requests the app made since the last BTNet_reset, as [{ id, method, url, headers, body, status, ms, rule, source,
' error }]. `filter` is optional: { method, url (glob), status }. Headers and bodies are unredacted.
function BTNet_requests(filter = {} as object) as object
    j = BTNet_call("requests", filter)
    if type(j.requests) <> "roArray" then return []
    return j.requests
end function
#end if
