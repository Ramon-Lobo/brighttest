' m.global fields and registry state: the state-inspection targets (STA-07/08/15/18).
sub BTDev_initGlobals(g as object, opts as object)
    g.addFields({
        appName: "Device Channel",
        titleCount: BTDev_catalog().count(),
        flag: false,
        counter: 0,
        lastverb: "",
        lastDialog: "",
        current: "",
        selectedId: "item-1",
        user: { tier: "free", name: "guest" },
        btNet: opts.bt_net,
        launchScene: opts.scene,
        perfCount: opts.perf,
        streamUrl: opts.stream,
        netUrl: opts.net_url
    })
    if opts.stress > 0
        g.addFields({ stressBlob: String(opts.stress * 1024, "x") })
        BTDev_log("stress", "kb=" + opts.stress.toStr())
    end if
    for i = 1 to opts.stressfields
        f = {}
        f["sf" + i.toStr()] = i
        g.addFields(f)
    end for
end sub

sub BTDev_bumpVisits()
    reg = CreateObject("roRegistrySection", "devch")
    n = Val(reg.read("visits"), 10) + 1
    reg.write("visits", Int(n).toStr())
    reg.flush()
    BTDev_log("registry", "visits=" + Int(n).toStr())
end sub
