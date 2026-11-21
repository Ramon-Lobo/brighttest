sub s1()
    xs = CreateObject("roUrlTransfer")
    xs.setUrl("http://a.test/s1")
    xs = ""
end sub

sub s2()
    xn = CreateObject("roUrlTransfer")
    xn.setUrl("http://a.test/s2")
    xn = 0
end sub

sub s3()
    ok = CreateObject("roUrlTransfer")
    ok.setUrl("http://a.test/s3")
    ok = true
end sub

sub s4()
    only = ""
    only.setUrl("http://a.test/s4")
end sub
