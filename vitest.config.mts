import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          include: ['packages/domain/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
