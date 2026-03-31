import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api/kalo': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      }
    }
  }
})
