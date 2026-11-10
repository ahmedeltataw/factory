import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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

  // Physical containment against cwd for factory-fake
  const realCwd = realpathSync(process.cwd())
  const fakeDir = resolve(process.cwd(), 'factory-fake')

  // Reject redirected factory-fake (e.g. symlink or junction pointing outside cwd)
  try {
    const lstat = lstatSync(fakeDir)
    if (lstat.isSymbolicLink()) {
      const realFake = realpathSync(fakeDir)
      const relFake = relative(realCwd, realFake)
      if (
        !relFake ||
        relFake.startsWith('..') ||
        isAbsolute(relFake) ||
        relFake.split(sep).includes('..')
      ) {
        process.exit(2)
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      process.exit(2)
    }
  }

  mkdirSync(fakeDir, { recursive: true })
  const realFakeDir = realpathSync(fakeDir)
  const relFake = relative(realCwd, realFakeDir)
  if (
    !relFake ||
    relFake.startsWith('..') ||
    isAbsolute(relFake) ||
    relFake.split(sep).includes('..')
  ) {
    process.exit(2)
  }

  // Check output path
  const outputPath = resolve(fakeDir, `${taskId}.txt`)
  const relOutput = relative(realFakeDir, outputPath)
  if (
    !relOutput ||
    relOutput.startsWith('..') ||
    isAbsolute(relOutput) ||
    relOutput.split(sep).includes('..')
  ) {
    process.exit(2)
  }

  // Reject redirected output file (e.g. existing symlink)
  try {
    const outStat = lstatSync(outputPath)
    if (outStat.isSymbolicLink()) {
      process.exit(2)
    }
    const realOutput = realpathSync(outputPath)
    const relReal = relative(realFakeDir, realOutput)
    if (
      !relReal ||
      relReal.startsWith('..') ||
      isAbsolute(relReal) ||
      relReal.split(sep).includes('..')
    ) {
      process.exit(2)
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      process.exit(2)
    }
  }

  // Physical containment for runDir and worker.json
  const resolvedRunDir = resolve(runDir)
  mkdirSync(resolvedRunDir, { recursive: true })
  const realRunDir = realpathSync(resolvedRunDir)

  const workerPath = resolve(resolvedRunDir, 'worker.json')
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
    const realWorker = realpathSync(workerPath)
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
  const grandchildScript = `
const ppid = ${parentPid};
const timer = setInterval(() => {
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

  // 4. Write deterministic factory-fake/<taskId>.txt in cwd
  writeFileSync(outputPath, `factory-fake:${taskId}\n`, 'utf8')

  // 5. Honour FAKE_SLEEP_MS
  const sleepMs = process.env.FAKE_SLEEP_MS
    ? parseInt(process.env.FAKE_SLEEP_MS, 10)
    : 0
  if (!Number.isNaN(sleepMs) && sleepMs > 0) {
    await delay(sleepMs)
  }

  // 6. Clean up grandchild before normal exit
  await stopGrandchild(grandchild)

  // 7. Honour FAKE_EXIT_CODE
  const exitCode = process.env.FAKE_EXIT_CODE
    ? parseInt(process.env.FAKE_EXIT_CODE, 10)
    : 0
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode)
}

await main()
