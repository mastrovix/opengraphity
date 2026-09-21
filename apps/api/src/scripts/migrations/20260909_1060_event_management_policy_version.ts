/**
 * Event Management (revisione, C-4) — versione esplicita della policy.
 *
 * `Tenant.event_policy` riceve `version` (contatore di modifica, parte da 1) e
 * `updated_at` (null = mai modificata dopo il bootstrap) — e qualunque altra
 * chiave mancante — con i valori di DEFAULT_EVENT_POLICY (lib/eventPolicy.ts),
 * tramite lo stesso `completeEventPolicy` della 1040. Prima la versione era
 * dedotta dall'assenza delle chiavi v2 e due amministratori potevano
 * sovrascriversi la policy a vicenda: ora `updateEventPolicy` la incrementa e
 * `EventPolicyInput.expectedVersion` rifiuta il salvataggio sopra una
 * modifica concorrente.
 *
 * Una policy già completa non viene riscritta; un tenant senza policy la
 * riceve intera (come la 1010/1040); una policy con JSON corrotto FERMA la
 * migrazione con il tenant nel messaggio: non è un caso da aggiustare in
 * silenzio. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON, completeEventPolicy } from '../../lib/eventPolicy.js'

export const eventManagementPolicyVersion: Migration = {
  id: '20260909_1060_event_management_policy_version',
  description: 'Event Management: add version / updated_at (and any missing key) to every Tenant.event_policy',
  async up(session) {
    const now = new Date().toISOString()
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)

    let completed = 0
    let unchanged = 0
    let created = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const raw = record.get('policy') as unknown
      let next: string | null
      if (raw == null || raw === '') {
        next = DEFAULT_EVENT_POLICY_JSON
        created++
      } else {
        if (typeof raw !== 'string') throw new Error(`Tenant ${tenantId} event_policy is not a JSON string (got ${typeof raw}); fix it before migrating`)
        let parsed: unknown
        try { parsed = JSON.parse(raw) }
        catch (e) { throw new Error(`Tenant ${tenantId} event_policy is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Tenant ${tenantId} event_policy is not a JSON object; fix it before migrating`)
        const full = completeEventPolicy(parsed as Record<string, unknown>)
        if (full) { next = JSON.stringify(full); completed++ } else { next = null; unchanged++ }
      }
      if (next) {
        await session.run(`
          MATCH (t:Tenant {id: $tenantId})
          SET t.event_policy = $policy, t.updated_at = $now
        `, { tenantId, policy: next, now })
      }
    }

    console.log(
      `[${eventManagementPolicyVersion.id}] ${tenants.records.length} tenants: event_policy versioned ${completed}, created ${created}, already versioned ${unchanged}`,
    )
  },
}
