import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    // Integration tests start isolated services; bound process fan-out on developer/CI hosts.
    maxWorkers: 2,
    testTimeout: 10_000,
  },
});
