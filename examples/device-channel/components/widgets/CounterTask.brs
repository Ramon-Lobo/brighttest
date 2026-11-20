' Task fixture: records which thread ran it (threadInfo) and returns a computed value.
sub init()
    m.top.functionName = "work"
end sub

sub work()
    total = 0
    for i = 1 to m.top.input
        total = total + i
    end for
    name = "unknown"
    ti = m.top.threadInfo()
    if type(ti) = "roAssociativeArray" and ti.currentThread <> invalid and ti.currentThread.name <> invalid
        name = BTDev_str(ti.currentThread.name)
    end if
    m.top.threadName = name
    BTDev_log("task", "counter work done total=" + total.toStr())
    m.top.output = total
end sub
