sub init()
    m.top.initCount = m.top.initCount + 1
    print "BTDEV:init BaseScene count=" + m.top.initCount.toStr()
    m.top.initRan = true
end sub
