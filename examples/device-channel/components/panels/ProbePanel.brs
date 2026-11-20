' Prints platform-behaviour facts (BTDEV:probe key=value) for BRS-06 / COV-23 style device checks.
' Phases matter: findNode on a detached tree behaves differently inside init, after init, and in a Task.
sub init()
    m.btn = m.top.findNode("probeRun")
    m.btn.observeField("buttonSelected", "onRun")
    m.lines = BTDev_probeAll("init", m.top.getScene(), m.top.findNode("probeHost"))
    for each l in m.lines
        BTDev_log("probe", l)
    end for
    m.pending = true
    m.task = CreateObject("roSGNode", "ProbeTask")
    m.task.observeField("lines", "onTask")
    m.task.control = "RUN"
end sub

sub focusDefault()
    m.btn.setFocus(true)
    if m.pending
        m.pending = false
        publish(BTDev_probeAll("after-init", m.top.getScene(), m.top.findNode("probeHost")))
    end if
end sub

sub onRun()
    publish(BTDev_probeAll("rerun", m.top.getScene(), m.top.findNode("probeHost")))
end sub

sub onTask(event as object)
    publish(event.getData())
end sub

sub publish(lines as object)
    for each l in lines
        m.lines.push(l)
        BTDev_log("probe", l)
    end for
    m.top.findNode("probeText").text = m.lines.join(chr(10))
    m.top.findNode("probeSummary").text = "probes: " + m.lines.count().toStr() + " lines"
end sub
