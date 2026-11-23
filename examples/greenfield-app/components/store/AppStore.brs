' State lives in BTStore slices: m.global.btState_user and m.global.btState_nav (read as btstate_user / btstate_nav).
sub init()
    BTStore_init({ user: Reducer_user, nav: Reducer_nav }, Reducer_initial())
end sub

' Apply an action ({type, ...}) through BTStore and publish the slices. Returns the new state.
function dispatch(action as object) as object
    return BTStore_dispatch(action)
end function
