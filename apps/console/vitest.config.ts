/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { copertura } from '../../copertura.mjs'
import path from 'node:path'

/**
 * La console non aveva test (21 set 2026).
 *
 * Il difetto si è visto guardando la CI della PR #26: il passo «Test
 * packages, web, portal» era rosso su `apps/console test: No test files
 * found, exiting with code 1` — `vitest run` senza test esce con errore.
 * Era così dal 17 settembre (`23383ba4`, la nascita della console), e stava
 * nascosto dietro un altro rosso che arrivava prima nella catena.
 *
 * La pezza facile sarebbe stata `--passWithNoTests`, cioè dichiarare per
 * sempre che qui non si prova niente. Invece si comincia a provare: questa
 * configurazione esiste perché ci siano i test, non perché si possa farne a
 * meno.
 *
 * `jsdom` dal 22 set 2026: all'inizio qui si provava solo logica, ma la
 * pagina dei tenant è il posto dove si CANCELLA un cliente — e le difese di
 * quel gesto (lo slug da ridigitare, il conteggio che dice «unknown» e non
 * «0», la sospensione che precede la cancellazione) sono interfaccia, non
 * logica: si provano solo rendendola.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    coverage: copertura('apps/console'),
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
