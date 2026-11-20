sub init()
    m.buttons = m.top.findNode("dialogButtons")
    m.buttons.observeField("buttonSelected", "onButton")
end sub

sub focusDefault()
    m.buttons.setFocus(true)
end sub

sub onButton(event as object)
    id = m.buttons.getChild(event.getData()).id
    d = CreateObject("roSGNode", "Dialog")
    d.id = "deviceDialog"
    d.title = "Fixture dialog"
    if id = "openMessage"
        d.message = ["A message dialog with one button."]
        d.buttons = ["OK"]
    else
        d.message = ["A confirm dialog with two buttons."]
        d.buttons = ["Confirm", "Cancel"]
    end if
    d.observeField("buttonSelected", "onDialogButton")
    d.observeField("wasClosed", "onClosed")
    m.dialog = d
    BTDev_log("dialog", "open kind=" + id)
    m.top.getScene().dialog = d
end sub

sub onDialogButton(event as object)
    r = "dialog:" + event.getData().toStr()
    m.global.lastDialog = r
    m.top.findNode("dialogResult").text = "result: " + r
    BTDev_log("dialog", "selected=" + r)
    m.dialog.close = true
end sub

sub onClosed()
    BTDev_log("dialog", "closed")
    m.buttons.setFocus(true)
end sub
