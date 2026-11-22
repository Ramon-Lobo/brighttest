#if BT_AGENT
' brighttest instrument runtime: render-thread agent (STA-S-T1 read, STA-S-T6 write).
' Child of the Scene. Owns the __bt_agent Label and a BT_AgentTask. The Task's ticks drive each publish; commands the Task
' relays from the hub are applied here, on the render thread, in seq order. After a command changed state the Label is
' republished before the `reflected` ack is sent, so reflected means "a reader of the Label sees the change".
sub init()
    m.seq = 0
    m.lastInput = invalid
    m.renderMs = 0
    m.ctx = { global: m.global, scene: m.top.getScene(), cfg: BT_config(), state: { subscribed: false } }
    m.label = m.top.createChild("Label")
    m.label.id = "__bt_agent"
    m.label.translation = [-10000, -10000]
    m.label.width = 100
    m.label.height = 20
    BT_agentPublish()
    m.task = CreateObject("roSGNode", "BT_AgentTask")
    m.task.interval = BT_pubIntervalMs(BT_config())
    m.task.observeField("tick", "BT_agentOnTick")
    m.task.observeField("cmds", "BT_agentOnCmds")
    m.task.observeField("icmd", "BT_agentOnInput")
    m.global.addField("__btEv", "string", true)
    m.global.observeField("__btEv", "BT_agentOnEv")
    m.task.control = "RUN"
end sub

sub BT_agentOnEv(ev as object)
    m.task.acks = FormatJson({ v: 1, kind: "state.action", session: m.task.session, data: ParseJson(ev.getData()) }) + Chr(10)
end sub

sub BT_agentOnTick()
    BT_agentPublish()
end sub

sub BT_agentOnCmds()
    cmds = ParseJson(m.task.cmds)
    if type(cmds) <> "roArray" then return
    session = m.task.session
    lines = []
    last = 0
    if m.lastSeq <> invalid and m.lastSession = session then last = m.lastSeq
    m.lastSession = session
    for each cmd in cmds
        if type(cmd) = "roAssociativeArray" and cmd.seq <> invalid and cmd.id <> invalid then
            if cmd.seq > last then
                h = BT_wHandle(cmd, m.ctx, session)
                for each a in h.acks
                    lines.push(a)
                end for
                m.task.subscribed = m.ctx.state.subscribed
                if h.ok and BT_wIs(cmd.ack, "reflected") then
                    BT_agentPublish()
                    lines.push(BT_wAck(cmd, session, "reflected", invalid))
                end if
                last = cmd.seq
            end if
        end if
    end for
    m.lastSeq = last
    if lines.count() > 0 then
        BT_agentPublish()
        out = ""
        for each l in lines
            out = out + l + Chr(10)
        end for
        m.task.acks = out
    end if
end sub

' STA-S-T13: one complete command from the ECP /input mailbox (the event's own value, so back-to-back commands are
' never coalesced). No hub seq, so no seq dedupe: the receiver ignores repeated chunks and finished command ids. The
' mailbox runs only without a hub session, so there is no ack channel; the result goes to the Label's `input` entry.
sub BT_agentOnInput(ev as object)
    r = BT_inputRun(ev.getData(), m.ctx, m.task.session)
    if r = invalid then return
    m.task.subscribed = m.ctx.state.subscribed
    m.lastInput = r.last
    BT_agentPublish()
end sub

sub BT_agentPublish()
    clock = CreateObject("roTimespan")
    m.seq = m.seq + 1
    m.label.text = BT_labelJson(m.seq, m.global, m.top.getScene(), BT_config(), m.renderMs, m.lastInput)
    m.renderMs = clock.TotalMilliseconds()
    if m.task <> invalid then m.task.docBytes = Len(m.label.text)
end sub
#end if
