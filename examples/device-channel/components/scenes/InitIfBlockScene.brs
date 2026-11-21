' init starts with a block if (ADR 0019 Amendment C, TP-INS-14 g / TP-INS-22).
sub init()
    if m.top.id = "" then
        print "BTDEV:init InitIfBlockScene"
    end if
    m.top.initRan = true
end sub
