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
    if id = "toggleFlag"
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

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "down" and m.buttons.isInFocusChain()
        m.kb.setFocus(true)
        return true
    else if key = "up" and m.kb.isInFocusChain()
        m.buttons.setFocus(true)
        return true
    end if
    return false
end function
