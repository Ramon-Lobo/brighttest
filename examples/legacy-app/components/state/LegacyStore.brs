sub init()
    m.top.state = { screen: "home", tier: "free", history: [] }
end sub

function handleAction(action as object) as object
    s = m.top.state
    s.history.push(action.type)
    if action.type = "tier" then s.tier = action.value
    if action.type = "go" then s.screen = action.value
    m.top.actionCount = m.top.actionCount + 1
    return s
end function

function dispatchAction(action as object) as object
    s = handleAction(action)
    m.top.state = s
    return s
end function

sub resetHome()
    m.top.state = { screen: "home", tier: "free", history: [] }
end sub
