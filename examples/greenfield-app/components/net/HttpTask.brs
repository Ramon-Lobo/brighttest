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
end sub
