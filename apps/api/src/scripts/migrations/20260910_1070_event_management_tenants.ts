/**
 * Event Management (revisione, A-M8 e A-2) — tenant senza nodo :Tenant e
 * chiave `match_short_hostname` della policy.
 *
 *  (a) La 1010 creava i nodi :Tenant mancanti derivandoli SOLO dai
 *      `tenant_id` degli :User. Un tenant "solo integrazione" (webhook, chiave
 *      API o CI senza nessun utente: onboarding interrotto, import) restava
 *      senza nodo e senza policy: il webhook rispondeva 202 e ogni job di
 *      ingest falliva tre volte su `Tenant … not found`. Qui i `tenant_id`
 *      vengono uniti (UNION) da :User, :InboundWebhook, :ApiKey e
 *      :ConfigurationItem prima del MERGE, con gli stessi campi predefiniti
 *      della 1010 (lib/tenantPlans.ts) — un amministratore può correggerli dopo.
 *  (b) Ogni `Tenant.event_policy` riceve `match_short_hostname` (false: il
 *      riconoscimento del CI per nome corto/FQDN è una scelta esplicita) — e
 *      qualunque altra chiave mancante — con i valori di DEFAULT_EVENT_POLICY,
 *      tramite lo stesso `completeEventPolicy` della 1040/1060. Un tenant senza
 *      policy (anche quelli appena creati al punto (a)) la riceve intera,
 *      versionata (version 1, updated_at null); una policy già completa non
 *      viene riscritta; una policy con JSON corrotto FERMA la migrazione con
 *      il tenant nel messaggio: non è un caso da aggiustare in silenzio.
 *
 * Idempotente: MERGE + ON CREATE non ritocca i tenant esistenti; SET solo
 * dove manca qualcosa.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON, completeEventPolicy } from '../../lib/eventPolicy.js'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE, PLAN_SETTINGS } from '../../lib/tenantPlans.js'

/** Etichette da cui si derivano i `tenant_id` dei tenant senza nodo :Tenant. */
export const TENANT_ID_SOURCE_LABELS = ['User', 'InboundWebhook', 'ApiKey', 'ConfigurationItem'] as const

export const eventManagementTenants: Migration = {
  id: '20260910_1070_event_management_tenants',
  description: 'Event Management: create missing :Tenant nodes from tenant_id on User/InboundWebhook/ApiKey/ConfigurationItem, add match_short_hostname (and any missing key) to every Tenant.event_policy',
  async up(session) {
    const now = new Date().toISOString()
    const settings = PLAN_SETTINGS[DEFAULT_TENANT_PLAN]

    // (a) UNION dei tenant_id di tutte le etichette sorgente, poi MERGE.
    const union = TENANT_ID_SOURCE_LABELS
      .map((label) => `MATCH (n:${label}) WHERE n.tenant_id IS NOT NULL AND n.tenant_id <> '' RETURN DISTINCT n.tenant_id AS tid`)
      .join('\n        UNION\n        ')
    const tenants = await session.run(`
      CALL {
        ${union}
      }
      WITH DISTINCT tid
      MERGE (t:Tenant {id: tid})
      ON CREATE SET
        t.slug              = tid,
        t.name              = tid,
        t.plan              = $plan,
        t.timezone          = $timezone,
        t.sla_enabled       = $slaEnabled,
        t.scripting_enabled = $scriptingEnabled,
        t.max_users         = $maxUsers,
        t.max_ci            = $maxCi,
        t.created_at        = $now
      RETURN sum(CASE WHEN t.created_at = $now THEN 1 ELSE 0 END) AS created, count(t) AS total
    `, {
      plan: DEFAULT_TENANT_PLAN, timezone: DEFAULT_TENANT_TIMEZONE, now,
      slaEnabled: settings.sla_enabled, scriptingEnabled: settings.scripting_enabled,
      maxUsers: settings.max_users, maxCi: settings.max_ci,
    })

    // (b) Policy: completa (match_short_hostname e ogni altra chiave assente) o crea.
    const policies = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.event_policy AS policy
      ORDER BY t.id
    `)

    let completed = 0
    let unchanged = 0
    let created = 0
    for (const record of policies.records) {
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

    const r = tenants.records[0]
    console.log(
      `[${eventManagementTenants.id}] :Tenant created ${String(r?.get('created') ?? 0)} of ${String(r?.get('total') ?? 0)} tenant_id found on ${TENANT_ID_SOURCE_LABELS.join('/')}; ` +
      `${policies.records.length} tenants: event_policy completed ${completed}, created ${created}, already complete ${unchanged}`,
    )
  },
}
