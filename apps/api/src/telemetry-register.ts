/**
 * Avvia OpenTelemetry PRIMA dell'applicazione.
 *
 * Revisione totale · A-23: `initTelemetry()` veniva chiamata dalla prima riga
 * di `index.ts`, ma in ESM tutti gli import statici di quel file (express,
 * http, neo4j-driver, ioredis) sono già valutati quando quella riga gira.
 * L'auto-strumentazione patcha i moduli caricati DOPO l'avvio dell'SDK: con
 * `OTEL_ENABLED=true` in Jaeger comparivano solo gli span creati a mano dal
 * plugin Apollo, senza i figli di HTTP e del driver — e sembrava un problema
 * di Jaeger.
 *
 * Si usa come preload, così l'SDK parte davvero per primo:
 *   node --import ./dist/telemetry-register.js --no-node-snapshot dist/index.js
 * oppure NODE_OPTIONS="--import ./dist/telemetry-register.js".
 *
 * `initTelemetry()` resta idempotente: se il preload c'è, la chiamata di
 * `index.ts` non fa nulla; se non c'è, la telemetria funziona come prima (span
 * dell'operazione GraphQL) e l'avvio lo dice.
 */
import { initTelemetry } from './telemetry.js'

// Il marcatore dice a `initTelemetry` che sta partendo per prima: senza,
// avverte che gli span di HTTP e del driver mancheranno (A-23).
;(globalThis as { __OG_TELEMETRY_PRELOADED__?: boolean }).__OG_TELEMETRY_PRELOADED__ = true

initTelemetry()
