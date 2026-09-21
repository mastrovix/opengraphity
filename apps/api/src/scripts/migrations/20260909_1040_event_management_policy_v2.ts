/**
 * Event Management (ondata 4) — sfarfallio stabile, tempeste, conservazione.
 *
 *  (a) La policy di ogni :Tenant riceve le chiavi introdotte dall'ondata 4
 *      (`flap_stable_minutes`, `storm_threshold_per_minute`,
 *      `storm_cooldown_minutes`) — e qualunque altra chiave mancante — con i
 *      valori di DEFAULT_EVENT_POLICY (lib/eventPolicy.ts). Una policy già
 *      completa non viene riscritta; un tenant senza policy la riceve intera
 *      (come la 1010); una policy con JSON corrotto FERMA la migrazione con il
 *      tenant nel messaggio: non è un caso da aggiustare in silenzio.
 *  (b) `Event.transitions = []` dove assente (la lista dei passaggi
 *      firing↔resolved che alimenta lo sfarfallio).
 *  (c) Regole di notifica per `event.flapping`, `event.stable`,
 *      `event.storm_started`, `event.storm_ended` (seedNotificationRules,
 *      MERGE idempotente come nelle 1020/1030).
 *
 * Idempotente: SET solo dove manca qualcosa, MERGE + ON CREATE per le regole.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON, completeEventPolicy } from '../../lib/eventPolicy.js'
import { seedNotificationRules } from '../../lib/seedNotificationRules.js'

export const eventManagementPolicyV2: Migration = {
  id: '20260909_1040_event_management_policy_v2',
  description: 'Event Management: add flap_stable_minutes / storm_threshold_per_minute / storm_cooldown_minutes (and any missing key) to every Tenant.event_policy, Event.transitions = [] where missing, seed NotificationRules for flapping/stable/storm events',
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
    let rulesCreated = 0
    let rulesSkipped = 0
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
      const r = await seedNotificationRules(tenantId, session)
      rulesCreated += r.created
      rulesSkipped += r.skipped
    }

    const events = await session.run(`
      MATCH (e:Event)
      WHERE e.transitions IS NULL
      SET e.transitions = []
      RETURN count(e) AS n
    `)

    console.log(
      `[${eventManagementPolicyV2.id}] ${tenants.records.length} tenants: event_policy completed ${completed}, created ${created}, already complete ${unchanged}; ` +
      `NotificationRule created ${rulesCreated}, already present ${rulesSkipped}; ` +
      `Event.transitions = [] set on ${String(events.records[0]?.get('n') ?? 0)} events`,
    )
  },
}
