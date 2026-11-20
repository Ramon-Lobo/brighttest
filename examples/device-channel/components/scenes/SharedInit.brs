' One script, two components: SharedScene (a Scene) and SharedGroup (not a Scene). Only the Scene
' should be bootstrapped (TP-INS-14 c/e, TP-INS-20).
sub init()
    print "BTDEV:init shared " + m.top.subtype()
    m.top.initRan = true
end sub
