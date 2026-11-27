# 1. Your first test

::: info At a glance
**What it is for:** running the whole loop once: write, pass, fail, fix.

**You will:**
- Write a function and its spec
- Run it headless, then break it on purpose
- Optionally run coverage or a device

**First command:** `npx brighttest`
:::

## Step 1 — Some code to test

Create `source/mathutils.brs`:

```brightscript
' source/mathutils.brs
function addNumbers(a as integer, b as integer) as integer
    return a + b
end function
```

::: info Why `source/`?
Roku only compiles BrightScript under `source/` and `components/`, so code and tests live there. Tests go in `source/tests/`.
:::

## Step 2 — A test for it

Create `source/tests/MathUtils.spec.bs`. The `.spec.bs` name matters: the default pattern is `**/*.spec.bs`.

```brightscript
namespace tests
  @suite("math utils")
  class MathUtilsTests extends rooibos.BaseTestSuite

    @describe("addNumbers")

    @it("adds two positive numbers")
    function _()
      result = addNumbers(2, 3)
      m.assertEqual(result, 5)
    end function

  end class
end namespace
```

The [next page](/writing-tests/anatomy) explains each line.

## Step 3 — Run it (headless)

1. From the project root, run `npx brighttest`.
2. Expected output:

   ```
   brighttest: headless lane

     ✓ addNumbers > adds two positive numbers

   ====================================================
     brighttest (headless): 1 passed, 0 failed
   ====================================================
   ```

No device: it runs on a simulator in Node in well under a second.

## Step 4 — Watch it fail

Never trust a test you have not seen fail.

1. Change the assertion:

   ```brightscript
   m.assertEqual(result, 6)   ' wrong on purpose
   ```

2. Run again. Expected output:

   ```
     ✗ addNumbers > adds two positive numbers  — expected "5 (Integer)" to equal "6 (Integer)"

     brighttest (headless): 0 passed, 1 failed
   ```

3. The command exits non-zero, so CI sees the break. The message shows actual (`5`) and expected (`6`).
4. Put back `5` and confirm it passes.

## Step 5 — (Optional) coverage, and running on a device

1. Coverage runs headless and writes LCOV:

   ```bash
   npx brighttest --coverage --lcov coverage/lcov.info
   ```

2. With a Roku in developer mode, `--cross-check` runs both lanes and diffs them:

   ```bash
   npx brighttest --cross-check --host <roku-ip> --password <dev-password>
   ```

Day to day you need no device: headless even runs SceneGraph node tests. The device is the fidelity reference.

## The loop you'll repeat forever

1. Write or change code, then a test.
2. Run `npx brighttest`.
3. Pass: continue. Fail: read the message, fix, rerun.

## Related

- [Anatomy of a test file](/writing-tests/anatomy): the spec, line by line

**Full guide:** [Your first test](full:/writing-tests/first-test) — the original wording.
