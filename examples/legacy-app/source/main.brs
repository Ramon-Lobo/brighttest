sub Main(args as dynamic)
    print "BTFIX:startup"
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.setMessagePort(m.port)
    cfg = Config_get()
    sceneName = "LegacyScene"
    stress = false
    stressKb = 256
    stressFields = 500
    stressTree = "both"
    if type(args) = "roAssociativeArray"
        if args.scene <> invalid and args.scene <> "" then sceneName = args.scene
        if args.stress <> invalid then stress = true
        if args.stresskb <> invalid
            kb = Val(args.stresskb)
            if kb = 1 or kb = 16 or kb = 64 or kb = 256 then stressKb = Int(kb)
        end if
        if args.stressfields <> invalid
            nf = Val(args.stressfields)
            if nf = 100 or nf = 500 or nf = 1000 then stressFields = Int(nf)
        end if
        if args.stresstree <> invalid
            st = LCase(args.stresstree)
            if st = "1500" or st = "6000" or st = "both" then stressTree = st
        end if
        if args.netdiag <> invalid and args.netdiag <> "" then cfg.netDiagUrl = args.netdiag
        if args.noinput = invalid
            m.input = CreateObject("roInput")
            m.input.setMessagePort(m.port)
        end if
    end if
    #if STRESS
    stress = true
    #end if
    m.global = screen.getGlobalNode() ' in Main(), m is a plain AA: bind the screen's global node first
    ' scene init reads global config, so the bag must exist before CreateScene; focus only after show
    ' state bag: nested AAs, secrets (DUMMY values), long list/string, date
    m.global.addFields({
        config: cfg
        user: { tier: "free", profile: { name: "Sample User", prefs: { captions: false } } }
        authToken: "dummy-token-0000"
        sessionId: "dummy-session-0000"
        password: "dummy-password"
        launchCount: 0
        bigList: Util_range(60)
        bigString: String(2100, "x")
        ' (no node ref here: roSGNode creation outside a scene context logs a non-fatal error)
        meta: { created: CreateObject("roDateTime") }
        stress: stress
        stressKb: stressKb
        stressFields: stressFields
        stressTree: stressTree
    })
    m.global.launchCount = m.global.launchCount + 1
    scene = screen.CreateScene(sceneName) : screen.show() : scene.setFocus(true)
    reg = CreateObject("roRegistrySection", "legacy_prefs")
    if not reg.exists("lastTier")
        reg.write("lastTier", m.global.user.tier)
        reg.flush()
    end if
    if reg.exists("lastTier") then m.global.setField("user", { tier: reg.read("lastTier"), profile: m.global.user.profile })
    while true
        msg = wait(0, m.port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed()
                reg.write("lastTier", m.global.user.tier)
                reg.flush()
                print "BTFIX:exit"
                return
            end if
        else if type(msg) = "roInputEvent"
            print "BTFIX:input"
        end if
    end while
end sub

function Util_range(n as integer) as object
    a = []
    for i = 0 to n - 1
        a.push(i)
    end for
    return a
end function
