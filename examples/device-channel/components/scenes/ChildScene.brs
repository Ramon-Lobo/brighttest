' A Scene extending a Scene: on firmware the base init also runs on the derived Scene (TP-INS-14 h).
sub init()
    m.top.initCount = m.top.initCount + 1
    print "BTDEV:init ChildScene count=" + m.top.initCount.toStr()
end sub
