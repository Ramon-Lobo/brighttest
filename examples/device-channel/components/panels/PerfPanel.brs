' Many nodes + an Animation + a fast Timer, for sgperf / chanperf / Perfetto captures.
sub init()
    n = m.global.perfCount
    g = m.top.findNode("perfGroup")
    for i = 0 to n - 1
        r = CreateObject("roSGNode", "Rectangle")
        r.width = 24
        r.height = 24
        r.color = "0x3355AAFF"
        r.translation = [(i mod 60) * 30, 140 + Int(i / 60) * 30]
        g.appendChild(r)
        if i mod 5 = 0
            l = CreateObject("roSGNode", "Label")
            l.text = i.toStr()
            l.width = 24
            l.translation = [(i mod 60) * 30, 140 + Int(i / 60) * 30]
            g.appendChild(l)
        end if
    end for
    m.top.findNode("perfInfo").text = "nodes: " + g.getChildCount().toStr()
    BTDev_log("perf", "nodes=" + g.getChildCount().toStr())
    m.ticks = 0
    m.timer = m.top.findNode("perfTimer")
    m.timer.observeField("fire", "onTick")
    m.timer.control = "start"
    m.top.findNode("perfAnim").control = "start"
end sub

sub focusDefault()
end sub

sub onTick()
    m.ticks = m.ticks + 1
    m.top.findNode("perfTick").text = "tick: " + m.ticks.toStr()
end sub
