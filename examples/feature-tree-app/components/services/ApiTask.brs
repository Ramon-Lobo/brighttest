sub init()
    m.top.functionName = "fetchHome"
end sub

sub fetchHome()
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(Config_apiBase() + "/home")
    m.top.content = { items: [] }
end sub
