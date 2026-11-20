sub fetchIt(x as object, host as string)
    x.setUrl("https://" + host + "/a")
    x.SETURL("https://" + host + "/multi" + "?q=1")
    if x.getUrl() = "" then print "empty"
    print "u=" + x.GetUrl()
    y = { a: x.getUrl() }
    print y.a
end sub

function lastUrl(x as object) as string
    return x.getUrl()
end function

function noRewrite(o as object) as dynamic
    o.setUrl("a", "b")
    z = o.getUrl("x")
    return z
end function
