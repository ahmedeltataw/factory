// CHK-M1-03-f: manifest check — fixtures are built in a temp dir at test time
// and all hashes are computed in the test (never hard-coded).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runScript, sha256 } from './helpers.ts'

const coreSource = 'export const ok = 1\n'
const appSource = 'export const retry = (n: number) => n\n'
const crlfSource = 'export const x = 1\r\nexport const y = 2\r\n'
// dsh original content of a protected test (import into src/core/index.ts)
const protectedOriginal = "import { runStage } from '../src/core/index.ts'\nrunStage()\n"
// guarded copy: only the import line rewritten to the promoted path
const protectedPromoted = protectedOriginal.replaceAll(
  "'../src/core/index.ts'",
  "'../../supervisor/src/core/index.ts'",
)
const licenseText = 'Copyright (c) 2026 DeepSeek Harness Team\nMIT license text\n'

interface ManifestFixture {
  dir: string
}

function buildFixture(files: Record<string, string>, manifest: unknown): ManifestFixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'm1-03-manifest-'))
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  mkdirSync(path.dirname(path.join(dir, 'SOURCE_MANIFEST.json')), { recursive: true })
  writeFileSync(path.join(dir, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest))
  return { dir }
}

const passingEntries = [
  {
    path: 'src/core/ok.ts',
    blob_sha256: sha256(coreSource),
    action: 'port-verbatim',
  },
  {
    path: 'src/app/retry-health.ts',
    blob_sha256: sha256(appSource),
    action: 'port-verbatim',
  },
  {
    // written with CRLF, hashed with the LF-normalized rule
    path: 'src/core/crlf.ts',
    blob_sha256: sha256(crlfSource),
    action: 'port-verbatim',
  },
  {
    path: 'tests/stage.spec.ts',
    blob_sha256: sha256(protectedOriginal),
    action: 'protected-test (one import line rewritten)',
  },
  {
    path: 'tests/retry-health.spec.ts',
    blob_sha256: '',
    action: 'port-adapt',
  },
  {
    path: 'LICENSE',
    blob_sha256: '',
    action: 'attribution',
  },
]

const passingManifest = {
  schema_version: 2,
  source: { license_sha256: sha256(licenseText) },
  files_selected_for_m1: passingEntries,
}

const passingFiles = {
  'supervisor/src/core/ok.ts': coreSource,

  'supervisor/src/app/retry-health.ts': appSource,
  'supervisor/src/core/crlf.ts': crlfSource,
  'tests/protected/stage.spec.ts': protectedPromoted,
  'tests/protected/retry-health.spec.ts': 'export {}\n',
  'licenses/dsh-superagent-MIT.txt': licenseText,
}

describe('check-manifest', () => {
  it('passes when every file matches its blob hash', () => {
    const fixture = buildFixture(passingFiles, passingManifest)
    try {
      const run = runScript('check-manifest.mjs', ['--root', fixture.dir])
      expect(run.status).toBe(0)
      expect(run.stdout.trim()).toContain('OK')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('fails on a hash mismatch and lists the file', () => {
    const manifest = {
      ...passingManifest,
      files_selected_for_m1: [
        { ...passingEntries[0], blob_sha256: '0'.repeat(64) },
        ...passingEntries.slice(1),
      ],
    }
    const fixture = buildFixture(passingFiles, manifest)
    try {
      const run = runScript('check-manifest.mjs', ['--root', fixture.dir])
      expect(run.status).toBe(1)
      const lines = run.stdout.trimEnd().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^FAIL: .*mismatch: src\/core\/ok\.ts/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('fails on a missing ported file', () => {
    const files: Record<string, string> = { ...passingFiles }
    delete files['supervisor/src/app/retry-health.ts']
    const fixture = buildFixture(files, passingManifest)
    try {
      const run = runScript('check-manifest.mjs', ['--root', fixture.dir])
      expect(run.status).toBe(1)
      const lines = run.stdout.trimEnd().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^FAIL: .*missing: src\/app\/retry-health\.ts/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('fails when the license hash does not match the attribution entry', () => {
    const manifest = {
      ...passingManifest,
      source: { license_sha256: 'f'.repeat(64) },
    }
    const fixture = buildFixture(passingFiles, manifest)
    try {
      const run = runScript('check-manifest.mjs', ['--root', fixture.dir])
      expect(run.status).toBe(1)
      expect(run.stdout.trim()).toMatch(/^FAIL: .*mismatch: LICENSE/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('fails when a protected-test hash is computed without the import rewrite', () => {
    // expectation deliberately set to the promoted content's hash: guard must
    // revert ../src/core/index.ts before hashing, so promoted != original.
    const manifest = {
      ...passingManifest,
      files_selected_for_m1: [
        ...passingEntries.slice(0, 3),
        { ...passingEntries[3], blob_sha256: sha256(protectedPromoted) },
        ...passingEntries.slice(4),
      ],
    }
    const fixture = buildFixture(passingFiles, manifest)
    try {
      const run = runScript('check-manifest.mjs', ['--root', fixture.dir])
      expect(run.status).toBe(1)
      expect(run.stdout.trim()).toMatch(/^FAIL: .*mismatch: tests\/stage\.spec\.ts/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('fails when SOURCE_MANIFEST.json is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'm1-03-manifest-'))
    try {
      const run = runScript('check-manifest.mjs', ['--root', dir])
      expect(run.status).toBe(1)
      expect(run.stdout.trim()).toMatch(/^FAIL: /)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
