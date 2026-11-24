sub init()
    m.a = m.top.createChild("CycleA")
    m.a.callFunc("ping")
end sub

sub pong()
    print Dup_name()
end sub
