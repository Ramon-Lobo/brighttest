' BTState_* : snapshot fixtures for specs (STA-S-T12).
' Turns a state snapshot captured by Studio ("save as spec fixture") or a flow's `snapshot:` step into a headless test
' scenario. The fixture lives at fixtures/state/<name>.json and has the saved shape {v, name, layers: {global, scene,
' registry, ...}}. Only the `global` layer can be seeded here; no other layer is written.
' Specs opt in with:  import "pkg:/source/bt/BTState.brs"
' Reserved prefix: BTState_ (the agent's own publisher helpers use other names).

' Reads a snapshot file (for example "pkg:/fixtures/state/premium.json") and returns the parsed document.
' Throws a string when the file is missing, empty or not a JSON object, so a bad path fails the spec loudly.
function BTState_load(path as string) as object
  text = ReadAsciiFile(path)
  if text = invalid or text = "" then throw "BTState_load: cannot read " + path
  doc = ParseJson(text)
  if doc = invalid or Type(doc) <> "roAssociativeArray" then throw "BTState_load: not a JSON object: " + path
  return doc
end function

' Writes the `global` layer onto m.global (pass snap.layers.global). Existing fields are updated, missing ones are
' created, so call it from an @SGNode beforeEach. Field names are used as given (Roku lowercases them on read).
' `target` defaults to m.global and exists so a spec can seed another node. Returns the key names written.
function BTState_seedGlobals(snapGlobal as object, target = invalid as dynamic) as object
  if snapGlobal = invalid or Type(snapGlobal) <> "roAssociativeArray" then throw "BTState_seedGlobals: expected the global layer (an object)"
  g = target
  if g = invalid then g = m.global
  if g = invalid then throw "BTState_seedGlobals: no m.global (call from an @SGNode spec)"
  written = []
  for each key in snapGlobal
    one = {}
    one[key] = snapGlobal[key]
    if g.hasField(key) then
      g.setFields(one)
    else
      g.addFields(one)
    end if
    written.push(key)
  end for
  return written
end function
