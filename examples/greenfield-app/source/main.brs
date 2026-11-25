sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.CreateScene("MainScene")
    scene.baseUrl = Config_baseUrl(args)
    scene.periodic = Config_isPeriodic(args)
    scene.inputProbe = Config_isInputProbe(args)
    Config_applyNetSecrets(screen.getGlobalNode(), args)
    scene.ready = true
    screen.show()
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
