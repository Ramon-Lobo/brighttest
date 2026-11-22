' BTMedia_* : headless-only media-state driver for specs (COV-16).
' Drives a SceneGraph Video or Audio node through explicit, deterministic steps (no timers, no wall clock) so a spec
' can assert how the app reacts to buffering / playing / error / finished. It only writes ordinary node fields, so the
' app's own observers run as they do for any field write. Nothing here is real playback: a passing spec shows the app
' handles the sequence the spec chose, not that a device emits it. Reserved prefix: BTMedia_.
' Specs opt in with:  import "pkg:/source/bt/BTMedia.brs"
' Every call returns an AA of the fields it wrote and throws a string on misuse, so a mis-set step fails loudly.

function BTMedia_load(node as object, steps = [0, 33, 66, 100] as object) as object
  BTMedia_kind_(node, "load")
  node.state = "buffering"
  last = invalid
  for each p in steps
    last = { percentage: p, isUnderrun: false, prebufferDone: p >= 33 }
    node.bufferingStatus = last
  end for
  return { state: "buffering", bufferingStatus: last }
end function

function BTMedia_play(node as object, opts = {} as object) as object
  BTMedia_kind_(node, "play")
  out = { state: "playing" }
  d = invalid
  if opts.duration <> invalid then
    d = opts.duration
  else
    c = node.content
    if c <> invalid and c.length <> invalid and c.length > 0 then d = c.length
  end if
  if d <> invalid then
    node.duration = d
    out.duration = d
  end if
  node.state = "playing"
  return out
end function

function BTMedia_tick(node as object, seconds as dynamic) as object
  BTMedia_kind_(node, "tick")
  d = node.duration
  if d = invalid or d <= 0 then throw "BTMedia_tick: no duration (call BTMedia_play with opts.duration first)"
  stepSize = node.notificationInterval
  if stepSize = invalid or stepSize <= 0 then stepSize = 0.5
  cur = node.position
  if cur = invalid then cur = 0
  target = cur + seconds
  loopIt = (node.loop = true)
  out = { position: cur }
  while cur < target
    cur = cur + stepSize
    if cur > target then cur = target
    if cur >= d then
      if loopIt then
        cur = 0
        target = target - d
        node.position = 0
        out.position = 0
      else
        node.position = d
        node.state = "finished"
        return { position: d, state: "finished" }
      end if
    else
      node.position = cur
      out.position = cur
    end if
  end while
  return out
end function

function BTMedia_pause(node as object) as object
  BTMedia_kind_(node, "pause")
  node.state = "paused"
  return { state: "paused" }
end function

function BTMedia_resume(node as object) as object
  BTMedia_kind_(node, "resume")
  node.state = "playing"
  return { state: "playing" }
end function

function BTMedia_stop(node as object) as object
  BTMedia_kind_(node, "stop")
  if node.asyncStopSemantics = true then node.state = "stopping"
  node.state = "stopped"
  return { state: "stopped" }
end function

function BTMedia_finish(node as object) as object
  BTMedia_kind_(node, "finish")
  d = node.duration
  out = { state: "finished" }
  if d <> invalid and d > 0 then
    node.position = d
    out.position = d
  end if
  node.state = "finished"
  return out
end function

function BTMedia_fail(node as object, code as integer, msg = "" as string, info = {} as object) as object
  kind = BTMedia_kind_(node, "fail")
  node.errorCode = code
  node.errorMsg = msg
  out = { state: "error", errorCode: code, errorMsg: msg }
  if kind = "video" then
    node.errorStr = msg
    node.errorInfo = info
    out.errorStr = msg
    out.errorInfo = info
  end if
  node.state = "error"
  return out
end function

function BTMedia_next(node as object, index as integer) as object
  BTMedia_kind_(node, "next")
  node.contentIndex = index
  return { contentIndex: index }
end function

' Answers the app's last command: reads node.control and applies the matching transition.
function BTMedia_sync(node as object) as object
  BTMedia_kind_(node, "sync")
  c = node.control
  if c = invalid then c = "none"
  if c = "play" or c = "replay" then
    BTMedia_load(node)
    return BTMedia_play(node)
  else if c = "prebuffer" then
    return BTMedia_load(node)
  else if c = "pause" then
    return BTMedia_pause(node)
  else if c = "resume" then
    return BTMedia_resume(node)
  else if c = "stop" then
    return BTMedia_stop(node)
  else if c = "none" then
    return {}
  end if
  throw "BTMedia_sync: unknown control value '" + c + "'"
end function

' Returns "video" or "audio"; throws for anything else.
function BTMedia_kind_(node as dynamic, op as string) as string
  if type(node) = "roSGNode" then
    s = node.subtype()
    if s = "Video" then return "video"
    if s = "Audio" then return "audio"
  end if
  throw "BTMedia_" + op + ": expected a Video or Audio node"
end function
