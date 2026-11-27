# Writing tests — start here

::: info At a glance
**What it is for:** writing BrightScript tests from scratch. No Rooibos, BrighterScript or testing experience needed.

**You will:**
- Learn what a test and an assertion are
- See how one spec runs headless and on a device
- Pick your next page

**First file to open:** [Your first test](/writing-tests/first-test)
:::

::: tip Prerequisites
Do the [Quick start](/guide/getting-started) first (about five minutes).
:::

## What is a unit test?

A unit test runs one piece of code with known inputs and checks the output.

- Example: "Given `add(2, 3)`, expect `5`. If not, fail and show what I got."
- That "expect … to be …" check is an **assertion**. A test is some setup plus one or more assertions.
- If the tests still pass after a change, you probably broke nothing.

## The mental model for this project

Write tests once in [Rooibos](https://github.com/rokucommunity/rooibos) syntax; run the same `.spec.bs` in two lanes.

| Lane | Use |
|---|---|
| **Headless** (default, no device, fast, CI) | Everyday loop. Includes `@SGNode` node tests and coverage (`--coverage`) |
| **Device** (real Roku) | Fidelity reference. `--cross-check` diffs both lanes |

Only tests that need real render-thread timing need a device: mark them `@deviceOnly` and the fast lanes skip them.

## Vocabulary you'll see

| Term | Meaning |
|---|---|
| **Assertion** | A check like `m.assertEqual(actual, expected)`; failing it fails the test |
| **Test** (`@it`) | One named scenario with assertions |
| **Group** (`@describe`) | Related tests |
| **Suite** (`@suite`) | A class of groups and tests, usually one per file |
| **Spec file** | A `*.spec.bs` file with one or more suites |
| **Fixture / setup** | State prepared before a test |
| **Test double** | A stand-in dependency: mock, stub or spy |
| **Headless** | Running on a simulator in Node, no device |

## How this guide is organized

Read in order once, then use as a reference.

1. [Your first test](/writing-tests/first-test): pass, fail, pass
2. [Anatomy of a test file](/writing-tests/anatomy): every line
3. [Assertions](/writing-tests/assertions): all `m.assert*` methods
4. [Organizing tests](/writing-tests/organizing): suites, groups, layout
5. [Parameterized tests](/writing-tests/parameterized): many inputs
6. [Setup & teardown](/writing-tests/setup-teardown): fixtures, cleanup
7. [Mocks, stubs & spies](/writing-tests/test-doubles): isolation
8. [SceneGraph & async tests](/writing-tests/scenegraph-async): node tests (headless)
9. [Headless vs device](/writing-tests/headless-vs-device): what runs where
10. [Cookbook](/writing-tests/cookbook): recipes
11. [Common mistakes](/writing-tests/mistakes): errors and fixes

## Related

- [Quick start](/guide/getting-started): install and set up

**Full guide:** [Writing tests — start here](full:/writing-tests/) — the original wording.
