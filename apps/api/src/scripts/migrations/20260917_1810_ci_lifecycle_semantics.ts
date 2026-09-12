/**
 * Ondata 7 · C-4 / A-14 — la **semantica** del ciclo di vita del CI diventa
 * dato del cliente: `Tenant.event_policy.retired_statuses` e
 * `.maintenance_statuses` (lib/eventPolicy.ts, motivazione della forma in
 * lib/ciLifecycle.ts).
 *
 * Prima quali stati contassero come «ritirato» e quale come «in manutenzione»
 * era scritto nel codice (`CI_LIFECYCLE_RETIRED`, `CI_LIFECYCLE_MAINTENANCE`,
 * e `'maintenance'` come letterale dentro il Cypher di ciHealth.ts): un
 * cliente che rinominava un valore nel Dizionario si ritrovava i CI dismessi
 * di nuovo dentro il calcolo della salute dei servizi e i CI in manutenzione
 * di nuovo governati dagli allarmi, **in silenzio**.
 *
 * Questa migrazione scrive su ogni tenant i valori che il codice usava finora
 * — `retired_statuses = ['inactive','decommissioned']`, `maintenance_statuses
 * = ['maintenance']`, da `DEFAULT_EVENT_POLICY` — così **il primo giorno non
 * cambia niente**. Solo dove mancano: una policy che le ha già (perché
 * l'amministratore le ha modificate) non viene toccata, e con lo stesso
 * `completeEventPolicy` della 1040 e della 1130 si completa anche ogni altra
 * chiave assente. Un tenant senza policy la riceve intera; un JSON corrotto
 * FERMA la migrazione con il tenant nel messaggio.
 *
 * Idempotente: alla seconda esecuzione non manca più nulla e non si scrive.
 * Senza questa migrazione la lettura della policy fallisce con «missing
 * retired_statuses, maintenance_statuses: run the
 * 20260917_1810_ci_lifecycle_semantics migration»: nessun default silenzioso a
 * runtime.
 *
 * Nota: la migrazione **non** verifica che quei valori stiano nel vocabolario
 * `ci_status` del tenant, ed è voluto. Sono i valori con cui il prodotto si
 * comportava ieri, e vanno scritti anche su un tenant che avesse un
 * vocabolario incompleto: sarebbe il caso peggiore in cui perdere la semantica.
 * L'appartenenza si impone in scrittura (`updateEventPolicy`), dove c'è un
 * amministratore a cui dirlo.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON, EVENT_POLICY_V6_KEYS, completeEventPolicy } from '../../lib/eventPolicy.js'

function parseObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}); fix it before migrating`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON (${e instanceof Error ? e.message : String(e)}); fix it before migrating`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} is not a JSON object; fix it before migrating`)
  return parsed as Record<string, unknown>
}

export const ciLifecycleSemantics: Migration = {
  id: '20260917_1810_ci_lifecycle_semantics',
  description: `Ondata 7 (C-4/A-14): add ${EVENT_POLICY_V6_KEYS.join(', ')} to every Tenant.event_policy (the values the code used so far, only where missing)`,
  async up(session) {
    const now = new Date().toISOString()
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)
    let completed = 0
    let created = 0
    let unchanged = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const raw = record.get('policy') as unknown
      let next: string | null
      if (raw == null || raw === '') {
        next = DEFAULT_EVENT_POLICY_JSON
        created++
      } else {
        const full = completeEventPolicy(parseObject(raw, `Tenant ${tenantId} event_policy`))
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
      `[${ciLifecycleSemantics.id}] ${tenants.records.length} tenants: event_policy completed ${completed}, created ${created}, already complete ${unchanged}`,
    )
  },
}
