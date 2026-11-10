import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: {
    index: 'supervisor/src/core/index.ts',
    factory: 'supervisor/src/cli/main.ts',
    'fake-executor': 'supervisor/src/executors/fake-executor.ts',
  },
  format: 'esm',
  dts: false,
  outDir: 'lib',
})
