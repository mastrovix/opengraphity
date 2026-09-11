/**
 * Revisione 2, ondata 3 — «regole di dominio condivise»: le due chiavi nuove
 * che allarmi e servizi leggono e che non si possono inventare a runtime.
 *
 *  (a) `Tenant.event_policy.ignore_lifecycle_statuses` (D6.3): i cicli di vita
 *      del CI per cui un allarme non apre incident e non cambia la salute.
 *      Scritta con il default (`['decommissioned']`, DEFAULT_EVENT_POLICY) —
 *      e con essa ogni altra chiave mancante, come la 1040 — solo sulle policy
 *      che non ce l'hanno; una policy completa non viene riscritta, un tenant
 *      senza policy la riceve intera, un JSON corrotto FERMA la migrazione con
 *      il tenant nel messaggio.
 *  (b) `ServiceMap.rules.during_storm` (D6.4): cosa fa la mappa mentre una
 *      sorgente dei suoi allarmi è in tempesta. Default `hold` (valutazione
 *      sospesa: una tempesta è quasi sempre un guasto della raccolta, non
 *      sessanta guasti veri) scritto solo dove manca, con lo stesso
 *      `completeServiceImpactRules` della 1080. Non tocca `version` della
 *      mappa: non è una modifica di configurazione fatta da qualcuno.
 *
 * Idempotente: alla seconda esecuzione non manca più nulla e non si scrive.
 * Senza questa migrazione la lettura della policy fallisce con «missing
 * ignore_lifecycle_statuses: run the 20260911_1130_shared_domain_rules
 * migration» e quella delle regole con «rules.during_storm must be one of…»:
 * nessun default silenzioso a runtime.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON, completeEventPolicy } from '../../lib/eventPolicy.js'
import { completeServiceImpactRules, DEFAULT_SERVICE_IMPACT_RULES_JSON } from '../../lib/serviceVocabularies.js'

function parseObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}); fix it before migrating`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} is not a JSON object; fix it before migrating`)
  return parsed as Record<string, unknown>
}

export const sharedDomainRules: Migration = {
  id: '20260911_1130_shared_domain_rules',
  description: 'Revisione 2 (ondata 3): add ignore_lifecycle_statuses to every Tenant.event_policy and during_storm to every ServiceMap.rules (defaults, only where missing)',
  async up(session) {
    const now = new Date().toISOString()

    // (a) Policy degli allarmi: ciclo di vita ignorato.
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)
    let policiesCompleted = 0
    let policiesCreated = 0
    let policiesUnchanged = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const raw = record.get('policy') as unknown
      let next: string | null
      if (raw == null || raw === '') {
        next = DEFAULT_EVENT_POLICY_JSON
        policiesCreated++
      } else {
        const full = completeEventPolicy(parseObject(raw, `Tenant ${tenantId} event_policy`))
        if (full) { next = JSON.stringify(full); policiesCompleted++ } else { next = null; policiesUnchanged++ }
      }
      if (next) {
        await session.run(`
          MATCH (t:Tenant {id: $tenantId})
          SET t.event_policy = $policy, t.updated_at = $now
        `, { tenantId, policy: next, now })
      }
    }

    // (b) Regole delle mappe: comportamento durante una tempesta.
    const maps = await session.run(`
      MATCH (m:ServiceMap)
      RETURN m.id AS id, m.rules AS rules
      ORDER BY m.id
    `)
    let rulesCompleted = 0
    let rulesCreated = 0
    let rulesUnchanged = 0
    for (const record of maps.records) {
      const mapId = String(record.get('id'))
      const raw = record.get('rules') as unknown
      let next: string | null
      if (raw == null || raw === '') {
        next = DEFAULT_SERVICE_IMPACT_RULES_JSON
        rulesCreated++
      } else {
        const full = completeServiceImpactRules(parseObject(raw, `ServiceMap ${mapId} rules`))
        if (full) { next = JSON.stringify(full); rulesCompleted++ } else { next = null; rulesUnchanged++ }
      }
      if (next) {
        await session.run(`
          MATCH (m:ServiceMap {id: $mapId})
          SET m.rules = $rules, m.updated_at = $now
        `, { mapId, rules: next, now })
      }
    }

    console.log(
      `[${sharedDomainRules.id}] ${tenants.records.length} tenants: event_policy completed ${policiesCompleted}, created ${policiesCreated}, already complete ${policiesUnchanged}; ` +
      `${maps.records.length} ServiceMap: rules completed ${rulesCompleted}, created ${rulesCreated}, already complete ${rulesUnchanged}`,
    )
  },
}
