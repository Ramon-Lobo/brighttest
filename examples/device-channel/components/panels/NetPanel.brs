sub init()
    m.btn = m.top.findNode("netRun")
    m.btn.observeField("buttonSelected", "onRun")
end sub

sub focusDefault()
    m.btn.setFocus(true)
end sub

sub onRun()
    m.task = CreateObject("roSGNode", "NetTask")
    m.task.url = m.global.netUrl
    m.task.observeField("summary", "onDone")
    m.top.findNode("netStatus").text = "status: running"
    m.task.control = "RUN"
end sub

sub onDone(event as object)
    m.top.findNode("netStatus").text = "status: " + event.getData()
end sub
