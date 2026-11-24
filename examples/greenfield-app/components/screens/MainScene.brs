sub init()
    m.stage = m.top.findNode("stage")
    m.store = CreateObject("roSGNode", "AppStore")
    m.global.observeField("btState_user", "onState")
    m.current = ""
    m.probeOn = false
    m.pending = {}
    showScreen("HomeScreen", "")
end sub

' Main() sets baseUrl, then flips ready; the first request must not run in init() (baseUrl is still the default there).
sub onReady()
    if m.top.ready then request("hero", { mode: "getAsync", path: "/home" })
end sub

sub onPeriodic()
    timer = m.top.findNode("periodicTimer")
    if m.top.periodic
        timer.observeField("fire", "onTick")
        timer.control = "start"
    else
        timer.control = "stop"
    end if
end sub

' Opt-in /input order probe (inputprobe=1). Adds the global fields only when enabled, so default snapshots are unchanged.
sub onInputProbeEnable()
    if not m.top.inputProbe or m.probeOn = true then return
    m.probeOn = true
    ' alwaysNotify on inputProbe so a repeated identical value still fires the observer.
    m.global.addField("inputProbe", "string", true)
    m.global.addField("inputProbeLog", "string", false)
    m.global.observeField("inputProbe", "onInputProbe")
end sub

' Append the event's own value (not a field re-read) so coalesced writes cannot hide ordering.
sub onInputProbe(msg as object)
    id = msg.getData()
    if type(id) <> "roString" and type(id) <> "String" then return
    if id = "" then return
    m.global.inputProbeLog = InputProbe_append(m.global.inputProbeLog, id, 1800)
end sub

sub onTick()
    request("periodic", { mode: "getAsync", path: "/home" })
end sub

' Run one HttpTask request; the task id is the tag used to route its result.
sub request(tag as string, req as object)
    task = CreateObject("roSGNode", "HttpTask")
    task.id = tag
    task.baseUrl = m.top.baseUrl
    task.request = req
    task.observeField("result", "onHttpResult")
    m.pending[tag] = task
    task.control = "run"
end sub

sub onHttpResult(msg as object)
    tag = msg.getRoSGNode().id
    result = msg.getData()
    if tag = "hero"
        if result.code = 200
            data = ParseJson(result.body)
            if data <> invalid and data.title <> invalid then m.stage.getChild(0).heroTitle = data.title
        end if
    else if tag = "search"
        if result.code >= 400 or result.code = 0
            m.stage.getChild(0).errorText = "Search failed (" + result.code.toStr() + ")"
        else
            m.stage.getChild(0).errorText = ""
        end if
    else if tag = "track"
        m.stage.getChild(0).trackingStatus = "tracked"
    end if
    m.pending.delete(tag)
end sub

sub showScreen(name as string, arg as string)
    while m.stage.getChildCount() > 0
        m.stage.removeChildIndex(0)
    end while
    screen = CreateObject("roSGNode", name)
    if name = "DetailsScreen" then screen.itemId = arg
    m.stage.appendChild(screen)
    screen.observeField("action", "onAction")
    screen.setFocus(true)
    screen.focusEnter = true
    m.current = name
    m.store.callFunc("dispatch", { type: "nav/go", screen: name, id: arg })
end sub

sub onAction(msg as object)
    action = msg.getData()
    id = action.id
    if id = "tile1" or id = "tile2" or id = "tile3"
        showScreen("DetailsScreen", id)
        request("track", { mode: "post", path: "/track", body: { event: "open", item: id } })
    else if id = "searchButton"
        showScreen("SearchScreen", "")
    else if id = "focusDemoButton"
        showScreen("FocusScreen", "")
    else if id = "signInButton"
        m.store.callFunc("dispatch", { type: "user/signIn", tier: "premium" })
    else if id = "runSearch"
        request("search", { mode: "getAsync", path: "/search?q=" + action.query })
    end if
end sub

sub onState()
    user = m.global.btstate_user
    if m.current = "HomeScreen" then m.stage.getChild(0).tierText = Format_tierLabel(user.tier)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back" and m.current <> "HomeScreen"
        showScreen("HomeScreen", "")
        return true
    end if
    return false
end function
