/**
 * Servizi monitorati (ondata 4) — limite di piano `max_service_maps` sui
 * :Tenant esistenti.
 *
 * `TenantSettings` (packages/types) ha una chiave nuova: `max_service_maps`
 * (starter 5, pro 50, enterprise 200 — lib/tenantPlans.ts). I tenant creati
 * prima non ce l'hanno sul nodo, e `createServiceMap` NON inventa un default
 * quando manca (sarebbe un limite finto): senza questa migrazione la creazione
 * di una mappa fallirebbe con «run the 20260910_1100_service_map_plan_limit
 * migration». Qui il valore viene scritto SOLO dove manca (`IS NULL`), dal
 * piano del tenant: un limite alzato o abbassato a mano dall'amministratore
 * non viene toccato. Un `plan` fuori vocabolario (dato sporco) FERMA la
 * migrazione con il tenant nel messaggio, non riceve il piano starter di
 * comodo.
 *
 * Idempotente: alla seconda esecuzione non c'è più nessun tenant senza limite.
 * Stile 1020/1070: una lettura, una scrittura per tenant, un riepilogo.
 */
import type { Migration } from '@opengraphity/neo4j'
import { PLAN_SETTINGS } from '../../lib/tenantPlans.js'
import type { Tenant } from '@opengraphity/types'

const PLANS = Object.keys(PLAN_SETTINGS) as Tenant['plan'][]

export const serviceMapPlanLimit: Migration = {
  id: '20260910_1100_service_map_plan_limit',
  description: 'Servizi monitorati: write Tenant.max_service_maps (starter 5, pro 50, enterprise 200) where missing, from the tenant plan',
  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.plan AS plan, t.max_service_maps AS limit
      ORDER BY t.id
    `)

    let written = 0
    let unchanged = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      if (record.get('limit') != null) { unchanged++; continue }
      const plan = record.get('plan') as unknown
      if (typeof plan !== 'string' || !(PLANS as readonly string[]).includes(plan)) {
        throw new Error(`Tenant ${tenantId} plan is ${JSON.stringify(plan)}: expected one of ${PLANS.join(', ')}; fix it before migrating`)
      }
      await session.run(`
        MATCH (t:Tenant {id: $tenantId})
        WHERE t.max_service_maps IS NULL
        SET t.max_service_maps = toInteger($maxServiceMaps)
      `, { tenantId, maxServiceMaps: PLAN_SETTINGS[plan as Tenant['plan']].max_service_maps })
      written++
    }

    console.log(`[${serviceMapPlanLimit.id}] ${tenants.records.length} tenants: max_service_maps written ${written}, already set ${unchanged}`)
  },
}
