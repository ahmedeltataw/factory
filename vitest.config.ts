import { defineConfig } from 'vitest/config'

const processTests = [
  'tests/m2-05-fixes.spec.ts',
  'tests/m3-03-worktree-evidence.spec.ts',
  'tests/m3-04-fixes.spec.ts',
  'tests/m3-07-status.spec.ts',
  'tests/protected/m1-acceptance-safety.spec.ts',
  'tests/protected/m1-traceability-strict.spec.ts',
  'tests/protected/m2-lease-close-failure.spec.ts',
  'tests/protected/m2-lease-process.spec.ts',
  'tests/protected/m2-status-cli.spec.ts',
  'tests/protected/m3-fence.spec.ts',
  'tests/protected/m3-init-cli.spec.ts',
  'tests/protected/m3-outbox-property.spec.ts',
  'tests/protected/m3-outbox.spec.ts',
  'tests/protected/m3-process-tree.spec.ts',
  'tests/protected/m3-recovery-property.spec.ts',
  'tests/protected/m3-recovery.spec.ts',
  'tests/protected/m3-status.spec.ts',
  'tests/protected/m3-worktree-evidence.spec.ts',
  'tests/scripts/check-evidence.spec.ts',
  'tests/scripts/check-forbidden-imports.spec.ts',
  'tests/scripts/check-manifest.spec.ts',
  'tests/scripts/check-scope.spec.ts',
  'tests/scripts/check-traceability.spec.ts',
  'tests/scripts/windows-paths.spec.ts',
]

const timeouts = { testTimeout: 30000, hookTimeout: 30000 }

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    passWithNoTests: true,
    ...timeouts,
    projects: [
      {
        test: { name: 'parallel', include: ['tests/**/*.spec.ts'], exclude: processTests, ...timeouts },
      },
      {
        test: {
          name: 'process',
          include: processTests,
          ...timeouts,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
