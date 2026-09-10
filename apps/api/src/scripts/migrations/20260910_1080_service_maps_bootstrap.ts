/**
 * Servizi monitorati (ondata 1) — bootstrap delle ServiceMap.
 *
 * Vincoli e indici vivono in packages/neo4j/src/init.ts (`migrate
 * --init-schema`); qui i DATI: ogni `ServiceMap` già presente (creata da una
 * build precedente, da un import o a mano) riceve i campi che il motore e i
 * resolver esigono senza inventare valori a runtime:
 *  - `rules`: completata con le chiavi mancanti (DEFAULT_SERVICE_IMPACT_RULES,
 *    stesso `completeServiceImpactRules` che userà la prossima versione delle
 *    regole), creata intera dove manca; JSON corrotto → la migrazione si FERMA
 *    con la mappa nel messaggio (non è un caso da aggiustare in silenzio);
 *  - `node_ids` (id dei CI inclusi alla costruzione, per rilevare i nodi
 *    spariti) ricostruito dalle INCLUDES attuali dove manca;
 *  - `stale = false`, `version = 1`, `built_from = 'auto'`, `status = 'active'`,
 *    `health = 'unknown'`, `impact_score = 0`, `explanation = '[]'`,
 *    `relationship_types` = tutte, `max_depth` = default, dove mancano.
 * Su un database senza ServiceMap non fa nulla. Idempotente: SET solo dove
 * manca qualcosa; una seconda esecuzione non tocca nulla.
 */
import type { Migration } from '@opengraphity/neo4j'
import {
  DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_MAP_DEFAULT_DEPTH, SERVICE_RELATIONSHIP_TYPES, completeServiceImpactRules,
} from '../../lib/serviceVocabularies.js'

export const serviceMapsBootstrap: Migration = {
  id: '20260910_1080_service_maps_bootstrap',
  description: 'Servizi monitorati: complete ServiceMap.rules with missing keys (create where absent), rebuild node_ids from INCLUDES and set the wave-1 fields (stale, version, built_from, status, health, impact_score, explanation, relationship_types, max_depth) where missing',
  async up(session) {
    const now = new Date().toISOString()

    // (a) Campi obbligatori dell'ondata 1 e node_ids dalle INCLUDES, solo dove mancano.
    const fields = await session.run(`
      MATCH (m:ServiceMap)
      WHERE m.stale IS NULL OR m.version IS NULL OR m.built_from IS NULL OR m.status IS NULL OR m.health IS NULL
         OR m.impact_score IS NULL OR m.explanation IS NULL OR m.relationship_types IS NULL OR m.max_depth IS NULL OR m.node_ids IS NULL
      SET m.stale              = coalesce(m.stale, false),
          m.version            = coalesce(m.version, 1),
          m.built_from         = coalesce(m.built_from, 'auto'),
          m.status             = coalesce(m.status, 'active'),
          m.health             = coalesce(m.health, 'unknown'),
          m.impact_score       = coalesce(m.impact_score, 0),
          m.explanation        = coalesce(m.explanation, '[]'),
          m.relationship_types = coalesce(m.relationship_types, $relationshipTypes),
          m.max_depth          = coalesce(m.max_depth, toInteger($maxDepth)),
          m.node_ids           = coalesce(m.node_ids, [(m)-[:INCLUDES]->(ci) | ci.id]),
          m.updated_at         = $now
      RETURN count(m) AS n
    `, { relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], maxDepth: SERVICE_MAP_DEFAULT_DEPTH, now })
    const completedFields = Number(fields.records[0]?.get('n') ?? 0)

    // (b) Regole: completa (chiavi mancanti) o crea; JSON corrotto ferma la migrazione.
    const maps = await session.run(`
      MATCH (m:ServiceMap)
      RETURN m.id AS id, m.rules AS rules
      ORDER BY m.id
    `)
    let completed = 0
    let created = 0
    let unchanged = 0
    for (const record of maps.records) {
      const mapId = String(record.get('id'))
      const raw = record.get('rules') as unknown
      let next: string | null
      if (raw == null || raw === '') {
        next = DEFAULT_SERVICE_IMPACT_RULES_JSON
        created++
      } else {
        if (typeof raw !== 'string') throw new Error(`ServiceMap ${mapId} rules is not a JSON string (got ${typeof raw}); fix it before migrating`)
        let parsed: unknown
        try { parsed = JSON.parse(raw) }
        catch (e) { throw new Error(`ServiceMap ${mapId} rules is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`ServiceMap ${mapId} rules is not a JSON object; fix it before migrating`)
        const full = completeServiceImpactRules(parsed as Record<string, unknown>)
        if (full) { next = JSON.stringify(full); completed++ } else { next = null; unchanged++ }
      }
      if (next) {
        await session.run(`
          MATCH (m:ServiceMap {id: $mapId})
          SET m.rules = $rules, m.updated_at = $now
        `, { mapId, rules: next, now })
      }
    }

    console.log(`[${serviceMapsBootstrap.id}] ${maps.records.length} ServiceMap: wave-1 fields/node_ids completed on ${completedFields}; rules completed ${completed}, created ${created}, already complete ${unchanged}`)
  },
}
