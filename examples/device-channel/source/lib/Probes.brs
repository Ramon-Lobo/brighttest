' Platform-behaviour probes (BRS-06 findNode, COV-23 field/AA/LayoutGroup/coerce facts). Each returns
' "phase|key=value" strings. Results are facts to record on a device, not assertions: the headless
' engine is expected to differ in places.

function BTDev_t(v as dynamic) as string
    if v = invalid then return "invalid"
    return type(v)
end function

function BTDev_probeAll(phase as string, scene as dynamic, host as dynamic) as object
    out = []
    out.append(BTDev_probeFindNode(phase))
    out.append(BTDev_probeAAOrder(phase))
    out.append(BTDev_probeHasField(phase))
    out.append(BTDev_probeCoerce(phase))
    if scene <> invalid then out.append(BTDev_probeScene(phase, scene))
    if host <> invalid then out.append(BTDev_probeLayout(phase, host))
    return out
end function

' Detached findNode: id set before append, id set after, grandchild, self id, attached-to-nothing.
function BTDev_probeFindNode(phase as string) as object
    out = []
    for each s in ["Node", "Group"]
        for each k in ["ContentNode", "Rectangle"]
            g = CreateObject("roSGNode", s)
            c = CreateObject("roSGNode", k)
            c.id = "b"
            g.appendChild(c)
            out.push(phase + "|findNode.direct." + s + "." + k + "=" + BTDev_t(g.findNode("b")))
            g2 = CreateObject("roSGNode", s)
            c2 = CreateObject("roSGNode", k)
            g2.appendChild(c2)
            c2.id = "b"
            out.push(phase + "|findNode.idAfter." + s + "." + k + "=" + BTDev_t(g2.findNode("b")))
        end for
        top = CreateObject("roSGNode", s)
        mid = CreateObject("roSGNode", "Group")
        leaf = CreateObject("roSGNode", "Rectangle")
        leaf.id = "b"
        mid.appendChild(leaf)
        top.appendChild(mid)
        out.push(phase + "|findNode.grandchild." + s + "=" + BTDev_t(top.findNode("b")))
        me = CreateObject("roSGNode", s)
        me.id = "b"
        out.push(phase + "|findNode.self." + s + "=" + BTDev_t(me.findNode("b")))
    end for
    return out
end function

' AA key order: literal, incremental build, and a node's own AA fields.
function BTDev_probeAAOrder(phase as string) as object
    out = []
    lit = { zeta: 1, alpha: 2, mike: 3, bravo: 4, yankee: 5, charlie: 6 }
    out.push(phase + "|aa.literal.keys=" + lit.keys().join(","))
    inc = {}
    inc.zeta = 1 : inc.alpha = 2 : inc.mike = 3 : inc.bravo = 4 : inc.yankee = 5 : inc.charlie = 6
    out.push(phase + "|aa.incremental.keys=" + inc.keys().join(","))
    fe = []
    for each k in inc
        fe.push(k)
    end for
    out.push(phase + "|aa.incremental.foreach=" + fe.join(","))
    r = CreateObject("roSGNode", "Rectangle")
    out.push(phase + "|aa.clippingRect.keys=" + r.clippingRect.keys().join(","))
    return out
end function

' hasField lists from COV-23 D-17 plus BRS-02 (forceUpperCase).
function BTDev_probeHasField(phase as string) as object
    out = []
    lists = [
        { t: "ScrollingLabel", f: ["wrap", "maxLines", "numLines", "lineSpacing", "ellipsisText", "scrollSpeed", "repeatCount", "text"] },
        { t: "Button", f: ["focusBitmapBlendColor", "focusFootprintBlendColor", "textColor"] },
        { t: "Keyboard", f: ["height", "width", "focusBitmapBlendColor", "text"] },
        { t: "TextEditBox", f: ["color", "textColor", "hintText"] },
        { t: "Video", f: ["MaxVideoDecodeResolution", "playbackSpeed"] },
        { t: "Label", f: ["forceUpperCase", "leadingEllipsis", "numWrappedLines"] }
    ]
    for each l in lists
        n = CreateObject("roSGNode", l.t)
        for each f in l.f
            v = "false"
            if n.hasField(f) then v = "true"
            out.push(phase + "|hasField." + l.t + "." + f + "=" + v)
        end for
    end for
    return out
end function

' aa_from_array / array_from_aa: assigning the wrong container type to an AA/array field.
function BTDev_probeCoerce(phase as string) as object
    out = []
    n = CreateObject("roSGNode", "Node")
    n.addField("aa", "assocarray", false)
    n.addField("arr", "array", false)
    out.push(phase + "|coerce.aa.initial=" + BTDev_t(n.aa))
    n.aa = [1]
    out.push(phase + "|coerce.aa_from_array=" + BTDev_t(n.aa))
    n.aa = { a: 1 }
    n.arr = { a: 1 }
    out.push(phase + "|coerce.array_from_aa=" + BTDev_t(n.arr))
    return out
end function

' Fresh/attached Scene facts: child count and subtypes (device Scenes carry an implicit child).
function BTDev_probeScene(phase as string, scene as object) as object
    out = []
    out.push(phase + "|scene.subtype=" + scene.subtype())
    out.push(phase + "|scene.childCount=" + scene.getChildCount().toStr())
    subs = []
    for i = 0 to scene.getChildCount() - 1
        subs.push(scene.getChild(i).subtype())
    end for
    out.push(phase + "|scene.childSubtypes=" + subs.join(","))
    return out
end function

' LayoutGroup lays out lazily: boundingRect before vs after a render pass (compare phases).
function BTDev_probeLayout(phase as string, host as object) as object
    out = []
    if m.probeLg = invalid
        lg = CreateObject("roSGNode", "LayoutGroup")
        lg.layoutDirection = "horiz"
        lg.itemSpacings = [10]
        a1 = lg.createChild("Rectangle")
        a1.width = 10 : a1.height = 10
        a2 = lg.createChild("Rectangle")
        a2.width = 20 : a2.height = 10
        host.appendChild(lg)
        m.probeLg = lg
        m.probeA2 = a2
    end if
    r = m.probeA2.boundingRect()
    out.push(phase + "|layout.child2.x=" + Str(r.x).trim())
    b = m.probeLg.boundingRect()
    out.push(phase + "|layout.group.width=" + Str(b.width).trim())
    return out
end function
