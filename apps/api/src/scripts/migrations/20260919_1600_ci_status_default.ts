/**
 * Rimedio 3 — lo stato iniziale del CI diventa un **default dichiarato**
 * invece di una posizione (revisione delle otto ondate · C·N-2).
 *
 * `initialCIStatus` prendeva il **primo** valore del vocabolario `ci_status`. Il
 * Dizionario sapeva solo aggiungere in coda, quindi rinominare un valore lo
 * spostava in fondo: dopo `active` → `attivo` il primo valore rimasto era
 * `inactive`, e un CI nuovo nasceva così — in `retired_statuses`, subito fuori
 * dal calcolo della salute dei servizi, e i suoi allarmi non aprivano più
 * incident. Silenzioso, e su strada dritta.
 *
 * Questa migrazione scrive `default_value` = **il primo valore attuale** su
 * ogni vocabolario `ci_status` (quello spedito e le copie dei clienti): il
 * comportamento del primo giorno è identico a quello di ieri, e da qui in poi è
 * una configurazione che si vede, si modifica, e che la rinomina porta dietro.
 *
 * Idempotente: non tocca un vocabolario che ha già un default. Non ne inventa
 * uno per un vocabolario vuoto (sarebbe un default che punta al nulla) e lo
 * dice.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CI_STATUS_VOCABULARY } from '../../lib/eventVocabularies.js'

export const ciStatusDefaultSeed: Migration = {
  id: '20260919_1600_ci_status_default',
  description: 'EnumTypeDefinition(ci_status).default_value = primo valore attuale: lo stato iniziale del CI diventa un default dichiarato invece della posizione nella lista',
  async up(session) {
    const res = await session.run(
      `MATCH (e:EnumTypeDefinition {name: $name})
       WHERE e.default_value IS NULL AND size(e.values) > 0
       SET e.default_value = e.values[0], e.updated_at = $now
       RETURN e.tenant_id AS tenantId, e.default_value AS value ORDER BY tenantId`,
      { name: CI_STATUS_VOCABULARY, now: new Date().toISOString() },
    )
    for (const r of res.records) {
      console.log(`[${ciStatusDefaultSeed.id}] ${String(r.get('tenantId'))}: default_value = ${String(r.get('value'))}`)
    }

    const vuoti = await session.run(
      `MATCH (e:EnumTypeDefinition {name: $name})
       WHERE e.default_value IS NULL
       RETURN e.tenant_id AS tenantId, size(coalesce(e.values, [])) AS n`,
      { name: CI_STATUS_VOCABULARY },
    )
    for (const r of vuoti.records) {
      console.log(
        `[${ciStatusDefaultSeed.id}] ATTENZIONE ${String(r.get('tenantId'))}: vocabolario ${CI_STATUS_VOCABULARY} con ` +
        `${String(r.get('n'))} valori e nessun default — non ne invento uno. ` +
        `Finché resta così, la creazione di un CI usa il primo valore e lo dice nei log.`,
      )
    }
    console.log(`[${ciStatusDefaultSeed.id}] ${String(res.records.length)} vocabolari seminati.`)
  },
}
