sub init()
    m.b = m.top.createChild("CycleB")
    m.b.callFunc("pong")
end sub

sub ping()
    print Dup_name()
end sub
