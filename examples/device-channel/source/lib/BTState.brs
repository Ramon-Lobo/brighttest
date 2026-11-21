' App-state convention for `brighttest e2e` assertState: mirror a JSON snapshot into a hidden Label with
' the well-known id "__bt_state" (ECP serializes a node's text, not m.global). Generic and self-contained.
sub BTState_publish(parent as object, snapshot as object)
    if parent = invalid then return
    node = parent.findNode("__bt_state")
    if node = invalid
        node = parent.createChild("Label")
        node.id = "__bt_state"
        node.visible = false
    end if
    json = FormatJson(snapshot)
    if json = invalid then json = "{}"
    node.text = json
end sub

' Scalar fields of a node (e.g. m.global), skipping built-ins and non-JSON values.
function BTState_scalars(node as object) as object
    out = {}
    if node = invalid then return out
    skip = { id: true, change: true, focusable: true, focusedchild: true, focused: true, stressblob: true }
    for each key in node.getFields()
        if not skip.doesExist(LCase(key))
            v = node[key]
            t = Type(v)
            if t = "roString" or t = "String" or t = "roInt" or t = "Integer" or t = "roFloat" or t = "Float" or t = "roBoolean" or t = "Boolean" or t = "roDouble" or t = "Double"
                out[key] = v
            end if
        end if
    end for
    return out
end function
