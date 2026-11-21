' Launch-arg parsing. Pure: no device or node access (covered by Args.spec.bs).
function BTDev_scenes() as object
    return ["MainScene", "InitIfBlockScene", "InitIfInlineScene", "InitLabelScene", "InitForScene", "InitCommentScene", "InitNoInitScene", "SharedScene", "BaseScene", "ChildScene"]
end function

function BTDev_intArg(v as dynamic, fallback as integer, lo as integer, hi as integer) as integer
    if v = invalid then return fallback
    n = Val(BTDev_str(v), 10)
    if n < lo then return lo
    if n > hi then return hi
    return Int(n)
end function

function BTDev_parseArgs(args as dynamic) as object
    o = { scene: "MainScene", crash: "", crashdelay: 2500, slow: 0, perf: 300, stream: "", net_url: "", stress: 0, stressfields: 0, bt_net: "" }
    if type(args) <> "roAssociativeArray" then return o
    if args.scene <> invalid
        for each s in BTDev_scenes()
            if s = BTDev_str(args.scene) then o.scene = s
        end for
    end if
    if args.crash <> invalid
        c = LCase(BTDev_str(args.crash))
        if c = "1" or c = "error" then o.crash = "error"
        if c = "task" or c = "exit" then o.crash = c
    end if
    o.crashdelay = BTDev_intArg(args.crashdelay, 2500, 0, 60000)
    o.slow = BTDev_intArg(args.slow, 0, 0, 30000)
    o.perf = BTDev_intArg(args.perf, 300, 1, 3000)
    o.stress = BTDev_intArg(args.stress, 0, 0, 1024)
    o.stressfields = BTDev_intArg(args.stressfields, 0, 0, 1000)
    if args.stream <> invalid then o.stream = BTDev_str(args.stream)
    if args.net_url <> invalid then o.net_url = BTDev_str(args.net_url)
    if args.bt_net <> invalid then o.bt_net = BTDev_str(args.bt_net)
    return o
end function
