import { defineConfig } from 'tsdown'
export default defineConfig({ entry: ['supervisor/src/core/index.ts'], format: 'esm', dts: false, outDir: 'lib' })
