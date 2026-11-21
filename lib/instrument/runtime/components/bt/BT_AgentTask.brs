#if BT_AGENT
' brighttest instrument runtime: sampling Task (STA-S-T1). v0 emits a tick every `interval` ms; the render-thread agent
' does the reading. The hub hello and long-poll (app-state-devtools.md 4.6) are not part of v0.
sub init()
    m.top.functionName = "BT_agentTaskRun"
end sub

sub BT_agentTaskRun()
    port = CreateObject("roMessagePort")
    n = 0
    while true
        wait(m.top.interval, port)
        n = n + 1
        m.top.tick = n
    end while
end sub
#end if
