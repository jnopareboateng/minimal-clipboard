import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer-ui'),
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: path.resolve(__dirname, 'src/renderer-dist'),
    emptyOutDir: true
  }
});
