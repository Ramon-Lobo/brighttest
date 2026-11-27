# Anonymizing

Remove, then replace with a placeholder such as `<ip-1>` or `<token>`:

- names of companies, clients, apps and channels (use `my-app`);
- host names, IP addresses, device serial numbers;
- tokens, passwords, cookies and `Authorization` values, including in command lines and URLs;
- personal paths (home directory, user name);
- screenshots and `tree.xml` dumps of a real app.

## Commands

```sh
brighttest issue redact <file>... [-o <file|dir>] [--project <dir>] [--json]
brighttest issue check  <file>... [--project <dir>] [--json]
```

- Both run locally: no network, no device, no lease. Files or stdin (`-`) in.
- `redact` masks the usual shapes with numbered placeholders (one mapping across all inputs), writes to stdout for one
  input or to `-o`, then checks what it wrote. Its summary on stderr is counts only.
- `check` prints `file:line kind` for what is left (never the value) and lints the field-report structure. It ends
  with `fingerprint: bt-xxxxxxxx`.
- Exit `0` no findings (structure warnings alone do not fail), `1` findings (`redact` still writes its output), `2`
  usage.
- Names to mask beyond the automatic ones go in `.brighttest/issue-deny.txt`, one per line (use `--project <dir>` to
  point at another project). Do not put real private names in a file you commit.

## Loop

`redact` then `check`; on exit 1, edit the listed lines by hand and `check` again until exit 0. Then read the whole text
once more. Passing `check` is necessary, not sufficient.
