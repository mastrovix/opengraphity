import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5174,
    allowedHosts: true,
    proxy: {
      '/graphql': { target: 'http://localhost:4000', changeOrigin: true },
      '/api':     { target: 'http://localhost:4000', changeOrigin: true },
      '/realms':  { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  appType: 'spa',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':    ['react', 'react-dom', 'react-router-dom'],
          'vendor-apollo':   ['@apollo/client', 'graphql'],
          'vendor-keycloak': ['keycloak-js'],
          'vendor-i18n':     ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
