' Behavior probe app: each test prints "@@B|core|<id>|<value>". Run with probe-behavior.js (zip + brs-cli).
sub main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.setMessagePort(port)
  scene = screen.CreateScene("ProbeScene")
  screen.show()
  m.log = ""
  tests = [t_observe_sync, t_nodeevent, t_callfunc, t_coercion, t_global, t_tree, t_focus, t_content, t_timer, t_task, t_video, t_registry, t_appinfo, t_deviceinfo, t_misc, t_port, t_alwaysnotify, t_unobserve, t_alias, t_bounds, t_dialog, t_fieldapi, t_json, t_datetime, t_regex, t_lifecycle]
  names = ["observe_sync", "nodeevent", "callfunc", "coercion", "global", "tree", "focus", "content", "timer", "task", "video", "registry", "appinfo", "deviceinfo", "misc", "port", "alwaysnotify", "unobserve", "alias", "bounds", "dialog", "fieldapi", "json", "datetime", "regex", "lifecycle"]
  for i = 0 to tests.count() - 1
    try
      tests[i](scene, port, screen)
    catch e
      emit(names[i] + ".EXC", e.message)
    end try
  end for
  emit("done", "1")
end sub

function s(v as dynamic) as string
  t = type(v)
  if t = "roString" or t = "String" then return v
  if t = "Integer" or t = "roInt" or t = "roInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" or t = "LongInteger" or t = "roLongInteger" or t = "roIntrinsicDouble" then return v.ToStr()
  if t = "Boolean" or t = "roBoolean" then
    if v then return "true"
    return "false"
  end if
  if v = invalid then return "invalid"
  if t = "roSGNode" then return "node<" + v.subtype() + ">"
  if t = "roList" then
    o = "list["
    for each e in v
      o = o + s(e) + ","
    end for
    return o + "]"
  end if
  if t = "roAssociativeArray" or t = "roArray" then
    j = FormatJson(v)
    return j
  end if
  return "<" + t + ">"
end function
sub emit(id as string, v as dynamic)
  r = s(v).Replace(chr(10), "\n")
  print "@@B|core|" + id + "|" + r
end sub
sub cbX(ev)
  m.log = m.log + "cb;"
end sub

sub t_observe_sync(scene, port, screen)
  r = CreateObject("roSGNode", "Child").callFunc("obsSync")
  for each k in r
    emit("observe_sync." + k, r[k])
  end for
  ' observing from Main with a function-name callback
  emit("observe_sync.from_main_funcname", scene.observeField("x", "cbX"))
end sub
sub t_nodeevent(scene, port, screen)
  scene.observeField("y", port)
  scene.y = 9
  msg = wait(500, port)
  emit("nodeevent.type", type(msg))
  if type(msg) = "roSGNodeEvent" then
    emit("nodeevent.getField", msg.getField())
    emit("nodeevent.getData", msg.getData())
    emit("nodeevent.getRoSGNode", msg.getRoSGNode())
    emit("nodeevent.isSGNodeEvent_info", msg.getInfo())
  end if
end sub
sub t_callfunc(scene, port, screen)
  kid = CreateObject("roSGNode", "Child")
  emit("callfunc.add", kid.callFunc("add", 2, 3))
  emit("callfunc.noret", kid.callFunc("noret"))
  emit("callfunc.unknown", kid.callFunc("nosuch"))
  emit("callfunc.noargs", kid.callFunc("echoArgs"))
  emit("callfunc.aa", kid.callFunc("echoAA", { a: 1 }))
  emit("callfunc.scene", scene.callFunc("runAll", port))
end sub
sub t_coercion(scene, port, screen)
  n = CreateObject("roSGNode", "Node")
  n.addField("i", "integer", false) : n.addField("f", "float", false) : n.addField("str", "string", false) : n.addField("b", "boolean", false)
  n.addField("arr", "array", false) : n.addField("v2", "vector2d", false) : n.addField("col", "color", false) : n.addField("t", "time", false) : n.addField("aa", "assocarray", false)
  n.i = 3.7 : emit("coerce.int_from_float", n.i)
  n.i = "5" : emit("coerce.int_from_string", n.i)
  n.i = true : emit("coerce.int_from_bool", n.i)
  n.i = invalid : emit("coerce.int_from_invalid", n.i)
  n.f = 3 : emit("coerce.float_from_int", type(n.f) + ":" + s(n.f))
  n.str = 5 : emit("coerce.str_from_int", type(n.str) + ":" + s(n.str))
  n.b = 1 : emit("coerce.bool_from_int", n.b)
  n.v2 = [1, 2] : emit("coerce.v2d_types", type(n.v2[0]) + "," + type(n.v2[1]))
  n.col = "0xFF0000FF" : emit("coerce.color_from_string", type(n.col) + ":" + s(n.col))
  n.col = &hFF0000FF : emit("coerce.color_from_int", type(n.col) + ":" + s(n.col))
  n.arr = { a: 1 } : emit("coerce.array_from_aa", type(n.arr))
  n.aa = [1] : emit("coerce.aa_from_array", type(n.aa))
  n.t = 12 : emit("coerce.time", type(n.t) + ":" + s(n.t))
  l = CreateObject("roSGNode", "Label")
  l.translation = [10, 20] : emit("coerce.translation_types", type(l.translation[0]))
  l.width = 5 : emit("coerce.width_int_to_float", type(l.width))
  l.visible = "true" : emit("coerce.visible_from_string", l.visible)
  l.text = 12 : emit("coerce.text_from_int", l.text)
  l.opacity = "0.5" : emit("coerce.opacity_from_string", l.opacity)
end sub
sub t_global(scene, port, screen)
  emit("global.m_global_in_main", m.global)
  g = screen.getGlobalNode()
  emit("global.type", type(g) + ":" + g.subtype())
  g.addFields({ gA: 1, gS: "x" })
  emit("global.addFields", g.gA)
  emit("global.hasField", g.hasField("gA"))
  g.addField("gB", "string", false)
  g.setField("gB", "bee") : emit("global.setField", g.gB)
  emit("global.observe_sync", CreateObject("roSGNode", "Child").callFunc("globalObserve"))
  kid = CreateObject("roSGNode", "Child")
  emit("global.in_component", kid.callFunc("readGlobal"))
  emit("global.getChildCount", g.getChildCount())
end sub
sub t_tree(scene, port, screen)
  g = CreateObject("roSGNode", "Group")
  a = g.createChild("Label") : a.id = "a"
  b = CreateObject("roSGNode", "Rectangle") : b.id = "b"
  emit("tree.append_ret", g.appendChild(b))
  c = CreateObject("roSGNode", "Poster") : c.id = "c"
  emit("tree.insert_ret", g.insertChild(c, 0))
  emit("tree.count", g.getChildCount())
  emit("tree.order", g.getChild(0).id + g.getChild(1).id + g.getChild(2).id)
  emit("tree.getChild_oob", g.getChild(99))
  emit("tree.parent", b.getParent().subtype())
  emit("tree.findNode", g.findNode("b"))
  emit("tree.findNode_attached_scene", scene.findNode("kid"))
  emit("tree.findNode_self", g.findNode(""))
  emit("tree.findNode_missing", g.findNode("zzz"))
  emit("tree.replaceChild", g.replaceChild(CreateObject("roSGNode", "Group"), 1))
  emit("tree.removeChild", g.removeChild(c))
  emit("tree.removeChildIndex", g.removeChildIndex(0))
  emit("tree.count2", g.getChildCount())
  g2 = CreateObject("roSGNode", "Group")
  g2.appendChild(b) : emit("tree.reparent_old_parent_count", g.getChildCount())
  emit("tree.getChildren", g2.getChildren(-1, 0).count())
  emit("tree.clone_deep", g2.clone(true).getChildCount())
  emit("tree.isSameNode", g2.isSameNode(g2))
  emit("tree.getScene", b.getScene())
  scene.appendChild(g2)
  emit("tree.getScene_attached", b.getScene().subtype())
  emit("tree.createChildren", g.createChildren(3, "Rectangle").count())
  emit("tree.appendChildren", g.appendChildren([CreateObject("roSGNode", "Label")]))
  emit("tree.insertChildren", g.insertChildren([CreateObject("roSGNode", "Label")], 0))
  emit("tree.removeChildren", g.removeChildren([g.getChild(0)]))
  emit("tree.removeChildrenIndex", g.removeChildrenIndex(1, 0))
  emit("tree.reparent", g.reparent(g2, false))
  emit("tree.subtype", g.subtype() + ":" + s(g.isSubtype("Node")))
  emit("tree.parent_null", CreateObject("roSGNode", "Group").getParent())
end sub
sub t_focus(scene, port, screen)
  g = CreateObject("roSGNode", "Group") : g.id = "g"
  b = CreateObject("roSGNode", "Button") : b.id = "btn"
  g.appendChild(b) : scene.appendChild(g)
  emit("focus.setFocus_ret", b.setFocus(true))
  emit("focus.hasFocus", b.hasFocus())
  emit("focus.isInFocusChain_btn", b.isInFocusChain())
  emit("focus.isInFocusChain_group", g.isInFocusChain())
  emit("focus.group_hasFocus", g.hasFocus())
  emit("focus.focusedChild", scene.focusedChild)
  emit("focus.group_focusedChild_id", g.focusedChild.id)
  b.setFocus(false) : emit("focus.after_unfocus", b.hasFocus())
  emit("focus.focusable_field", g.focusable)
  emit("focus.focusedChild_field_exists", scene.hasField("focusedChild"))
  emit("focus.setFocus_detached", CreateObject("roSGNode", "Group").setFocus(true))
end sub
sub t_content(scene, port, screen)
  cn = CreateObject("roSGNode", "ContentNode")
  cn.title = "T" : cn.url = "http://x/y.m3u8" : cn.streamFormat = "hls"
  emit("content.fields", cn.title + "|" + cn.url + "|" + cn.streamFormat)
  emit("content.addField", cn.addField("custom", "string", false))
  emit("content.addField_dup", cn.addField("custom", "string", false))
  emit("content.addFields", cn.addFields({ one: 1, two: "2" }))
  emit("content.setFields", cn.setFields({ title: "X", description: "D", undeclared: 5 }))
  emit("content.hasField_undeclared", cn.hasField("undeclared"))
  emit("content.update", cn.update({ title: "U", extra: "E" }, true))
  emit("content.update_extra", cn.extra)
  emit("content.removeField", cn.removeField("extra"))
  emit("content.getField_missing", cn.getField("zzz"))
  emit("content.getFieldTypes", cn.getFieldTypes().title)
  emit("content.getFields_has_title", cn.getFields().title)
  emit("content.field_count", cn.getFields().count())
  ch = CreateObject("roSGNode", "ContentNode") : ch.title = "child"
  cn.appendChild(ch) : emit("content.child", cn.getChild(0).title)
  emit("content.clone", cn.clone(true).getChild(0).title)
  emit("content.keys", cn.keys().count())
  emit("content.count", cn.count())
  emit("content.lookup", cn.lookup("title"))
  emit("content.dot_assoc", cn["title"])
  emit("content.items_field", type(cn.PLAYSTART))
end sub
sub t_timer(scene, port, screen)
  tm = CreateObject("roSGNode", "Timer")
  tm.duration = 0.05 : tm.repeat = false
  tm.observeField("fire", port)
  tm.control = "start"
  msg = wait(1000, port)
  emit("timer.fire_event", type(msg))
  msg = wait(300, port)
  emit("timer.no_repeat", type(msg))
  tm.repeat = true : tm.control = "start"
  c = 0
  while c < 3
    msg = wait(500, port)
    if type(msg) = "roSGNodeEvent" then c = c + 1 else exit while
  end while
  emit("timer.repeat_count", c)
  tm.control = "stop"
end sub
sub t_task(scene, port, screen)
  task = CreateObject("roSGNode", "ProbeTask")
  task.input = 5
  task.observeField("output", port)
  task.observeField("state", port)
  emit("task.initial_state", task.state)
  task.control = "RUN"
  states = ""
  out = invalid
  t0 = CreateObject("roTimespan")
  while t0.TotalMilliseconds() < 4000
    msg = wait(200, port)
    if type(msg) = "roSGNodeEvent" then
      if msg.getField() = "state" then states = states + msg.getData() + ","
      if msg.getField() = "output" then out = msg.getData()
      if states.instr("stop") >= 0 and out <> invalid then exit while
    end if
  end while
  emit("task.states", states)
  emit("task.output", out)
  emit("task.final_state", task.state)
  emit("task.progress_field", task.hasField("progress"))
end sub
sub t_video(scene, port, screen)
  v = CreateObject("roSGNode", "Video")
  scene.appendChild(v)
  c = CreateObject("roSGNode", "ContentNode")
  c.url = "http://127.0.0.1:9/none.mp4" : c.streamFormat = "mp4"
  v.content = c
  v.observeField("state", port)
  emit("video.initial_state", v.state)
  v.control = "play"
  seq = ""
  t0 = CreateObject("roTimespan")
  while t0.TotalMilliseconds() < 1500
    msg = wait(100, port)
    if type(msg) = "roSGNodeEvent" then seq = seq + msg.getData() + ","
  end while
  emit("video.states_seen", seq)
  emit("video.position", v.position)
  v.control = "stop"
end sub
sub t_registry(scene, port, screen)
  r = CreateObject("roRegistrySection", "probe")
  emit("registry.write", r.Write("k", "v"))
  emit("registry.read_before_flush", r.Read("k"))
  emit("registry.flush", r.Flush())
  emit("registry.exists", r.Exists("k"))
  emit("registry.keys", r.GetKeyList().count())
  emit("registry.writeMulti", r.WriteMulti({ a: "1", b: "2" }))
  emit("registry.readMulti", r.ReadMulti(["a", "b"]))
  emit("registry.delete", r.Delete("k"))
  rr = CreateObject("roRegistry")
  emit("registry.sections", rr.GetSectionList())
  emit("registry.getSpaceAvailable", rr.GetSpaceAvailable() > 0)
  emit("registry.delete_section", rr.Delete("probe"))
end sub
sub t_appinfo(scene, port, screen)
  a = CreateObject("roAppInfo")
  emit("appinfo.title", a.GetTitle())
  emit("appinfo.version", a.GetVersion())
  emit("appinfo.custom", a.GetValue("custom_key"))
  emit("appinfo.id", a.GetID())
  emit("appinfo.isDev", a.IsDev())
  emit("appinfo.subtitle", a.GetSubtitle())
  emit("appinfo.devid", a.GetDevID())
  emit("appinfo.getValue_missing", a.GetValue("nosuch"))
end sub
sub t_deviceinfo(scene, port, screen)
  d = CreateObject("roDeviceInfo")
  emit("deviceinfo.model", d.GetModel())
  emit("deviceinfo.modelDisplay", d.GetModelDisplayName())
  emit("deviceinfo.osVersion", d.GetOSVersion())
  emit("deviceinfo.displaySize", d.GetDisplaySize())
  emit("deviceinfo.displayType", d.GetDisplayType())
  emit("deviceinfo.country", d.GetUserCountryCode())
  emit("deviceinfo.uuid_len", len(d.GetRandomUUID()))
  emit("deviceinfo.connection", d.GetConnectionType())
  emit("deviceinfo.friendly", d.GetFriendlyName())
  emit("deviceinfo.rida_disabled", d.IsRIDADisabled())
  emit("deviceinfo.timezone", d.GetTimeZone())
  emit("deviceinfo.canDecodeVideo", d.CanDecodeVideo({ Codec: "h264" }))
  emit("deviceinfo.audioOutputChannel", d.GetAudioOutputChannel())
  emit("deviceinfo.getUIResolution", d.GetUIResolution())
  emit("deviceinfo.hasFeature", d.HasFeature("5.1_surround_sound"))
end sub
sub t_misc(scene, port, screen)
  emit("misc.str_float", str(1.5))
  emit("misc.type_int", type(5) + type(5.5) + type("a") + type(true) + type(invalid) + type(5&) + type(5#))
  emit("misc.box", type(box(5)))
  emit("misc.getInterface", type(GetInterface(5, "ifInt")))
  emit("misc.uptime", UpTime(0) >= 0)
  emit("misc.rnd", Rnd(10) < 10)
  emit("misc.val", Val("12abc"))
  emit("misc.strToI", StrToI("0x10"))
  emit("misc.substitute", Substitute("{0}-{1}", "a", "b"))
  emit("misc.tr", Tr("%s"))
  ba = CreateObject("roByteArray") : ba.FromAsciiString("hello")
  emit("misc.bytearray_b64", ba.ToBase64String())
  emit("misc.bytearray_hex", ba.ToHexString())
  x = CreateObject("roXMLElement")
  emit("misc.xml_parse", x.Parse("<a k='1'><b>t</b></a>"))
  emit("misc.xml_name", x.GetName() + ":" + x@k + ":" + x.b.GetText())
  emit("misc.xml_gen", x.GenXML(false))
  emit("misc.list", CreateObject("roList").count())
  emit("misc.path", CreateObject("roPath", "pkg:/source/main.brs").IsValid())
  emit("misc.fs_exists", CreateObject("roFileSystem").Exists("pkg:/manifest"))
  emit("misc.readAscii", len(ReadAsciiFile("pkg:/manifest")) > 0)
  emit("misc.writeAscii", WriteAsciiFile("tmp:/p.txt", "x") and ReadAsciiFile("tmp:/p.txt") = "x")
  emit("misc.listdir", ListDir("pkg:/").count() > 0)
  emit("misc.matchfiles", MatchFiles("pkg:/", "m*").count())
  emit("misc.deepcopy", type(CreateObject("roUtils")))
  emit("misc.systemlog", type(CreateObject("roSystemLog")))
  tm = CreateObject("roTimespan") : emit("misc.timespan", tm.TotalMilliseconds() >= 0)
  emit("misc.longint", str(2147483647& + 1&).trim())
  emit("misc.int_overflow", 2147483647 + 1)
  emit("misc.int_div", 7 \ 2)
  emit("misc.mod", 7 mod 3)
  emit("misc.float_fmt", 0.1 + 0.2)
  emit("misc.double_fmt", 0.1# + 0.2#)
  emit("misc.str_cmp", "abc" < "abd")
  emit("misc.aa_case", { Abc: 1 }.abc)
  emit("misc.aa_order", FormatJson({ b: 1, a: 2 }))
  emit("misc.ucase", UCase("ñ"))
end sub
sub t_port(scene, port, screen)
  p = CreateObject("roMessagePort")
  t = CreateObject("roTimespan")
  r = wait(120, p)
  emit("port.timeout_returns_invalid", r)
  emit("port.timeout_elapsed_ok", t.TotalMilliseconds() >= 100)
  emit("port.getMessage_empty", p.GetMessage())
  emit("port.peek", p.PeekMessage())
end sub
sub t_alwaysnotify(scene, port, screen)
  r = CreateObject("roSGNode", "Child").callFunc("alwaysNotifyTest")
  for each k in r
    emit("alwaysnotify." + k, r[k])
  end for
end sub
sub cntCb(ev)
  m.cnt = m.cnt + 1
end sub
sub t_unobserve(scene, port, screen)
  r = CreateObject("roSGNode", "Child").callFunc("unobserveTest")
  for each k in r
    emit("unobserve." + k, r[k])
  end for
  kid = CreateObject("roSGNode", "Child")
  emit("unobserve.scoped", kid.callFunc("scopedObserve"))
  emit("unobserve.scoped_fired", kid.callFunc("scopedResult"))
  emit("unobserve.unobserveScoped", kid.callFunc("scopedUnobserve"))
end sub
sub t_alias(scene, port, screen)
  kid = CreateObject("roSGNode", "Child")
  kid.label = "hi"
  emit("alias.forwarded", kid.callFunc("innerText"))
  emit("alias.default", kid.dflt)
  emit("alias.onChange_xml", kid.callFunc("changeCount"))
  emit("alias.readonly", kid.hasField("ro"))
  kid.ro = 4
  emit("alias.readonly_after_write", kid.ro)
  emit("alias.getFieldType", kid.getFieldType("label"))
end sub
sub t_bounds(scene, port, screen)
  l = CreateObject("roSGNode", "Label") : l.text = "Hello world"
  scene.appendChild(l)
  r = l.boundingRect()
  emit("bounds.label_width_gt0", r.width > 0)
  emit("bounds.label_keys", r)
  emit("bounds.local", l.localBoundingRect())
  emit("bounds.scene", l.sceneBoundingRect())
  emit("bounds.wrappedLines_single", l.wrappedLines)
  emit("bounds.isTextTruncated", l.isTextTruncated)
  w = CreateObject("roSGNode", "Label") : w.width = 100 : w.wrap = true : w.text = "Hello world this is a long text that wraps over lines"
  scene.appendChild(w)
  emit("bounds.wrap_height_gt_single", w.boundingRect().height > l.boundingRect().height)
  emit("bounds.wrappedLines_wrapped", w.wrappedLines)
  emit("bounds.multistyle", CreateObject("roSGNode", "MultiStyleLabel").boundingRect())
  p = CreateObject("roSGNode", "Poster") : p.width = 50 : p.height = 40
  emit("bounds.poster_loadStatus", p.loadStatus)
  lg = CreateObject("roSGNode", "LayoutGroup") : lg.layoutDirection = "horiz"
  a1 = lg.createChild("Rectangle") : a1.width = 10 : a1.height = 10
  a2 = lg.createChild("Rectangle") : a2.width = 20 : a2.height = 10
  scene.appendChild(lg)
  emit("bounds.layoutgroup_child2_x", a2.boundingRect().x)
  emit("bounds.layoutgroup_bounds", lg.boundingRect())
  rl = CreateObject("roSGNode", "Rectangle") : rl.width = 100 : rl.height = 50 : rl.translation = [10, 20]
  emit("bounds.rect", rl.boundingRect())
  emit("bounds.group_empty", CreateObject("roSGNode", "Group").boundingRect())
end sub
sub t_dialog(scene, port, screen)
  d = CreateObject("roSGNode", "StandardMessageDialog")
  d.title = "T" : d.message = ["m"] : d.buttons = ["OK"]
  scene.dialog = d
  emit("dialog.scene_dialog_set", type(scene.dialog))
  emit("dialog.dialog_hasFocus", d.isInFocusChain())
  scene.dialog = invalid
  emit("dialog.cleared", scene.dialog)
end sub
sub t_fieldapi(scene, port, screen)
  n = CreateObject("roSGNode", "Node")
  emit("fieldapi.addField_ret", n.addField("f1", "string", false))
  emit("fieldapi.addField_badtype", n.addField("f2", "nosuchtype", false))
  emit("fieldapi.getFieldType", n.getFieldType("f1"))
  emit("fieldapi.getField_missing", n.getField("zzz"))
  emit("fieldapi.setField_missing", n.setField("zzz", 1))
  emit("fieldapi.setField_ret", n.setField("f1", "v"))
  emit("fieldapi.setFields_ret", n.setFields({ f1: "w" }))
  emit("fieldapi.getFields_keys", n.getFields().count())
  emit("fieldapi.removeField", n.removeField("f1"))
  emit("fieldapi.hasField_after", n.hasField("f1"))
  emit("fieldapi.focusable_default", n.focusable)
  emit("fieldapi.change_field", type(n.change))
  emit("fieldapi.id_default", n.id)
  n.id = "x" : emit("fieldapi.id", n.id)
  emit("fieldapi.setFields_unknown", n.setFields({ nosuch: 1 }))
  emit("fieldapi.observeFieldScoped_ret", n.observeFieldScoped("id", "cbX"))
  emit("fieldapi.notifyField", n.hasField("notifyField"))
  emit("fieldapi.canGetRef_member", FindMemberFunction(n, "canGetRef"))
  emit("fieldapi.moveIntoField", n.hasField("moveIntoField"))
  emit("fieldapi.httpAgent_member", FindMemberFunction(n, "getHttpAgent"))
end sub
sub t_json(scene, port, screen)
  emit("json.parse_nested", FormatJson(ParseJson("{""a"":[1,2,{""b"":null}],""c"":1.5e2}")))
  emit("json.parse_bad", ParseJson("{bad"))
  emit("json.big_int", ParseJson("[12345678901234]")[0])
  emit("json.format_float", FormatJson([1.0, 0.5, 100000000]))
  emit("json.format_str_escape", FormatJson("a/b""c" + chr(10)))
  emit("json.format_flag1", FormatJson({ k: "é" }, 1))
  emit("json.format_node", FormatJson(CreateObject("roSGNode", "Group")))
  emit("json.format_invalid", FormatJson(invalid))
  emit("json.parse_unicode", ParseJson("[""é""]")[0])
  emit("json.parse_flags", type(ParseJson("{""a"":1}", "i")))
  emit("json.dup_keys", ParseJson("{""a"":1,""a"":2}").a)
end sub
sub t_datetime(scene, port, screen)
  d = CreateObject("roDateTime")
  d.FromSeconds(1700000000)
  emit("datetime.iso", d.ToISOString())
  emit("datetime.dow", d.GetDayOfWeek())
  emit("datetime.year", d.GetYear())
  emit("datetime.asSeconds", d.AsSeconds())
  emit("datetime.fromISO", d.FromISO8601String("2020-01-02T03:04:05.678Z"))
  emit("datetime.ms", d.GetMilliseconds())
  emit("datetime.after_iso", d.ToISOString())
  d.ToLocalTime() : emit("datetime.local_hour_is_int", type(d.GetHours()))
  emit("datetime.asDateString", d.AsDateString("long-date"))
  emit("datetime.asDateStringNoParam", d.AsDateStringNoParam())
  d2 = CreateObject("roDateTime")
  d2.Mark()
  emit("datetime.mark_now_gt", d2.AsSeconds() > 1700000000)
  emit("datetime.getTimeZoneOffset", d.GetTimeZoneOffset())
  emit("datetime.getLastDayOfMonth", d.GetLastDayOfMonth())
end sub
sub t_regex(scene, port, screen)
  r = CreateObject("roRegex", "(\d+)-(\w+)", "")
  emit("regex.isMatch", r.IsMatch("12-ab"))
  emit("regex.match", r.Match("12-ab"))
  emit("regex.matchAll", r.MatchAll("1-a 2-b").count())
  emit("regex.replace", r.Replace("12-ab", "\2_\1"))
  emit("regex.replaceAll", CreateObject("roRegex", "a", "").ReplaceAll("banana", "o"))
  emit("regex.split", CreateObject("roRegex", ",", "").Split("a,b,,c"))
  emit("regex.flag_i", CreateObject("roRegex", "ab", "i").IsMatch("AB"))
  emit("regex.inline_i", CreateObject("roRegex", "(?i)ab", "").IsMatch("AB"))
  emit("regex.lookahead", CreateObject("roRegex", "a(?=b)", "").IsMatch("ab"))
  emit("regex.named", CreateObject("roRegex", "(?<n>a)", "").Match("a"))
  emit("regex.recursion_pcre_only", type(CreateObject("roRegex", "\((?:[^()]|(?R))*\)", "")))
end sub
sub t_lifecycle(scene, port, screen)
  emit("lifecycle.scene_children", scene.getChildCount())
  emit("lifecycle.kid_via_findNode", scene.findNode("kid").subtype())
  emit("lifecycle.kid_init_ran", scene.findNode("kid").callFunc("initRan"))
  emit("lifecycle.scene_global_log", screen.getGlobalNode().initLog)
end sub
