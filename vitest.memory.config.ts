import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/memory/**/*.memory-test.ts'],
    testTimeout: 180_000,
  },
})
