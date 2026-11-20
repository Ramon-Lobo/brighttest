sub init()
    print "BTFIX:scene-init"
    m.cfg = m.global.config
    m.keys = []
    m.store = m.top.findNode("store")
    m.store.observeField("state", "onStoreState")
    m.global.observeField("user", "onUser")
    m.top.findNode("poster").uri = Util_buildUrl(m.cfg, "img", "hero.png")
    content = CreateObject("roSGNode", "ContentNode")
    content.url = Util_buildUrl(m.cfg, "video", "intro.m3u8")
    m.top.findNode("player").content = content
    m.reg = CreateObject("roRegistrySection", "legacy_session")
    m.top.renderThreadMark = "render"
    #if STRESS
    runStress()
    #end if
    if m.global.stress = true then runStress()
    startWorkers()
    if m.cfg.netDiagUrl <> "" then runNetDiag(m.cfg.netDiagUrl)
end sub

sub runStress()
    print "BTFIX:stress"
    sb = m.top.findNode("stress")
    sb.callFunc("growGlobal", 500, 256)
    sb.callFunc("buildTree", 1500)
    sb.callFunc("buildTree", 6000)
end sub

sub startWorkers()
    m.worker = CreateObject("roSGNode", "WorkerTask")
    m.worker.observeField("result", "onWorkerResult")
    m.worker.control = "run"
    m.thread = CreateObject("roSGNode", "ThreadTask")
    m.thread.observeField("ranOn", "onThread")
    m.thread.control = "run"
end sub

sub runNetDiag(url as string)
    t = CreateObject("roSGNode", "PerRequestTask")
    t.kind = "diag"
    t.url = url
    t.observeField("summary", "onDiag")
    t.control = "run"
end sub

sub onDiag(msg as object)
    summary = msg.getData()
    m.top.findNode("netDiag").text = summary
    print "NETDIAG " + summary
end sub

sub onThread(msg as object)
    print "BTFIX:thread=" + msg.getData()
end sub

sub onWorkerResult(msg as object)
    print "BTFIX:worker-result"
end sub

sub onUser()
    m.top.findNode("tierLabel").text = "Tier: " + m.global.user.tier
end sub

sub onStoreState()
    print "BTFIX:store-state"
end sub

' Render-thread sync call: an anti-pattern kept on purpose (off unless config.renderThreadSync).
sub renderThreadProbe()
    x = CreateObject("roUrlTransfer")
    x.setUrl(Util_buildUrl(m.cfg, "probe", ""))
    body = x.getToString()
    print "BTFIX:render-sync len=" + body.len().toStr()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    print "BTFIX:key=" + key
    m.keys.push(key)
    if m.keys.count() > 4 then m.keys.shift()
    seq = m.keys.join(",")
    if seq = "up,up,down,down"
        print "BTFIX:crash-trigger"
        broken = invalid
        print broken.value
    else if seq = "left,right,left,right"
        print "BTFIX:end-trigger"
        END
    end if
    if key = "play"
        ' state bag writes: field set, then in-place AA replacement
        m.global.setField("launchCount", m.global.launchCount + 1)
        u = m.global.user
        u.tier = "premium"
        m.global.user = u
        m.store.callFunc("dispatchAction", { type: "tier", value: "premium" })
        return true
    else if key = "rewind"
        if m.cfg.renderThreadSync then renderThreadProbe()
        return true
    else if key = "fastforward"
        m.worker.queue = [Util_buildUrl(m.cfg, "items", "1"), Util_buildUrl(m.cfg, "items", "2")]
        t = CreateObject("roSGNode", "PerRequestTask")
        t.kind = "get"
        t.url = Util_buildUrl(m.cfg, "items", "3")
        t.control = "run"
        return true
    else if key = "options"
        m.store.callFunc("resetHome")
        return true
    end if
    return false
end function
