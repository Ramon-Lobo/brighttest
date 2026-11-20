' Device Channel entry point. Launch args (ECP: POST /launch/dev?k=v) select scenes and fault modes;
' see README.md. Every 8085 marker starts with "BTDEV:".
sub Main(args as dynamic)
    BTDev_log("startup", "")
    BTDev_logArgs(args)
    opts = BTDev_parseArgs(args)
    if opts.slow > 0
        BTDev_log("slow", "ms=" + opts.slow.toStr())
        sleep(opts.slow)
    end if

    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    BTDev_initGlobals(screen.getGlobalNode(), opts)
    BTDev_bumpVisits()
    scene = screen.CreateScene(opts.scene)
    screen.show()
    BTDev_log("scene-ready", "scene=" + opts.scene)

    input = CreateObject("roInput")
    input.setMessagePort(port)

    crashArmed = (opts.crash <> "")
    clock = CreateObject("roTimespan")
    if crashArmed then BTDev_log("crash-armed", "kind=" + opts.crash + " delay=" + opts.crashdelay.toStr())

    while true
        msg = wait(250, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else if type(msg) = "roInputEvent"
            BTDev_log("input", "deeplink")
            BTDev_logArgs(msg.getInfo())
        end if
        if crashArmed and clock.totalMilliseconds() >= opts.crashdelay
            crashArmed = false
            if opts.crash = "exit"
                BTDev_log("exit", "clean")
                return
            else if opts.crash = "task"
                t = CreateObject("roSGNode", "CrashTask")
                t.control = "RUN"
            else
                BTDev_crash("main")
            end if
        end if
    end while
end sub
