/**
 * Event Management (ondata 1) — correzione della migrazione
 * 20260909_1000_event_management_bootstrap, che sul grafo reale ha prodotto
 * due difetti (quella migrazione è già applicata e non va modificata):
 *
 *  (a) Aveva marcato `status_source = 'manual'` su OGNI CI con uno `status`.
 *      Ma `ci.status` è il ciclo di vita (active/inactive/maintenance/
 *      decommissioned, enum `ci_status`), non la salute: nessun utente aveva
 *      "impostato a mano" una salute, e il flag avrebbe impedito al
 *      monitoraggio di agire su tutti i CI. La salute ora vive in `ci.health`
 *      / `ci.health_source` / `ci.last_event_at` (eventService.recomputeCIHealth):
 *      qui si rimuove `status_source` ovunque.
 *  (b) Aveva scritto `event_policy` su ogni :Tenant — ma i tenant creati prima
 *      dello script di onboarding non hanno un nodo :Tenant (solo `tenant_id`
 *      sugli altri nodi), quindi la policy è finita su 0 tenant e
 *      getEventPolicy fallirebbe. Qui si crea il nodo :Tenant per ogni
 *      `tenant_id` distinto presente sugli :User, con gli stessi campi che
 *      scrive onboard-tenant.ts (lib/tenantPlans.ts): id = slug = tenant_id,
 *      name = tenant_id (l'onboarding usa lo slug quando `--name` manca),
 *      plan/timezone/settings ai valori predefiniti dello script (starter,
 *      Europe/Rome, sla_enabled, scripting_enabled, max_users, max_ci) perché
 *      non sono deducibili dal grafo — un amministratore può correggerli dopo.
 *      Poi ogni :Tenant senza `event_policy` riceve DEFAULT_EVENT_POLICY_JSON.
 *
 * Idempotente: REMOVE su una proprietà assente non fa nulla, MERGE + ON CREATE
 * non ritocca i tenant esistenti, il filtro IS NULL salta le policy presenti.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON } from '../../lib/eventPolicy.js'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE, PLAN_SETTINGS } from '../../lib/tenantPlans.js'

export const eventManagementFixup: Migration = {
  id: '20260909_1010_event_management_fixup',
  description: 'Event Management fixup: drop status_source from CIs, create missing :Tenant nodes from User.tenant_id, default event_policy on tenants without one',
  async up(session) {
    const now = new Date().toISOString()
    const settings = PLAN_SETTINGS[DEFAULT_TENANT_PLAN]

    const cis = await session.run(`
      MATCH (ci:ConfigurationItem)
      WHERE ci.status_source IS NOT NULL
      REMOVE ci.status_source
      RETURN count(ci) AS n
    `)

    const tenants = await session.run(`
      MATCH (u:User)
      WHERE u.tenant_id IS NOT NULL AND u.tenant_id <> ''
      WITH DISTINCT u.tenant_id AS tid
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

    const policies = await session.run(`
      MATCH (t:Tenant)
      WHERE t.event_policy IS NULL
      SET t.event_policy = $policy
      RETURN count(t) AS n
    `, { policy: DEFAULT_EVENT_POLICY_JSON })

    const r = tenants.records[0]
    console.log(
      `[${eventManagementFixup.id}] status_source removed from ${String(cis.records[0]?.get('n') ?? 0)} CIs, ` +
      `:Tenant created ${String(r?.get('created') ?? 0)} of ${String(r?.get('total') ?? 0)} tenant_id found on :User, ` +
      `event_policy set on ${String(policies.records[0]?.get('n') ?? 0)} tenants`,
    )
  },
}
