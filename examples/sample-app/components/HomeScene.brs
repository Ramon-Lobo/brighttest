sub init()
    m.stage = m.top.findNode("stage")
    m.current = ""
    showPanel("HomePanel", "")
end sub

' Swap the mounted panel. Only one panel is a child of the stage at a time.
sub showPanel(name as string, title as string)
    while m.stage.getChildCount() > 0
        m.stage.removeChildIndex(0)
    end while
    panel = CreateObject("roSGNode", name)
    if name = "DetailsPanel" then panel.title = title
    m.stage.appendChild(panel)
    panel.observeField("action", "onAction")
    panel.setFocus(true)        ' focus the panel so Back bubbles to this scene
    panel.focusEnter = true     ' panels with controls focus their first control
    m.current = name
end sub

' A panel reported an activated control (button id). Map it to a navigation.
sub onAction(msg as object)
    id = msg.getData()
    if id = "" then return
    if id = "searchButton"
        showPanel("SearchPanel", "")
    else if id = "settingsButton"
        showPanel("SettingsPanel", "")
    else if id = "tileNews"
        showPanel("DetailsPanel", "News")
    else if id = "tileSports"
        showPanel("DetailsPanel", "Sports")
    else if id = "tileMovies"
        showPanel("DetailsPanel", "Movies")
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        ' Back always returns to Home and never exits the channel — this makes a "back to Home"
        ' preamble in e2e flows deterministic regardless of the screen the app was left on.
        if m.current <> "HomePanel" then showPanel("HomePanel", "")
        return true
    end if
    return false
end function
