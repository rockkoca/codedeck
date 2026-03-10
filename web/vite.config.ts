import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8787', // local wrangler dev
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
