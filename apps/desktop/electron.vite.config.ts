import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  // Bundle the workspace engine (TS source) and zod into main; the native addon is loaded at
  // runtime by path (main/native.ts), never bundled.
  main: {
    build: { externalizeDeps: false },
  },
  // Sandboxed preloads can't be ES modules; emit CommonJS.
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html'),
          pad: resolve(import.meta.dirname, 'src/renderer/pad.html'),
        },
      },
    },
  },
});
