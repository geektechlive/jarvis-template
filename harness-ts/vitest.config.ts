import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      'ion-sdk': path.resolve(__dirname, '../ion/engine/extensions/sdk/ion-sdk/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
    testTimeout: 5000,
  },
})
