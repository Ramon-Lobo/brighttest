sub init()
    m.top.functionName = "fetchHome"
end sub

sub fetchHome()
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(Config_apiBase() + "/home")
    m.top.content = Content_parse(xfer.GetToString())
end sub
