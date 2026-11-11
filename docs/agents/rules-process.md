# Rules: code and tests that spawn or kill OS processes

Learned from M3-04, M3-04-fix and M3-04-fix2.

- Identify a process by (pid, creationTime), never by pid alone, because PIDs get reused. On Windows use CIM `CreationDate` → UTC ticks; on Linux use `/proc/<pid>/stat` field 22.
- A child is a member of the tree only if its parent pid matches AND its creation time is ≥ the parent's.
- Windows: a non-detached child sits in its parent's kill-on-close job object and dies with the parent. Detach it if it must outlive the parent.
- Windows: `taskkill /T` misses children spawned during the kill. Re-enumerate and re-kill by identity until none are left, with a deadline.
- PowerShell 5.1 CIM output comes in the OEM code page. Fetch CommandLine as base64 UTF-16, only for the pid you filtered on, and fail closed on a malformed record.
- Never kill without verifying identity (nonce, or pid + creation time).
- Tests: use a unique nonce per test run (`randomUUID()`), never a fixed literal; concurrent runs (mutation testing, acceptance) share the machine. Use a temp cwd, never `process.cwd()`.
- Mutation testing does not see code that runs in child processes. Kill mutants with in-process tests that call the exported functions with stubs.
- Inside the Codex sandbox Windows CIM is denied. Real-process tests run outside the sandbox (by the Lead).
- Windows short (8.3) paths: GitHub's Windows runners have TEMP = `C:\Users\RUNNER~1\...`. Compare canonical real paths. Reproduce locally with `TEMP=<8.3 path> TMP=<8.3 path>` (get it from `Scripting.FileSystemObject.GetFolder(p).ShortPath`). Canonicalize with Node `fs.realpathSync.native` (verified: `C:PROGRA~1` → `C:Program Files`). `Scripting.FileSystemObject.GetFolder(p).Path` and `[IO.Path]::GetFullPath` keep the 8.3 alias, so do not use them.

## Protected tests (learned from M4-05 and M4-06)

- Use only frozen interfaces: the fake executor env vars named in the milestone contract, the exported functions, the `LoopDeps` wrap* hooks, and DB state you seed yourself. Never add executor env vars, `NODE_OPTIONS` preloads, lockfiles or barrier directories the contract does not name.
- Never match internal SQL text or positional call arguments; a correct implementation may write different SQL.
- Every spawned worker gets its own unique nonce. A shared nonce breaks UNIQUE constraints and identity checks.
- Never assert against the whole `process.env` (`toEqual`/`objectContaining({...process.env})`). A failure prints every environment variable, secrets included, into the run log. Assert only the keys the test sets.
- Cleanup never kills on `identity-mismatch`; revalidate identity (nonce) before any fallback kill.
