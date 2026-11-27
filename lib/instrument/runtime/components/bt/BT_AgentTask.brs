#if BT_AGENT
' brighttest instrument runtime: agent Task (STA-S-T1 sampler, STA-S-T6 write path).
' One thread, one port. It ticks the sampler (`tick`), says hello to the hub, keeps exactly one long-poll outstanding,
' hands each batch of commands to the render-thread agent through `cmds` (a JSON array) and posts the ack lines the agent
' returns through `acks` (NDJSON, one line per ack, in order). The agent applies commands in seq order on the render thread;
' this Task never touches app state. `session` tells the agent which hub session to stamp acks with.
' STA-S-T13: an roInput receiver reassembles chunked /input commands and hands each complete one over in `icmd`.
' Cadence: BT_wCadence (500 ms with no hub or a subscriber, 5 s with a live hub session and no subscriber).
sub init()
    m.top.functionName = "BT_agentTaskRun"
end sub

sub BT_agentTaskRun()
    cfg = BT_config()
    port = CreateObject("roMessagePort")
    m.top.observeField("acks", port)
    m.top.observeField("subscribed", port)
    clock = CreateObject("roTimespan")
    inp = CreateObject("roInput")
    inp.SetMessagePort(port)
    inbox = BT_inputNew()
    n = 0
    nextTick = 0
    clamped = false
    retryAt = 0
    helloFails = 0
    session = ""
    after = 0
    poll = invalid
    post = invalid
    queue = []
    while true
        now = clock.TotalMilliseconds()
        if now >= nextTick then
            n = n + 1
            m.top.tick = n
            period = BT_wCadence(cfg, m.top.subscribed, session <> "", m.top.docBytes)
            nextTick = now + period
            clamp = BT_wClampEvent(cfg, m.top.docBytes, session, period)
            cs = BT_wClampStep(clamp, clamped, session <> "")
            clamped = cs.clamped
            if cs.send then queue = BT_wQueueAcks(queue, [clamp], true, 200)
        end if
        if session = "" and now >= retryAt and BT_wOrigin(cfg) <> "" then
            info = BT_wHelloInfo(cfg)
            after = 0
            if info <> invalid then
                session = info.session
                after = info.seq
            end if
            if session = "" then retryAt = now + BT_wHelloBackoff(helloFails) else m.top.session = session
            if session = "" then helloFails = helloFails + 1 else helloFails = 0
        end if
        if session <> "" and poll = invalid then
            poll = BT_wPollStart(cfg, session, after, port)
            if poll = invalid then
                session = ""
                m.top.session = ""
                retryAt = now + 5000
            end if
        end if
        if queue.count() > 0 and post = invalid and session <> "" then
            post = BT_wPostEvents(cfg, session, queue, port)
            queue = []
        end if
        BT_inputSweep(inbox, clock.TotalMilliseconds(), BT_inputTtlMs())
        left = nextTick - clock.TotalMilliseconds()
        if left < 1 then left = 1
        msg = wait(left, port)
        if type(msg) = "roSGNodeEvent" then
            if msg.getField() = "acks" then
                lines = []
                for each line in msg.getData().split(Chr(10))
                    if line <> "" then lines.push(line)
                end for
                queue = BT_wQueueAcks(queue, lines, session <> "", 200)
            end if
        else if type(msg) = "roInputEvent" then
            ' STA-S-T13: ECP /input mailbox, only while no hub session is live (with a hub, commands use the hub path).
            ' Only a complete command with the right token reaches the render thread; the rest is dropped silently.
            if session = "" then
                done = BT_inputFeed(inbox, msg.GetInfo(), clock.TotalMilliseconds(), cfg.token)
                if done <> invalid then m.top.icmd = BT_inputPack(done.id, done.text)
            end if
        else if type(msg) = "roUrlEvent" and msg.GetInt() = 1 then
            id = msg.GetSourceIdentity()
            if poll <> invalid and id = poll.GetIdentity() then
                poll = invalid
                r = BT_wParsePoll(msg)
                if r.kind = "cmds" then
                    for each c in r.cmds
                        if type(c) = "roAssociativeArray" and c.seq <> invalid then
                            if c.seq > after then after = c.seq
                        end if
                    end for
                    m.top.cmds = FormatJson(r.cmds)
                else if r.kind = "resync" then
                    session = r.session
                    after = 0
                    queue = []
                    m.top.session = session
                else if r.kind = "stop" then
                    session = ""
                    m.top.session = ""
                    retryAt = clock.TotalMilliseconds() + 30000
                else if r.kind = "error" then
                    session = ""
                    m.top.session = ""
                    retryAt = clock.TotalMilliseconds() + 5000
                end if
            else if post <> invalid and id = post.GetIdentity() then
                post = invalid
                if msg.GetResponseCode() = 409 then
                    session = ""
                    m.top.session = ""
                    retryAt = clock.TotalMilliseconds()
                end if
            end if
        end if
    end while
end sub
#end if
