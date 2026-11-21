' No init anywhere in this Scene's chain: the plugin must synthesize one.
function onKeyEvent(key as string, press as boolean) as boolean
    if press then print "BTDEV:key " + key
    return false
end function
