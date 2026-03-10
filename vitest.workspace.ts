import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'daemon',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      exclude: ['test/e2e/**', '**/node_modules/**'],
      environment: 'node',
      globals: false,
    },
  },
  {
    test: {
      name: 'worker',
      include: ['worker/test/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
      globals: false,
    },
  },
  {
    test: {
      name: 'web',
      include: ['web/test/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'jsdom',
      globals: false,
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['test/e2e/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
      globals: false,
      testTimeout: 30000, // E2E tests spawn real tmux + agent processes which take several seconds
    },
  },
]);
