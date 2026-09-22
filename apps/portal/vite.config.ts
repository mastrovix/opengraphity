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
  ['vendor-react',    ['react-router-dom', 'react-dom', 'react']],
  ['vendor-apollo',   ['@apollo/client', 'graphql']],
  ['vendor-keycloak', ['keycloak-js']],
  ['vendor-i18n',     ['i18next-browser-languagedetector', 'react-i18next', 'i18next']],
  ['vendor-markdown', ['react-markdown', 'remark-gfm']],
]

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // `import.meta.dirname` e non `__dirname`: Vite 8 legge questo file con
      // il caricatore nativo, dove `__dirname` non esiste.
      '@': path.resolve(import.meta.dirname, './src'),
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
        /*
         * FUNZIONE, NON PIÙ OGGETTO (21 set 2026, Vite 8).
         *
         * Vite 8 ha cambiato bundler: sotto non c'è più rollup ma rolldown,
         * che accetta `manualChunks` solo come FUNZIONE — la forma a oggetto
         * fallisce con «Invalid type: Expected Function but received Object».
         *
         * I gruppi sono gli stessi di prima, dichiarati una volta sola qui
         * sopra: si cerca il primo pacchetto che compare nel percorso del
         * modulo, così aggiungerne uno resta una riga e non una condizione.
         *
         * La funzione è identica a quella di `apps/web` e di `apps/console`, e
         * resta duplicata di proposito: il Dockerfile di questa app copia solo
         * alcune cartelle nel contesto di build, e un file condiviso alla
         * radice non ci sarebbe. Il perché sta per intero in
         * `apps/web/vite.config.ts`.
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
