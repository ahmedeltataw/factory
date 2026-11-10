import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
