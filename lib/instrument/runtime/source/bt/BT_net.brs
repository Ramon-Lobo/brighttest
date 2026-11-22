#if BT_AGENT
' brighttest instrument runtime: network URL rewrite (NET-N-T2, ADR 0017 D5).

function BT_netIsStr(v as dynamic) as boolean
    t = type(v)
    return t = "String" or t = "roString"
end function

function BT_netIsHttp(u as dynamic) as boolean
    if not BT_netIsStr(u) then return false
    l = LCase(Left(u, 8))
    return Left(l, 7) = "http://" or l = "https://"
end function

function BT_netState() as object
    g = GetGlobalAA()
    if g.__btNet = invalid then g.__btNet = { base: "", checked: false, retryAt: 0, clock: CreateObject("roTimespan") }
    return g.__btNet
end function

function BT_netHello() as string
    cfg = BT_config()
    if type(cfg) <> "roAssociativeArray" then return ""
    hub = cfg.hub
    token = cfg.token
    if type(hub) <> "roAssociativeArray" or not BT_netIsStr(token) then return ""
    host = hub.host
    port = hub.port
    if port = invalid or not BT_netIsStr(host) then return ""
    if host = "" or LCase(host) = "auto" then return ""
    origin = "http://" + host + ":" + port.toStr()
    mp = CreateObject("roMessagePort")
    x = CreateObject("roUrlTransfer")
    x.SetMessagePort(mp)
    x.SetUrl(origin + "/bt/" + token + "/hello")
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
            if j.active = invalid or j.netBase = invalid then return ""
            if j.active <> true or not BT_netIsStr(j.netBase) then return ""
            if j.netBase = "" then return ""
            return origin + j.netBase
        end if
    end while
    x.AsyncCancel()
    return ""
end function

' The hub prefix, or "" when no session is live.
function BT_netBase() as string
    st = BT_netState()
    if st.base <> "" then return st.base
    now = st.clock.TotalMilliseconds()
    if st.checked and now < st.retryAt then return ""
    st.checked = true
    st.base = BT_netHello()
    if st.base = "" then st.retryAt = now + 30000
    return st.base
end function

' Observe-only breadcrumb (NET-N-T14), the one place the line format lives: "[bt:net] url=<url>". One line per URL set
' on a transfer. The query, the fragment and any user[:password]@ in the authority are dropped (they may carry
' secrets); a trailing "?" marks that a query was present. Path segments are printed as they are.
function BT_netCrumb(u as string) as string
    crumbUrl = u
    crumbSch = Instr(1, crumbUrl, "://")
    if crumbSch > 0 then
        crumbRest = Mid(crumbUrl, crumbSch + 3)
        ' the authority ends at the first of / ? #
        crumbEnd = Len(crumbRest) + 1
        for each crumbSep in ["/", "?", "#"]
            crumbHit = Instr(1, crumbRest, crumbSep)
            if crumbHit > 0 and crumbHit < crumbEnd then crumbEnd = crumbHit
        end for
        crumbAt = 0
        for crumbIdx = 1 to crumbEnd - 1
            if Mid(crumbRest, crumbIdx, 1) = "@" then crumbAt = crumbIdx
        end for
        if crumbAt > 0 then crumbUrl = Left(crumbUrl, crumbSch + 2) + Mid(crumbRest, crumbAt + 1)
    end if
    crumbPos = Instr(1, crumbUrl, "#")
    if crumbPos > 0 then crumbUrl = Left(crumbUrl, crumbPos - 1)
    crumbQ = ""
    crumbPos = Instr(1, crumbUrl, "?")
    if crumbPos > 0 then
        crumbUrl = Left(crumbUrl, crumbPos - 1)
        crumbQ = "?"
    end if
    return "[bt:net] url=" + crumbUrl + crumbQ
end function

' True when the build was made with instrument.net.observe: BT_url then only prints one breadcrumb per call to 8085 and
' never contacts the hub or rewrites. Cached per thread in BT_netState.
function BT_netObserve() as boolean
    st = BT_netState()
    if st.observe = invalid then
        st.observe = false
        cfg = BT_config()
        if type(cfg) = "roAssociativeArray" then st.observe = (cfg.netObserve = true)
    end if
    return st.observe
end function

function BT_url(u as dynamic) as dynamic
    if not BT_netIsHttp(u) then return u
    if BT_netObserve() then
        print BT_netCrumb(u)
        return u
    end if
    base = BT_netBase()
    if base = "" then return u
    if Left(u, Len(base)) = base then return u
    return base + u
end function

function BT_unurl(u as dynamic) as dynamic
    if not BT_netIsStr(u) then return u
    base = BT_netState().base
    if base <> "" and Left(u, Len(base)) = base then return Mid(u, Len(base) + 1)
    return u
end function
#end if
