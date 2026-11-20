' Every receiver shape the instrument plugin classifies (ADR 0019 Amendment A). Names and shapes are
' deliberate: do not "clean up" these call sites. With url = "" nothing touches the network.

function BTDev_runShapes(url as string) as object
    r = []
    r.push(BTDev_shapeConfirmedLocal(url))
    BTDev_shapeInit()
    r.push(BTDev_shapeConfirmedMember(url))
    r.push(BTDev_shapeConfirmedCopy(url))
    r.push(BTDev_shapeConfirmedInline(url))
    r.push(BTDev_shapeLikelyName(CreateObject("roUrlTransfer"), url))
    r.push(BTDev_typedShape(CreateObject("roUrlTransfer"), url))
    r.push(BTDev_shapeUnknownCall(url))
    r.push(BTDev_shapeUnknownParam(CreateObject("roUrlTransfer"), url))
    r.push(BTDev_shapeExcludedAA(url))
    r.push(BTDev_collectorShape(url))
    r.push(BTDev_shapeIndexed(url))
    r.push(BTDev_shapeBareGetUrl(url))
    return r
end function

function BTDev_finish(x as object, url as string) as string
    BTDev_log("net", "getUrl=" + x.getUrl())
    if url <> ""
        if Left(url, 5) = "https"
            x.setCertificatesFile("common:/certs/ca-bundle.crt")
            x.initClientCertificates()
        end if
        body = x.getToString()
        return "len=" + Len(body).toStr()
    end if
    return "skipped"
end function

' confirmed: local assigned from CreateObject("roUrlTransfer")
function BTDev_shapeConfirmedLocal(url as string) as string
    x = CreateObject("roUrlTransfer")
    x.setUrl(url)
    return BTDev_finish(x, url)
end function

' confirmed: m.<path> chain assigned in another function of the same file
sub BTDev_shapeInit()
    m.xfer = CreateObject("roUrlTransfer")
end sub

function BTDev_shapeConfirmedMember(url as string) as string
    m.xfer.setUrl(url)
    return BTDev_finish(m.xfer, url)
end function

' confirmed: one copy hop
function BTDev_shapeConfirmedCopy(url as string) as string
    a = CreateObject("roUrlTransfer")
    b = a
    b.setUrl(url)
    return BTDev_finish(b, url)
end function

' confirmed: receiver is the CreateObject call itself
function BTDev_shapeConfirmedInline(url as string) as string
    CreateObject("roUrlTransfer").setUrl(url)
    return "inline"
end function

' likely: untyped parameter whose name matches the transfer-name hint
function BTDev_shapeLikelyName(xfer as object, url as string) as string
    xfer.setUrl(url)
    return BTDev_finish(xfer, url)
end function

' unknown: receiver is a call result
function BTDev_getXfer() as object
    return CreateObject("roUrlTransfer")
end function

function BTDev_shapeUnknownCall(url as string) as string
    BTDev_getXfer().setUrl(url)
    return "call-result"
end function

' unknown: untyped parameter with no name hint
function BTDev_shapeUnknownParam(thing as object, url as string) as string
    thing.setUrl(url)
    return BTDev_finish(thing, url)
end function

' excluded: assigned from another class (an AA with its own setUrl member)
function BTDev_shapeExcludedAA(url as string) as string
    cfg = CreateObject("roAssociativeArray")
    cfg.seen = ""
    cfg.setUrl = sub(u as string)
        m.seen = u
    end sub
    cfg.setUrl(url)
    return cfg.seen
end function

' unrewritten candidate: indexed form
function BTDev_shapeIndexed(url as string) as string
    o = { seen: "" }
    o.setUrl = sub(u as string)
        m.seen = u
    end sub
    o["setUrl"](url)
    return o.seen
end function

' unrewritten candidate: getUrl() used as a bare statement (no owner to wrap)
function BTDev_shapeBareGetUrl(url as string) as string
    x = CreateObject("roUrlTransfer")
    x.setUrl(url)
    x.getUrl()
    return "bare-getUrl"
end function
