sub init()
    m.buttons = m.top.findNode("taskButtons")
    m.buttons.observeField("buttonSelected", "onButton")
end sub

sub focusDefault()
    m.buttons.setFocus(true)
end sub

sub onButton(event as object)
    id = m.buttons.getChild(event.getData()).id
    if id = "runTask"
        m.task = CreateObject("roSGNode", "CounterTask")
        m.task.input = 1000
        m.task.observeField("output", "onTask")
        m.task.control = "RUN"
    else if id = "callStore"
        n = m.top.findNode("store").callFunc("bump")
        m.global.counter = n
        m.top.findNode("storeResult").text = "store: " + n.toStr()
        BTDev_log("task", "store.bump=" + n.toStr())
    else if id = "callLeaf"
        r = m.top.findNode("leaf").callFunc("leafOp")
        m.top.findNode("leafResult").text = "leaf: " + r
        BTDev_log("task", "leaf=" + r)
    end if
end sub

sub onTask(event as object)
    t = m.task
    m.top.findNode("taskResult").text = "task: " + event.getData().toStr() + " thread=" + t.threadName
    BTDev_log("task", "counter output=" + event.getData().toStr() + " thread=" + t.threadName)
end sub
