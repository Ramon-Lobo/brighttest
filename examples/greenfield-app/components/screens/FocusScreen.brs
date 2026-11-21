sub init()
    m.top.findNode("outerGroup").observeField("focusedChild", "onFocusChange")
end sub

sub onFocusEnter()
    if m.top.focusEnter then m.top.findNode("leafButton").setFocus(true)
end sub

sub onFocusChange()
    ' no-op: exists so selectors can assert the chain through focusedChild
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if press then m.top.findNode("focusKey").text = "key: " + key
    return false
end function
