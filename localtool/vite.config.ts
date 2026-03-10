import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = path.resolve(__dirname, '..');

export default defineConfig({
  base: './',
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@': projectRoot,
    },
  },
  server: {
    fs: { allow: [projectRoot] },
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
  },
});
