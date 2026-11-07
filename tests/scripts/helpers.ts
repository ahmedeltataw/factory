import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const repoRoot = path.resolve(import.meta.dirname, '..', '..')
export const scriptsDir = path.join(repoRoot, 'scripts')
/** Static fixture base: tests/scripts/fixtures/<script>/<case>/ */
export const fixturesRoot = path.join(repoRoot, 'tests', 'scripts', 'fixtures')

export function fixturePath(script: string, ...parts: string[]): string {
  return path.join(fixturesRoot, script, ...parts)
}

export interface ScriptRun {
  status: number
  stdout: string
  stderr: string
}

/** Run a guard script with node and capture exit code + output. */
export function runScript(
  script: string,
  args: readonly string[] = [],
  opts: { cwd?: string } = {},
): ScriptRun {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? repoRoot,
  })
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

/** sha256 with the repo hash rule: CRLF normalized to LF first. */
export function sha256(text: string): string {
  return createHash('sha256')
    .update(Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8'))
    .digest('hex')
}

/** Same absolute path with a lower-cased drive letter (e.g. d:\foo). */
export function lowercaseDrive(p: string): string {
  return p.replace(/^[A-Z]:/, (m) => m.toLowerCase())
}
