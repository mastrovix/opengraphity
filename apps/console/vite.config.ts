import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    host: true,
    port: 5175,
    allowedHosts: true,
    proxy: {
      // La console parla SOLO con `/platform` e con Keycloak: non ha GraphQL,
      // perché lo schema del prodotto è legato a un tenant e lei non ne ha uno.
      '/platform': { target: 'http://localhost:4000', changeOrigin: true },
      '/realms':   { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  appType: 'spa',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':    ['react', 'react-dom'],
          'vendor-keycloak': ['keycloak-js'],
        },
      },
    },
  },
})
