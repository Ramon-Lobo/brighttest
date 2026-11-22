' brighttest-template: BTHttp v1
' Greenfield HTTP helpers for brighttest. Copied into your app by `brighttest init --greenfield`.
' Thin and production-safe: identity behavior unless the agent build (bs_const BT_AGENT=true) rewrites URLs.
'
' Current limitations (recorded scope cut, not yet implemented from the design):
'   - No `#if BT_AGENT` branch: BTHttp_url is the identity function, so nothing is routed through the hub yet.

function BTHttp_url(url as string) as string
    return url
end function

' A real roUrlTransfer with certs set. opts: { headers: {}, port: roMessagePort }
function BTHttp_transfer(url as string, opts = {} as object) as object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(BTHttp_url(url))
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    if opts.headers <> invalid then xfer.SetHeaders(opts.headers)
    if opts.port <> invalid then xfer.SetMessagePort(opts.port)
    return xfer
end function

' Synchronous helper for Tasks. Returns { ok, status, json, error }.
function BTHttp_getJson(url as string, opts = {} as object) as object
    timeoutMs = 8000
    if opts.timeoutMs <> invalid then timeoutMs = opts.timeoutMs
    port = CreateObject("roMessagePort")
    xfer = BTHttp_transfer(url, { headers: opts.headers, port: port })
    res = { ok: false, status: 0, json: invalid, error: "" }
    if not xfer.AsyncGetToString() then
        res.error = "request not started"
        return res
    end if
    msg = Wait(timeoutMs, port)
    if msg = invalid
        xfer.AsyncCancel()
        res.error = "timeout"
        return res
    end if
    res.status = msg.GetResponseCode()
    res.ok = res.status >= 200 and res.status < 300
    if res.ok
        res.json = ParseJson(msg.GetString())
        if res.json = invalid then res.error = "invalid json"
    else
        res.error = msg.GetFailureReason()
    end if
    return res
end function
