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

' Net-secrets probe: launch parameter netsecrets=1 makes the app send one extra GET to <base>/echo carrying dummy
' credential-looking values (header and query only), so redaction can be checked. Off by default.
function Config_isNetSecrets(args as object) as boolean
    return type(args) = "roAssociativeArray" and args.netsecrets = "1"
end function

' Adds m.global.btNetSecrets (true) to the given global node when netsecrets=1. Main() passes screen.getGlobalNode(),
' because m.global is not available there. Adds nothing otherwise.
sub Config_applyNetSecrets(globalNode as object, args as object)
    if not Config_isNetSecrets(args) then return
    globalNode.addField("btNetSecrets", "boolean", false)
    globalNode.btNetSecrets = true
end sub

' Shape of the extra request. The values are dummies, not real credentials.
function Config_netSecretsRequest() as object
    return {
        path: "/echo?token=abc&access_token=def&sig=ghi"
        headers: { "Authorization": "Bearer test-not-secret" }
    }
end function
