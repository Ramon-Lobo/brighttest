sub init()
    m.top.functionName = "loop"
end sub

' (b) long-lived worker: message-port loop serving URLs from the queue field
sub loop()
    port = CreateObject("roMessagePort")
    m.top.observeField("queue", port)
    cls = "roUrlTransfer"
    while true
        msg = wait(0, port)
        if type(msg) = "roSGNodeEvent"
            for each url in msg.getData()
                x = CreateObject(cls)
                x.setCertificatesFile("common:/certs/ca-bundle.crt")
                x.setUrl(url)
                m.top.result = x.getToString()
            end for
        end if
    end while
end sub
