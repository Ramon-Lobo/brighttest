# Seams cookbook: extracting testable seams

Evidence: the patterns are BrightScript idioms checked for block balance by the snippet validator, not compiled.
The headless run compiles `Util_buildUrl`-style global functions (run on a copy of `examples/legacy-app`, where
`Util_buildUrl`, `Util_countKeys` and `Util_serialize` are plain global functions called from specs). Not
device-verified. The before/after code here is illustrative: it is not from any real app.

## What a seam is, and the order

A seam is a pure function (inputs in, value out, no `m`, no nodes, no network, no registry) that a spec can call
from `source/`. Order: (1) characterization spec for code that is already callable, (2) find the next block that is
not, (3) write the extraction as a proposal, (4) review by a human, (5) spec the new function, (6) flip one
expectation to see the spec fail, restore it.

Without edit permission, step 3 is a patch file made on a copy (recipe at the end). You never apply it to the app.
With permission, one extraction per change, behaviour unchanged, the spec in the same change.

## 1. Logic buried in a handler

Before:

```brightscript
sub onItemSelected()
  item = m.list.content.getChild(m.list.itemSelected)
  if item.rating = "TV-MA" and m.global.profile.kids = true then
    m.top.error = "Blocked for this profile"
  else
    m.top.deepLink = "details/" + item.id
  end if
end sub
```

After (extract the decision; the handler stays thin):

```brightscript
function Nav_decide(item as object, profile as object) as object
  if item.rating = "TV-MA" and profile.kids = true then
    return { error: "Blocked for this profile" }
  end if
  return { deepLink: "details/" + item.id }
end function

sub onItemSelected()
  item = m.list.content.getChild(m.list.itemSelected)
  result = Nav_decide(item, m.global.profile)
  if result.error <> invalid then
    m.top.error = result.error
  else
    m.top.deepLink = result.deepLink
  end if
end sub
```

The spec calls `Nav_decide({ rating: "TV-MA", id: "1" }, { kids: true })` directly. `m.global` is read at the edge and
passed in as an argument.

## 2. URL and request building inside a Task

Move string building out of `roUrlTransfer` code. The Task keeps `setUrl`, `GetToString` and the port loop.

```brightscript
function Api_buildUrl(base as string, path as string, query as object) as string
  url = base + "/" + path
  sep = "?"
  for each key in query
    url = url + sep + key + "=" + query[key].toStr()
    sep = "&"
  end for
  return url
end function
```

Note: AA key order is not guaranteed; spec one key per case or sort keys first.

## 3. Response parsing

```brightscript
function Api_parseItems(body as string) as object
  json = ParseJson(body)
  if type(json) <> "roAssociativeArray" or type(json.items) <> "roArray" then return []
  out = []
  for each raw in json.items
    out.push({ id: raw.id.toStr(), title: raw.title })
  end for
  return out
end function
```

Spec it with literal JSON strings, including a malformed body and an empty list. Parsing failures are where legacy
apps crash on `invalid`.

## 4. State changes: a reducer

Move the `if/else` chain that mutates a global bag into `fn(state, action) as object` that returns the next state.
The spec checks input and output; the caller assigns the result. `m.global` writes stay in the caller.

## 5. Things you cannot extract cheaply

| Pattern | Do this instead |
|---|---|
| Logic inside an inline CDATA script in the XML | The instrument plugin reports `inline-cdata-scene` for it, and a spec cannot import it. Propose moving the script to a `.brs` file as its own patch. |
| Observer chains across nodes | Characterize the visible result in an e2e flow, not a spec. |
| Task nodes | Do not test them with `@SGNode` (on the legacy-app copy the default run, which includes an `@SGNode` suite, printed nothing for over 100 s). Test the pure request and parse functions. |
| `Eval`, dynamic `CreateObject(name)` | Leave them. Note them as risks in the report (`assessing-a-roku-app`, `references/risky-patterns.md`). |

## Writing a proposal as a patch, never applying it

Work in a copy outside the app folder, then give the human a patch. Checked in bash and zsh on a scratch tree:

```bash
cp -R app work
rm -rf work/.git
git -C work init -q
git -C work add -A
git -C work -c user.name=agent -c user.email=agent@example.invalid commit -q -m baseline
# edit files under work/ only, then:
mkdir -p proposals
git -C work diff --no-color > proposals/001-extract-nav-decide.patch
```

Name the patch for what it does, one extraction per patch, and add one line on why and which spec covers it. The
human reviews and applies it (`git apply --check` first). Say which spec in `source/tests/` fails without the
change and which passes with it. Do not run `git apply` on the app, and do not commit to the app's repository.
