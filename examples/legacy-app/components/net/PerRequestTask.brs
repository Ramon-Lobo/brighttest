sub init()
    m.top.functionName = "go"
end sub

sub go()
    print "BTFIX:per-request-start"
    ' (a) roUrlTransfer created per request inside a short-lived Task
    x = CreateObject("roUrlTransfer")
    x.setUrl(m.top.url)
    if m.top.kind = "diag"
        x.setCertificatesFile("pkg:/certs/custom-ca.pem")
        port = CreateObject("roMessagePort")
        x.setMessagePort(port)
        x.asyncGetToString()
        msg = wait(8000, port)
        code = 0
        reason = ""
        got = "no"
        if type(msg) = "roUrlEvent"
            got = "yes"
            code = msg.getResponseCode()
            reason = msg.getFailureReason()
        end if
        m.top.summary = "code=" + code.toStr() + " reason=" + reason + " event=" + got
    else
        x.setCertificatesFile("common:/certs/ca-bundle.crt")
        body = x.getToString()
        print "BTFIX:per-request-done len=" + body.len().toStr()
    end if
end sub
