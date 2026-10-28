import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      thresholds: {
        'src/engine.ts': { lines: 90 },
        'src/gestures.ts': { lines: 90 },
        'src/axes.ts': { lines: 90 },
        'src/layers.ts': { lines: 90 },
        'src/transport.ts': { lines: 90 },
      },
    },
  },
});
