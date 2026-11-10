# Rules: PowerShell 5.1 scripts (acceptance/*.ps1)

Learned from M2-08 and M3-08 reviews. Check your script against every line before you hand it over.

## Encoding
- Save `[Console]::OutputEncoding`, `[Console]::InputEncoding` and `$OutputEncoding`; set all to UTF-8; restore all three in the outer `finally`.
- PS 5.1 reads native output in the OEM code page unless set. Never parse non-ASCII from a native command without setting encoding first.

## Native commands
- Check `$LASTEXITCODE` right after every native call. Never use `$?` for native exit status.
- Capture stdout and stderr separately (`2>` to its own file, or Start-Process with `-RedirectStandardOutput` and `-RedirectStandardError`). Never `2>&1` before `ConvertFrom-Json`.
- Parse `--json` from stdout only, with `ConvertFrom-Json`. A parse failure is a step failure with the raw text in the log, not a silent retry.
- `ConvertFrom-Json` unwraps one-element arrays: wrap with `@(...)` before counting or indexing.
- Text checks are anchored: `-match '^...$'`.

## Node helpers
- Node snippets go in temp `.mjs` files. Inputs come through env vars. No inline `node -e` with quotes.

## Background processes
- `Start-Process -PassThru` with its own stdout and stderr log per child; read `$p.Handle` on the next line (otherwise ExitCode is lost).
- Track every started process in one list.
- When you wait for a process to exit: use a deadline, then assert the exit code you expect.

## Waits
- Every loop has a deadline and fails the step on timeout with the last observed value in the message.
- Poll for the full condition, not part of it. Example: wait for worker.json to have pid AND nonce AND a positive grandchildPid. `$null` must never count as "gone".

## Isolation
- One per-run directory: `$env:TEMP\<suite>\<runNonce>`. Never delete or reuse the shared parent; two runs at once must not touch each other.
- Every process the script starts carries the run nonce. Use a unique run nonce, never a fixed literal.

## Cleanup and verdict
- One outer `try/finally`. All cleanup lives inside `finally`: stop tracked processes, sweep processes by nonce, `git worktree remove --force` (check its exit code), then delete the run directory.
- Kill only processes whose pid we started, or whose command line has our nonce. After killing, wait with a deadline and assert none survive. If any survive, the verdict is FAIL and the run directory is kept.
- Exactly one final line `<Suite>: PASS` or `<Suite>: FAIL`, from one verdict variable, and the exit code matches it.

## Asserting
- Assert what the spec says, counted exactly: "exactly one evidence row" means count across all attempts == 1. "Commit on branch X" means `git rev-parse X`, then count commits from base to X.
- A fault scenario must reach the effect it claims to test. Check the effect order in the code, and assert the state at the crash boundary before you restart.

## Parsing
- Inside double-quoted strings, a variable followed by `:` is parsed as a drive/scope reference: `"$code: x"` is a parse error. Write `"${code}: x"` or `"$($code): x"`. Search the whole file for `\$[A-Za-z_]+:` before you hand over.

## Which process you started
- `node` on PATH may be a launcher (nvm `.nodejs\node.exe`, Volta, shims) that starts the real node as a child. Killing the launcher leaves the real process running. Resolve the real binary once with `node -p "process.execPath"` and start that path with Start-Process.
- The cleanup sweep matches every process whose command line contains this run's directory (and nonce). After the sweep, assert none survive.
- A failed assertion prints the values it compared (expected and actual), not only True/False.
- Variable names are case-insensitive. Never name a variable `$pid`, `$pId`, `$host`, `$input`, `$args`, `$error`, `$home`, `$matches`, `$_` (automatic/read-only). Use `$procId`, `$workerPid`, etc. Search the file for these before handing over.
- PS 5.1 `Remove-Item -Recurse` fails on paths over 260 characters (pnpm `node_modules`), with "Could not find a part of the path". To delete a run directory: first mirror an empty directory into it with `robocopy <empty> <dir> /MIR` (exit codes 0-7 mean success), then `Remove-Item`. Assert the directory is gone.
