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
  ['vendor-react',  ['react-router-dom', 'react-dom', 'react']],
  ['vendor-apollo', ['@apollo/client', 'graphql']],
  ['vendor-flow',   ['@xyflow/react']],
  ['vendor-charts', ['echarts-for-react', 'echarts']],
  ['vendor-d3',     ['d3']],
  ['vendor-ui',     ['lucide-react', 'sonner', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities']],
  ['vendor-i18n',   ['i18next-browser-languagedetector', 'react-i18next', 'i18next']],
  ['vendor-misc',   ['keycloak-js', 'quickjs-emscripten']],
]

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
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
        /*
         * FUNZIONE, NON PIU' OGGETTO (21 set 2026, Vite 8).
         *
         * Vite 8 ha cambiato bundler: sotto non c'e' piu' rollup ma rolldown,
         * che accetta `manualChunks` solo come FUNZIONE — la forma a oggetto
         * fallisce con «Invalid type: Expected Function but received Object».
         *
         * I gruppi sono gli stessi di prima, dichiarati una volta sola qui
         * sotto: si cerca il primo pacchetto che compare nel percorso del
         * modulo, così aggiungerne uno resta una riga e non una condizione.
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
