import { defineConfig } from 'vitest/config';

// Served from chasestruse.github.io/starmap/ (built files are copied into the site repo).
export default defineConfig({
  base: '/starmap/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
