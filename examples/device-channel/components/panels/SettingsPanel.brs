sub init()
    m.buttons = m.top.findNode("settingsButtons")
    m.kb = m.top.findNode("nameKeyboard")
    m.buttons.observeField("buttonSelected", "onButton")
    m.kb.observeField("text", "onText")
end sub

sub focusDefault()
    m.buttons.setFocus(true)
end sub

sub onText(event as object)
    t = event.getData()
    m.top.findNode("nameEcho").text = "name: " + t
    m.top.findNode("nameBox").text = t
end sub

sub onButton(event as object)
    id = m.buttons.getChild(event.getData()).id
    BTDev_log("settings", "button=" + id)
    if id = "editName"
        m.kb.setFocus(true)
    else if id = "toggleFlag"
        m.global.flag = not m.global.flag
        m.top.findNode("flagLabel").text = "flag: " + BTDev_str(m.global.flag)
    else if id = "saveName"
        reg = CreateObject("roRegistrySection", "devch")
        reg.write("name", m.kb.text)
        reg.flush()
        user = m.global.user
        user.name = m.kb.text
        m.global.user = user
    else if id = "crashButton"
        BTDev_crash("button")
    end if
end sub

' The Keyboard consumes the directional keys, so "Edit name" moves focus into it and Back (which it
' leaves alone) returns focus to the buttons instead of leaving the screen.
function onKeyEvent(key as string, press as boolean) as boolean
    if press and key = "back" and m.kb.isInFocusChain()
        m.buttons.setFocus(true)
        return true
    end if
    return false
end function
