' BTState_* : snapshot fixtures for specs (STA-S-T12).
' Turns a state snapshot captured by Studio ("save as spec fixture") or a flow's `snapshot:` step into a headless test
' scenario. The fixture lives at fixtures/state/<name>.json and has the saved shape {v, name, layers: {global, scene,
' registry, ...}}. Only the `global` layer can be seeded here; no other layer is written.
' Specs opt in with:  import "pkg:/source/bt/BTState.brs"
' Reserved prefix: BTState_ (the agent's own publisher helpers use other names).

' Reads a snapshot file (for example "pkg:/fixtures/state/premium.json") and returns the parsed document.
' Throws a string when the file is missing, empty or not a JSON object. Check the path: in an @SGNode beforeEach a throw
' currently shows up as a CRASH line in the Rooibos output and the run can still report success.
function BTState_load(path as string) as object
  text = ReadAsciiFile(path)
  if text = invalid or text = "" then throw "BTState_load: cannot read " + path
  doc = ParseJson(text)
  if doc = invalid or Type(doc) <> "roAssociativeArray" then throw "BTState_load: not a JSON object: " + path
  return doc
end function

' Writes the `global` layer onto m.global (pass snap.layers.global), with the same rules as the agent's restore:
' built-in fields (change, focusable, focusedChild, id), invalid values, markers (<redacted:...>, $truncated:...,
' $type:..., {"$node":...}, checked inside objects and arrays) and values whose type does not match an existing
' field are skipped. Other fields are updated or created. Returns { written: [names], skipped: ["name: reason"] }.
' `target` defaults to m.global and exists so a spec can seed another node.
function BTState_seedGlobals(snapGlobal as object, target = invalid as dynamic) as object
  if snapGlobal = invalid or Type(snapGlobal) <> "roAssociativeArray" then throw "BTState_seedGlobals: expected the global layer (an object)"
  g = target
  if g = invalid then g = m.global
  if g = invalid then throw "BTState_seedGlobals: no m.global (call from an @SGNode spec)"
  out = { written: [], skipped: [] }
  builtins = ["change", "focusedchild", "focusable", "id"]
  for each key in snapGlobal
    v = snapGlobal[key]
    lk = LCase(key)
    isBuiltin = false
    for each b in builtins
      if b = lk then isBuiltin = true
    end for
    if isBuiltin or v = invalid then
      out.skipped.push(key + ": built-in or empty")
    else if BTState_isMarker_(v) then
      out.skipped.push(key + ": cut, redacted or a node reference")
    else
      ok = true
      if g.hasField(key) then
        ok = BTState_compat_(g[key], v)
        if ok then
          one = {}
          one[key] = v
          g.setFields(one)
        end if
      else
        one = {}
        one[key] = v
        g.addFields(one)
      end if
      if ok then
        out.written.push(key)
      else
        out.skipped.push(key + ": type does not match the existing field")
      end if
    end if
  end for
  return out
end function

function BTState_kind_(v as dynamic) as string
  t = Type(v)
  if v = invalid then return "invalid"
  if t = "roString" or t = "String" then return "string"
  if t = "roInt" or t = "roFloat" or t = "roDouble" or t = "roLongInteger" or t = "Integer" or t = "Float" or t = "Double" or t = "LongInteger" then return "number"
  if t = "roBoolean" or t = "Boolean" then return "boolean"
  if t = "roAssociativeArray" then return "object"
  if t = "roArray" then return "array"
  return "other"
end function

function BTState_compat_(old as dynamic, nv as dynamic) as boolean
  ok = BTState_kind_(old)
  nk = BTState_kind_(nv)
  if ok = "invalid" then return nk <> "other"
  if nk = "other" or nk = "invalid" then return false
  if ok <> nk then return false
  if ok = "number" and old = Int(old) and nv <> Int(nv) then return false
  return true
end function

function BTState_isMarker_(v as dynamic) as boolean
  k = BTState_kind_(v)
  if k = "string" then
    return Left(v, 11) = "$truncated:" or Left(v, 10) = "<redacted:" or Left(v, 6) = "$type:"
  else if k = "object" then
    if v.doesExist("$node") then return true
    for each key in v
      if BTState_isMarker_(v[key]) then return true
    end for
  else if k = "array" then
    for each item in v
      if BTState_isMarker_(item) then return true
    end for
  end if
  return false
end function
