import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4310,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4300' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
