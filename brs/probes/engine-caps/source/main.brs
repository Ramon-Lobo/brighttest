' engine-caps probe: prints one `CAP <id> <0|1>` line per patch id (1 = the engine behaves as patched).
' Run by `brighttest doctor --engines` with the resolved brs-cli. Keep it tiny: it must finish in about 2 s.
' Probes follow design fork-strategy.md section 6.2. Rooibos patches are not probed here (build-time checks).

sub Main()
    ' BRS-01: assigning invalid to a string field yields the scalar default ("")
    n = CreateObject("roSGNode", "Node")
    n.addFields({ s: "abc" })
    n.s = invalid
    CAP_Print("BRS-01", n.s = "")

    ' BRS-02: Label.forceUpperCase exists (NON-DEVICE: a real Roku has no such field)
    l = CreateObject("roSGNode", "Label")
    CAP_Print("BRS-02", l.hasField("forceUpperCase"))

    ' BRS-03: translation elements are floats
    g = CreateObject("roSGNode", "Group")
    g.translation = [1, 2]
    CAP_Print("BRS-03", type(g.translation[0]) = "roFloat")

    ' BRS-04: loadDisplayMode reads back lower-cased
    p = CreateObject("roSGNode", "Poster")
    p.loadDisplayMode = "scaleToFit"
    CAP_Print("BRS-04", p.loadDisplayMode = "scaletofit")

    ' BRS-06: findNode works on a detached tree
    d = CreateObject("roSGNode", "Group")
    c = CreateObject("roSGNode", "Group")
    c.id = "b"
    d.appendChild(c)
    CAP_Print("BRS-06", d.findNode("b") <> invalid)
end sub

sub CAP_Print(id as string, ok as dynamic)
    v = 0
    if ok = true then v = 1
    print "CAP " + id + " " + v.toStr()
end sub
