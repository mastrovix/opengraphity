/**
 * G-MON-7: la soglia «un guasto qui si propaga» diventa dato del cliente.
 *
 * La console della salute dei CI scuriva il chip «Impatto» da 5 dipendenti in
 * su, con il 5 scritto nel sorgente del web: la stessa soglia per una CMDB da
 * 50 CI e per una da 50.000. Ora sta nella Policy eventi, e questa migrazione
 * la aggiunge alle policy che non ce l'hanno con il valore che il prodotto
 * usava finora — il primo giorno non cambia niente.
 *
 * Come la 1810: i valori di riempimento sono CONGELATI qui, non letti da
 * `DEFAULT_EVENT_POLICY`, che evolve.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY, EVENT_POLICY_V7_KEYS, completeEventPolicy, type EventPolicy } from '../../lib/eventPolicy.js'

/** La soglia che il web aveva cablato (CIHealthPage `HIGH_IMPACT`). */
const HIGH_IMPACT_2_OTT = 5

const POLICY_2_OTT: EventPolicy = { ...DEFAULT_EVENT_POLICY, high_impact_dependents: HIGH_IMPACT_2_OTT }

function parseObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}); fix it before migrating`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} is not a JSON object; fix it before migrating`)
  return parsed as Record<string, unknown>
}

export const eventPolicyHighImpact: Migration = {
  id: '20261002_1050_event_policy_high_impact',
  description: `Revisione totale (G-MON-7): add ${EVENT_POLICY_V7_KEYS.join(', ')} = ${HIGH_IMPACT_2_OTT} to every Tenant.event_policy that lacks it`,
  async up(session) {
    const now = new Date().toISOString()
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.event_policy IS NOT NULL AND t.event_policy <> ''
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)
    let completed = 0
    let unchanged = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const full = completeEventPolicy(parseObject(record.get('policy'), `Tenant ${tenantId} event_policy`), POLICY_2_OTT)
      if (!full) { unchanged++; continue }
      await session.run(
        'MATCH (t:Tenant {id: $tenantId}) SET t.event_policy = $policy, t.updated_at = $now',
        { tenantId, policy: JSON.stringify(full), now },
      )
      completed++
    }
    console.log(`[${eventPolicyHighImpact.id}] event_policy: ${completed} completate, ${unchanged} avevano gia ${EVENT_POLICY_V7_KEYS.join(', ')}`)
  },
}
