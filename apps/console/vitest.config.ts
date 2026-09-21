/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import path from 'path'

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
 * meno. `node` e non `jsdom`: quello che si prova qui è logica, non pagine.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
