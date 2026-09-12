import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        builder: resolve(__dirname, 'builder.html'),
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
