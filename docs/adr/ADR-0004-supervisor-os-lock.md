# ADR-0004: supervisor operating-system lock

Status: proposed, local testing only · Date: 2026-11-08

The operating manual requires an operating-system lock as well as a persisted heartbeat lease; SQLite WAL and the mere existence of a file are not substitutes for that lock. For the local prototype, evaluate exact runtime dependency `fs-native-extensions` 1.5.3 (Apache-2.0) with install scripts disabled. Its published package contains Node prebuilt binaries for Windows x64 and Linux x64, and its source uses Windows `LockFileEx` and Linux open-file-description locks. The package archive's registry SHA-512 integrity was checked before probing. Its own documented locks are advisory: all cooperating Supervisor processes must use the same canonical lock path.

In an isolated Windows / Node 24 probe, a second process was refused while the first held the lock, succeeded after release, and succeeded after the owner process was terminated. This is preliminary evidence, not a security certification; Linux and full cross-process integration remain unverified. A native dependency adds binary provenance and compatibility risk and must remain pinned, reviewed, tested on every supported runtime/OS, and recorded in the lockfile. If the native module fails to load or lock, fail closed; do not silently fall back to an existence-based lock.

The database lease stores owner, generation and heartbeat. The OS lock prevents two cooperating live owners; the heartbeat and explicit stale-evidence comparison govern recovery. Never infer owner death from WAL, a file timestamp, or an expired heartbeat alone. See `M2-03.md` for the proposed contract and protected tests.
