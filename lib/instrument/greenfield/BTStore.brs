' brighttest-template: BTStore v1
' Greenfield store convention for brighttest. Copied into your app by `brighttest init --greenfield`.
' Reducers are plain functions: fn(state as object, action as object) as object.
' Pure mode (no SceneGraph, safe in the fast lane): store = BTStore_create(reducers, initial)
'   store.dispatch(action) : store.state
'
' Current limitations (recorded scope cut, not yet implemented from the design):
'   - No `#if BT_AGENT` branches: no state.action emission, no hashBefore/hashAfter, no dispatch/restore ops.
'   - BTStore_dispatch called from a Task thread does not reduce; it returns {}. Tasks must set
'     m.global.btAction instead (reduced by the render-thread observer).
'   - BTStore_replay ignores options.effects (reducers only); there is no m.global.btEffect.

function BTStore_create(reducers as object, initial = {} as object) as object
    store = { reducers: reducers, state: {}, actions: [] }
    for each key in reducers
        if initial.DoesExist(key) then store.state[key] = initial[key] else store.state[key] = {}
    end for
    store.dispatch = function(action as object) as object
        for each key in m.reducers
            fn = m.reducers[key]
            m.state[key] = fn(m.state[key], action)
        end for
        m.actions.Push(action)
        return m.state
    end function
    return store
end function

' Scene-side store (render thread = single writer). State lives in m.global.btState_<slice> fields.
sub BTStore_init(reducers as object, initial = {} as object)
    g = m.global
    m.btStore = BTStore_create(reducers, initial)
    for each key in m.btStore.state
        f = {}
        f["btState_" + key] = m.btStore.state[key]
        g.addFields(f)
    end for
    g.addFields({ btAction: {} })
    g.observeField("btAction", "BTStore_onAction")
end sub

sub BTStore_onAction()
    action = m.global.btAction
    if action <> invalid and action.type <> invalid then BTStore_dispatch(action)
end sub

' Render thread: reduces immediately. Tasks: set m.global.btAction instead (queued to the render thread).
function BTStore_dispatch(action as object) as object
    if m.btStore = invalid then return {}
    state = m.btStore.dispatch(action)
    BTStore_publish(state)
    return state
end function

function BTStore_getState() as object
    if m.btStore = invalid then return {}
    return m.btStore.state
end function

' Dotted path lookup, e.g. BTStore_select("user.tier")
function BTStore_select(path as string) as dynamic
    node = BTStore_getState()
    for each part in path.Split(".")
        if type(node) <> "roAssociativeArray" or not node.DoesExist(part) then return invalid
        node = node[part]
    end for
    return node
end function

sub BTStore_subscribe(slice as string, callback as string)
    m.global.observeField("btState_" + slice, callback)
end sub

function BTStore_snapshot() as object
    return ParseJson(FormatJson(BTStore_getState()))
end function

sub BTStore_restore(snap as object)
    if m.btStore = invalid then return
    m.btStore.state = ParseJson(FormatJson(snap))
    BTStore_publish(m.btStore.state)
end sub

sub BTStore_publish(state as object)
    for each key in state
        f = {}
        f["btState_" + key] = state[key]
        m.global.setFields(f)
    end for
end sub

' Reducers only; effects Tasks are not re-run in replay.
sub BTStore_replay(actions as object, options = {} as object)
    for each a in actions
        BTStore_dispatch(a)
    end for
end sub
