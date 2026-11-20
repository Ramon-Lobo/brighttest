' Stress mode: grow m.global to `count` fields of about `kb` KB in total, and build trees of N nodes.
function growGlobal(count = 500 as integer, kb = 256 as integer) as integer
    per = (kb * 1024) \ count
    fields = {}
    for i = 0 to count - 1
        fields["stress_" + i.toStr()] = String(per, "s")
    end for
    m.global.addFields(fields)
    return count
end function

function buildTree(nodes = 1500 as integer) as integer
    root = CreateObject("roSGNode", "Group")
    made = 1
    parent = root
    while made < nodes
        g = CreateObject("roSGNode", "Group")
        parent.appendChild(g)
        made = made + 1
        if made mod 10 = 0 then parent = g
    end while
    m.top.appendChild(root)
    return made
end function
