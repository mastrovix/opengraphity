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
    allowedHosts: true,
  },
  appType: 'spa',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':  ['react', 'react-dom', 'react-router-dom'],
          'vendor-apollo': ['@apollo/client', 'graphql'],
          'vendor-flow':   ['@xyflow/react'],
          'vendor-charts': ['echarts', 'echarts-for-react'],
          'vendor-d3':     ['d3'],
          'vendor-ui':     ['lucide-react', 'sonner', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'vendor-i18n':   ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
          'vendor-misc':   ['keycloak-js', 'quickjs-emscripten'],
        },
      },
    },
  },
})
