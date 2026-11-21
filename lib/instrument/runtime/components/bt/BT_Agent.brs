#if BT_AGENT
' brighttest instrument runtime: render-thread agent (STA-S-T1, read-only).
' Child of the Scene. Owns the __bt_agent Label and a BT_AgentTask whose ticks drive each publish. No write path in v0.
sub init()
    m.seq = 0
    m.renderMs = 0
    m.label = m.top.createChild("Label")
    m.label.id = "__bt_agent"
    m.label.translation = [-10000, -10000]
    m.label.width = 100
    m.label.height = 20
    BT_agentPublish()
    m.task = CreateObject("roSGNode", "BT_AgentTask")
    m.task.interval = BT_pubIntervalMs(BT_config())
    m.task.observeField("tick", "BT_agentOnTick")
    m.task.control = "RUN"
end sub

sub BT_agentOnTick()
    BT_agentPublish()
end sub

sub BT_agentPublish()
    clock = CreateObject("roTimespan")
    m.seq = m.seq + 1
    m.label.text = BT_labelJson(m.seq, m.global, m.top.getScene(), BT_config(), m.renderMs)
    m.renderMs = clock.TotalMilliseconds()
end sub
#end if
