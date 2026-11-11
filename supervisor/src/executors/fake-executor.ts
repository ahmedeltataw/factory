import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

async function stopGrandchild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  try {
    child.kill('SIGTERM')
  } catch {
    // already dead
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, 1000)
  await exitPromise
  clearTimeout(timer)
}

function getCanonicalPath(p: string): string {
  const real = realpathSync.native ? realpathSync.native(p) : realpathSync(p)
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(real)) {
    return real.charAt(0).toUpperCase() + real.slice(1)
  }
  return real
}

function parseDecimalEnv(key: string): number | undefined {
  const val = process.env[key]
  if (val === undefined) return undefined
  if (!/^\d+$/.test(val)) {
    process.exit(2)
  }
  const num = Number(val)
  if (!Number.isSafeInteger(num)) {
    process.exit(2)
  }
  return num
}

function checkContainment(realCwd: string, p: string): void {
  const fullTarget = resolve(realCwd, p)
  let current = fullTarget
  const remainder: string[] = []

  while (true) {
    let exists = false
    try {
      lstatSync(current)
      exists = true
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        process.exit(2)
      }
    }

    if (exists) {
      break
    }

    const parent = dirname(current)
    if (parent === current) {
      process.exit(2)
    }
    remainder.unshift(basename(current))
    current = parent
  }

  let realAncestor: string
  try {
    realAncestor = getCanonicalPath(current)
  } catch {
    process.exit(2)
  }

  const targetRealPath = remainder.length > 0 ? resolve(realAncestor, ...remainder) : realAncestor

  const rel = relative(realCwd, targetRealPath)
  if (
    !rel ||
    rel === '.' ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    rel.split(/[/\\]/).includes('..') ||
    isAbsolute(rel)
  ) {
    process.exit(2)
  }

  if (remainder.length > 0) {
    try {
      const realStat = statSync(realAncestor)
      if (!realStat.isDirectory()) {
        process.exit(2)
      }
    } catch {
      process.exit(2)
    }
  } else {
    try {
      const realStat = statSync(realAncestor)
      if (realStat.isDirectory()) {
        process.exit(2)
      }
    } catch {
      process.exit(2)
    }
  }
}

async function main(): Promise<void> {
  const taskId = process.argv[2]
  const nonce = process.argv[3]
  const runDir = process.argv[4]

  // Validate taskId and arguments before any writes or spawning
  if (!taskId || !ID_REGEX.test(taskId)) {
    process.exit(2)
  }
  if (!nonce || !runDir) {
    process.exit(2)
  }

  // Validate ALL env inputs before writing any file or spawning
  const factoryAttemptNo = parseDecimalEnv('FACTORY_ATTEMPT_NO')
  const failUntilAttempt = parseDecimalEnv('FAKE_FAIL_UNTIL_ATTEMPT')
  const failCode = parseDecimalEnv('FAKE_FAIL_CODE') ?? 75
  const sleepMs = parseDecimalEnv('FAKE_SLEEP_MS') ?? 0
  const exitCode = parseDecimalEnv('FAKE_EXIT_CODE') ?? 0
  const fakeHang = parseDecimalEnv('FAKE_HANG')

  const attemptNo = factoryAttemptNo ?? 1
  const isHang = fakeHang === 1

  let fakeWritePaths: string[] | undefined
  if (process.env.FAKE_WRITE !== undefined) {
    if (process.env.FAKE_WRITE === '') {
      process.exit(2)
    }
    const rawList = process.env.FAKE_WRITE.split(',')
    fakeWritePaths = []
    for (const raw of rawList) {
      if (!raw || raw.trim() === '') {
        process.exit(2)
      }
      if (
        isAbsolute(raw) ||
        raw.startsWith('/') ||
        raw.startsWith('\\') ||
        /^[a-zA-Z]:/.test(raw)
      ) {
        process.exit(2)
      }
      const segments = raw.split(/[/\\]/)
      if (
        segments.includes('..') ||
        segments.some((s) => s === '') ||
        segments.every((s) => s === '.')
      ) {
        process.exit(2)
      }
      if (raw.endsWith('/') || raw.endsWith('\\')) {
        process.exit(2)
      }
      fakeWritePaths.push(raw)
    }
  }

  // Physical containment against cwd
  let realCwd: string
  try {
    realCwd = getCanonicalPath(process.cwd())
  } catch {
    process.exit(2)
  }

  // Validate FAKE_WRITE containment
  if (fakeWritePaths) {
    for (const p of fakeWritePaths) {
      checkContainment(realCwd, p)
    }
  }

  // Validate output path containment (factory-fake/<taskId>.txt)
  checkContainment(realCwd, join('factory-fake', `${taskId}.txt`))

  // RunDir setup
  const resolvedRunDir = resolve(runDir)
  mkdirSync(resolvedRunDir, { recursive: true })
  const realRunDir = getCanonicalPath(resolvedRunDir)

  const workerPath = resolve(realRunDir, 'worker.json')
  const relWorker = relative(realRunDir, workerPath)
  if (
    !relWorker ||
    relWorker.startsWith('..') ||
    isAbsolute(relWorker) ||
    relWorker.split(sep).includes('..')
  ) {
    process.exit(2)
  }

  // Reject redirected worker file (e.g. existing symlink)
  try {
    const workerStat = lstatSync(workerPath)
    if (workerStat.isSymbolicLink()) {
      process.exit(2)
    }
    const realWorker = getCanonicalPath(workerPath)
    const relRealWorker = relative(realRunDir, realWorker)
    if (
      !relRealWorker ||
      relRealWorker.startsWith('..') ||
      isAbsolute(relRealWorker) ||
      relRealWorker.split(sep).includes('..')
    ) {
      process.exit(2)
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      process.exit(2)
    }
  }

  // 1. Write initial worker.json with own pid and nonce
  writeFileSync(workerPath, JSON.stringify({ pid: process.pid, nonce }))

  // 2. Spawn grandchild process with parent-death detection
  const parentPid = process.pid
  const watchdog = process.env.FAKE_NO_WATCHDOG !== '1'
  const grandchildScript = `
const ppid = ${parentPid};
const watchdog = ${watchdog};
const timer = setInterval(() => {
  if (!watchdog) return;
  try {
    process.kill(ppid, 0);
  } catch {
    clearInterval(timer);
    process.exit(0);
  }
}, 200);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
`
  const grandchild = spawn(
    process.execPath,
    ['-e', grandchildScript, `factory-grandchild-${nonce}`],
    {
      stdio: 'ignore',
      windowsHide: true,
      detached: !watchdog,
    },
  )

  const grandchildPid = grandchild.pid
  if (!grandchildPid) {
    throw new Error('fake-executor: failed to spawn grandchild')
  }

  // 3. Record grandchild pid in worker.json
  writeFileSync(
    workerPath,
    JSON.stringify({ pid: process.pid, nonce, grandchildPid }),
  )

  // 4. Precedence: FAKE_HANG > FAKE_FAIL_UNTIL_ATTEMPT > FAKE_EXIT_CODE > normal
  if (isHang) {
    setInterval(() => {}, 60000)
    await new Promise(() => {})
    return
  }

  if (failUntilAttempt !== undefined && attemptNo <= failUntilAttempt) {
    // Failure path: stop grandchild, atomically write result.json, exit with failCode, no output file
    await stopGrandchild(grandchild)
    const resultPath = join(realRunDir, 'result.json')
    const temporaryResultPath = join(realRunDir, `result.${process.pid}.tmp`)
    writeFileSync(temporaryResultPath, JSON.stringify({ exitCode: failCode }))
    renameSync(temporaryResultPath, resultPath)
    process.exit(failCode)
  }

  // Normal / FAKE_EXIT_CODE path:
  // Write deterministic factory-fake/<taskId>.txt in cwd
  const fakeDir = resolve(realCwd, 'factory-fake')
  mkdirSync(fakeDir, { recursive: true })
  const outputPath = resolve(fakeDir, `${taskId}.txt`)
  writeFileSync(outputPath, `factory-fake:${taskId}\n`, 'utf8')

  // Write FAKE_WRITE files if requested
  if (fakeWritePaths) {
    for (const p of fakeWritePaths) {
      const targetPath = resolve(realCwd, p)
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, `fake-write:${taskId}:${p}\n`, 'utf8')
    }
  }

  // Honour FAKE_SLEEP_MS
  if (sleepMs > 0) {
    await delay(sleepMs)
  }

  // Clean up grandchild before normal exit
  await stopGrandchild(grandchild)

  // Atomically write result.json
  const resultPath = join(realRunDir, 'result.json')
  const temporaryResultPath = join(realRunDir, `result.${process.pid}.tmp`)
  writeFileSync(temporaryResultPath, JSON.stringify({ exitCode }))
  renameSync(temporaryResultPath, resultPath)
  process.exit(exitCode)
}

await main()
