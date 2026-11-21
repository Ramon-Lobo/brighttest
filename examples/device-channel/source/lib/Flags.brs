' Build-time flag for the deliberately failing spec. Default off. Turn on by setting
' bs_const=BT_DEVCH_FAIL=true in the manifest (see README), then run any lane.
function BTDev_failOnPurpose() as boolean
#if BT_DEVCH_FAIL
    return true
#else
    return false
#end if
end function
