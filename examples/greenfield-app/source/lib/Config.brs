' Runtime configuration. BT_BASE_URL (launch parameter) overrides the default origin.
function Config_defaultBaseUrl() as string
    return "http://127.0.0.1:8787"
end function

function Config_baseUrl(args as object) as string
    if type(args) = "roAssociativeArray" and args.BT_BASE_URL <> invalid and args.BT_BASE_URL <> ""
        return args.BT_BASE_URL
    end if
    return Config_defaultBaseUrl()
end function

' Periodic-request mode: launch parameter periodic=true makes the app GET /home every 10 s.
function Config_isPeriodic(args as object) as boolean
    return type(args) = "roAssociativeArray" and args.periodic = "true"
end function

' Input-order probe: launch parameter inputprobe=1 enables m.global.inputProbe / inputProbeLog (off by default).
function Config_isInputProbe(args as object) as boolean
    return type(args) = "roAssociativeArray" and args.inputprobe = "1"
end function
