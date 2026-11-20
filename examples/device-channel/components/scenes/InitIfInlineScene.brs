' init starts with a single-line if.
sub init()
    if m.top.id = "" then print "BTDEV:init InitIfInlineScene"
    m.top.initRan = true
end sub
