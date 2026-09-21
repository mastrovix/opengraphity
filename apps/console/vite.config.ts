import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * I gruppi di dipendenze esterne, per non spedire un bundle solo.
 *
 * L'ORDINE CONTA: si prende il primo che combacia, quindi i pacchetti più
 * specifici vanno prima di quelli che li contengono come prefisso.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['vendor-react',    ['react-dom', 'react']],
  ['vendor-keycloak', ['keycloak-js']],
]

export default defineConfig({
  plugins: [react()],
  // `import.meta.dirname` e non `__dirname`: Vite 8 legge questo file con il
  // caricatore nativo, dove `__dirname` non esiste.
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
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
        /*
         * FUNZIONE, NON PIÙ OGGETTO (21 set 2026, Vite 8): rolldown, il
         * bundler sotto Vite 8, accetta `manualChunks` solo come funzione.
         * Vedi il commento esteso in `apps/web/vite.config.ts`.
         */
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          for (const [gruppo, pacchetti] of VENDOR_CHUNKS) {
            if (pacchetti.some((nome) => id.includes(`/node_modules/${nome}/`) || id.includes(`+${nome.replace('/', '+')}@`))) {
              return gruppo
            }
          }
          return undefined
        },
      },
    },
  },
})
