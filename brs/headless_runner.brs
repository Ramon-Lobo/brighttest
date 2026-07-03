' headless_runner.brs — runs Rooibos-authored suites HEADLESSLY (no device, no SceneGraph).
'
' It reuses Rooibos's OWN compiled runtime (BaseTestSuite assertions, TestResult, RuntimeConfig)
' but replaces the scene-based TestRunner with a plain driver: instantiate each suite, walk its
' groups/testCases metadata, run each test method, and read the recorded result.
'
' Runs under @rokucommunity/brs (or brs-node) against the transpiled `out/` build. Tests that need
' real SceneGraph nodes (@SGNode) won't work here — those are the device-only (Rooibos) subset.

sub Main()
    RBSH_Run()
end sub

sub RBSH_Run()
    config = rooibos_RuntimeConfig()
    suiteMap = config.getTestSuiteClassMap()

    passed = 0
    failed = 0
    skipped = 0

    for each suiteName in suiteMap
        ctor = suiteMap[suiteName]

        ' @SGNode suites build a real SceneGraph node in their constructor (roSGNode), which doesn't
        ' exist headless. Constructing one throws — treat that as "device-only, skip".
        suite = invalid
        try
            suite = ctor()
        catch e
            skipped = skipped + 1
            print "SKIP " + suiteName + " (requires a device — SceneGraph/@SGNode suite)"
            continue for
        end try

        ' Belt-and-suspenders: if it constructed but is flagged as a node test, skip it too.
        if suite.nodeName <> invalid and suite.nodeName <> ""
            skipped = skipped + 1
            print "SKIP " + suiteName + " (SceneGraph @SGNode suite — runs on device only)"
            continue for
        end if

        print "SUITE " + suiteName

        ' suite-level setup (@BeforeAll equivalent)
        RBSH_CallIfPresent(suite, suite.setupFunctionName)

        for each group in suite.groupsData
            RBSH_CallIfPresent(suite, group.setupFunctionName)

            for each tc in group.testCases
                if tc.isIgnored = true then
                    continue for
                end if

                RBSH_CallIfPresent(suite, group.beforeEachFunctionName)

                result = rooibos_TestResult(tc)
                suite.currentResult = result
                suite.currentAssertLineNumber = 0
                RBSH_Invoke(suite, tc)

                label = group.name + " > " + tc.name
                if tc.isParamTest = true then
                    label = label + " " + RBSH_ParamsToStr(tc.rawParams)
                end if

                if result.isFail = true then
                    failed = failed + 1
                    print "  FAIL " + label + " -- " + result.getMessage()
                else
                    passed = passed + 1
                    print "  PASS " + label
                end if

                RBSH_CallIfPresent(suite, group.afterEachFunctionName)
            end for

            RBSH_CallIfPresent(suite, group.tearDownFunctionName)
        end for

        RBSH_CallIfPresent(suite, suite.tearDownFunctionName)
    end for

    print "__RESULT__ suite=rooibos passed=" + passed.toStr() + " failed=" + failed.toStr() + " skipped=" + skipped.toStr()
end sub

' Invoke a test method by name, binding m to the suite. Handles @params arity 0..6.
sub RBSH_Invoke(suite as object, tc as object)
    fn = tc.funcName
    if tc.isParamTest = true and tc.rawParams <> invalid then
        p = tc.rawParams
        n = p.count()
        if n = 0 then
            suite[fn]()
        else if n = 1 then
            suite[fn](p[0])
        else if n = 2 then
            suite[fn](p[0], p[1])
        else if n = 3 then
            suite[fn](p[0], p[1], p[2])
        else if n = 4 then
            suite[fn](p[0], p[1], p[2], p[3])
        else if n = 5 then
            suite[fn](p[0], p[1], p[2], p[3], p[4])
        else
            suite[fn](p[0], p[1], p[2], p[3], p[4], p[5])
        end if
    else
        suite[fn]()
    end if
end sub

sub RBSH_CallIfPresent(suite as object, fnName as dynamic)
    if fnName <> invalid and fnName <> "" and suite[fnName] <> invalid then
        suite[fnName]()
    end if
end sub

function RBSH_ParamsToStr(rawParams as dynamic) as string
    if rawParams = invalid then return ""
    out = "["
    for i = 0 to rawParams.count() - 1
        if i > 0 then out = out + ","
        item = rawParams[i]
        if type(item) = "roString" or type(item) = "String" then
            out = out + item
        else if item = invalid then
            out = out + "invalid"
        else
            out = out + RBSH_AnyToStr(item)
        end if
    end for
    return out + "]"
end function

function RBSH_AnyToStr(v as dynamic) as string
    t = type(v)
    if t = "Integer" or t = "roInt" or t = "roInteger" then return v.toStr()
    if t = "Boolean" or t = "roBoolean"
        if v then return "true"
        return "false"
    end if
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Str(v).trim()
    return "<" + t + ">"
end function
