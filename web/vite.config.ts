import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:1999',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../server/web-dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 把体积大且很少变动的库拆开：发版时用户只需重新下载业务代码
        manualChunks: {
          react: ['react', 'react-dom'],
          tanstack: ['@tanstack/react-query', '@tanstack/react-router'],
          radix: ['radix-ui'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
