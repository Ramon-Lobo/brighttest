

' a comment
function net(x as object) as object
    a = {k: 1, v: 2}
    if a.k = 1 then print "x"
    x.setUrl("http://127.0.0.1:1/a")
    print a.nope.deep
    y = 1 : z = 2
    return x
end function
