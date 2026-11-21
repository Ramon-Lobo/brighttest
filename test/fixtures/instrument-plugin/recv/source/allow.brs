sub d1()
    o10 = {}
    o10.setUrl("http://a.test/10")
    x11 = CreateObject("roUrlTransfer")
    x11.setUrl("http://a.test/11")
    fscope = {}
    fscope.setUrl("http://a.test/12b")
    mockHttp = CreateObject("roUrlTransfer")
    mockHttp.setUrl("http://a.test/13")
end sub
