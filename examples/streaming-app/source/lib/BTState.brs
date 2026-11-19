' Publishes an inspectable snapshot of app state for brighttest.
'
' Roku's ECP can't read m.global, custom interface fields, or component m. locals — /query/sgnodes/all
' only serializes a node's built-in attributes. But a node's `text` IS one of those, so we mirror a JSON
' snapshot into a hidden Label with the well-known id "__bt_state". brighttest finds that node by id and
' parses its text back into an object. Put whatever you want to inspect in `snapshot` (globals, current
' screen, registry-backed state, …); it just has to be JSON-serializable.
sub BTState_publish(parent as object, snapshot as object)
    if parent = invalid then return
    node = parent.findNode("__bt_state")
    if node = invalid
        node = parent.createChild("Label")
        node.id = "__bt_state"
        node.visible = false   ' inspection-only; never drawn
    end if
    json = FormatJson(snapshot)
    if json = invalid then json = "{}"
    node.text = json
end sub

' Collect the scalar fields of a node (e.g. m.global) into a plain assocarray, skipping the built-ins and
' any non-JSON values — so callers can publish "all global values" without hand-listing each one.
function BTState_scalars(node as object) as object
    out = {}
    if node = invalid then return out
    builtins = { id: true, change: true, focusable: true, focusedChild: true, focused: true }
    for each key in node.getFields()
        if not builtins.doesExist(key)
            v = node[key]
            t = Type(v)
            if t = "roString" or t = "String" or t = "roInt" or t = "Integer" or t = "roFloat" or t = "Float" or t = "roBoolean" or t = "Boolean" or t = "roInteger" or t = "roDouble" or t = "Double"
                out[key] = v
            end if
        end if
    end for
    return out
end function
