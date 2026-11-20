sub c1()
    x1 = CreateObject("roUrlTransfer")
    x1.setUrl("http://a.test/1")
    print x1.getUrl()
    x1.setUrl("http://a.test/1", "extra")
    z = x1.getUrl("arg")
end sub

sub c2()
    x2 = CreateObject("ROURLTRANSFER")
    x2.setUrl("http://a.test/2")
    CreateObject("roUrlTransfer").setUrl("http://a.test/2b")
end sub

sub initM()
    m.xm = CreateObject("roUrlTransfer")
    m.top.xt = CreateObject("roUrlTransfer")
end sub

sub useM()
    m.xm.setUrl("http://a.test/3")
    m.top.xt.setUrl("http://a.test/3b")
    print m.xm.getUrl()
end sub

sub c4()
    a4 = CreateObject("roUrlTransfer")
    b4 = a4
    b4.setUrl("http://a.test/4")
    h1 = CreateObject("roUrlTransfer")
    h2 = h1
    h3 = h2
    h3.setUrl("http://a.test/4b")
end sub

sub c5(xfer, p)
    xfer.setUrl("http://a.test/5")
    p.setUrl("http://a.test/5b")
    print p.getUrl()
end sub

sub c6()
    getXfer().setUrl("http://a.test/6")
end sub

function getXfer() as object
    return CreateObject("roUrlTransfer")
end function

sub c7()
    o7 = {}
    o7.setUrl = sub(u)
        print u
    end sub
    o7.setUrl("http://a.test/7")
    print o7.getUrl()
    m.top.setUrl("http://a.test/7b")
    m.global.setUrl("http://a.test/7c")
end sub

sub c8(flag)
    z8 = CreateObject("roUrlTransfer")
    if flag then z8 = CreateObject("roAssociativeArray")
    z8.setUrl("http://a.test/8")
end sub

sub c12()
    fscope = {}
    fscope.setUrl("http://a.test/12")
end sub
