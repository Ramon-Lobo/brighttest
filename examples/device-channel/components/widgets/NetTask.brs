sub init()
    m.top.functionName = "doWork"
end sub

sub doWork()
    results = BTDev_runShapes(m.top.url)
    BTDev_log("net", "shapes=" + results.count().toStr() + " url=" + iif_(m.top.url = "", "(none)", "set"))
    m.top.summary = results.count().toStr() + " shapes, " + iif_(m.top.url = "", "no net_url, no requests", "requests sent")
end sub

function iif_(c as boolean, a as string, b as string) as string
    if c then return a
    return b
end function
