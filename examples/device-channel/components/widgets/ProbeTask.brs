sub init()
    m.top.functionName = "doWork"
end sub

sub doWork()
    lines = []
    lines.append(BTDev_probeFindNode("task"))
    lines.append(BTDev_probeAAOrder("task"))
    m.top.lines = lines
end sub
