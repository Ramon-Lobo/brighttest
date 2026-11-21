sub init()
    m.top.state = Reducer_initial()
end sub

' Apply an action ({type, ...}) and publish the new state. Returns the new state.
function dispatch(action as object) as object
    nextState = Reducer_apply(m.top.state, action)
    m.top.state = nextState
    return nextState
end function
