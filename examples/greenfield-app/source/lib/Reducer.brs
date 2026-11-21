' Pure state reducer shared by the AppStore node and its unit tests.
function Reducer_initial() as object
    return {
        user: { tier: "free", signedIn: false }
        nav: { screen: "home", detailsId: "" }
    }
end function

function Reducer_apply(state as object, action as object) as object
    nextState = {
        user: { tier: state.user.tier, signedIn: state.user.signedIn }
        nav: { screen: state.nav.screen, detailsId: state.nav.detailsId }
    }
    t = action.type
    if t = "user/signIn"
        nextState.user = { tier: action.tier, signedIn: true }
    else if t = "user/signOut"
        nextState.user = { tier: "free", signedIn: false }
    else if t = "nav/go"
        nextState.nav = { screen: action.screen, detailsId: "" }
        if action.id <> invalid then nextState.nav.detailsId = action.id
    end if
    return nextState
end function
