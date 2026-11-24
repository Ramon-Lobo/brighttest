sub init()
    m.top.functionName = "execute"
end sub

sub execute()
    req = m.top.request
    url = Http_join(m.top.baseUrl, req.path)
    xfer = CreateObject("roUrlTransfer")
    xfer.setUrl(url)
    m.top.lastUrl = xfer.getUrl()
    if left(url, 5) = "https" then xfer.setCertificatesFile("common:/certs/ca-bundle.crt")
    mode = req.mode
    result = { code: 0, body: "", error: "" }
    if mode = "get"
        result.body = xfer.getToString()
        result.code = 200
    else if mode = "getAsync"
        port = CreateObject("roMessagePort")
        xfer.setMessagePort(port)
        xfer.asyncGetToString()
        msg = wait(10000, port)
        if type(msg) = "roUrlEvent"
            result.code = msg.getResponseCode()
            result.body = msg.getString()
            result.error = msg.getFailureReason()
        else
            result.error = "timeout"
        end if
    else if mode = "post"
        xfer.addHeader("Content-Type", "application/json")
        port = CreateObject("roMessagePort")
        xfer.setMessagePort(port)
        xfer.asyncPostFromString(FormatJson(req.body))
        msg = wait(10000, port)
        if type(msg) = "roUrlEvent"
            result.code = msg.getResponseCode()
            result.body = msg.getString()
            result.error = msg.getFailureReason()
        else
            result.error = "timeout"
        end if
    else if mode = "download"
        port = CreateObject("roMessagePort")
        xfer.setMessagePort(port)
        xfer.asyncGetToFile("tmp:/" + req.file)
        msg = wait(10000, port)
        if type(msg) = "roUrlEvent"
            result.code = msg.getResponseCode()
            result.error = msg.getFailureReason()
        else
            result.error = "timeout"
        end if
    end if
    m.top.result = result
    if m.top.id = "hero" and m.global.hasField("btNetSecrets") and m.global.btNetSecrets = true then sendSecretsProbe()
end sub

' netsecrets=1 only: one extra GET with dummy credential-looking header and query values (see Config_netSecretsRequest).
sub sendSecretsProbe()
    probe = Config_netSecretsRequest()
    xfer = CreateObject("roUrlTransfer")
    xfer.setUrl(Http_join(m.top.baseUrl, probe.path))
    xfer.setHeaders(probe.headers)
    port = CreateObject("roMessagePort")
    xfer.setMessagePort(port)
    xfer.asyncGetToString()
    wait(10000, port)
end sub
