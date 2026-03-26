import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: './postcss.config.js',
  },
  test: {
    environment: 'jsdom',
    css: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
