/**
 * Valori iniziali di un :Tenant — unica sorgente per lo script di onboarding
 * (scripts/onboard-tenant.ts) e per la migrazione che crea i nodi :Tenant
 * mancanti (scripts/migrations/20260909_1010_event_management_fixup.ts).
 *
 * `TenantSettings` (packages/types) è salvato appiattito sul nodo (Neo4j non
 * ha mappe annidate): sla_enabled, scripting_enabled, max_users, max_ci,
 * max_service_maps.
 *
 * I tenant creati prima di un limite nuovo non lo hanno sul nodo: lo scrive una
 * migrazione dedicata (`max_service_maps`: 20260910_1100_service_map_plan_limit).
 * Chi legge un limite NON deve rimediare da solo con un default — un tenant
 * senza limite è un errore che deve farsi vedere.
 */
import type { Tenant } from '@opengraphity/types'

export const DEFAULT_TENANT_PLAN: Tenant['plan'] = 'starter'
export const DEFAULT_TENANT_TIMEZONE = 'Europe/Rome'

export const PLAN_SETTINGS: Record<Tenant['plan'], Tenant['settings']> = {
  starter:    { sla_enabled: true, scripting_enabled: false, max_users: 25,   max_ci: 500,     max_service_maps: 5 },
  pro:        { sla_enabled: true, scripting_enabled: true,  max_users: 250,  max_ci: 10_000,  max_service_maps: 50 },
  enterprise: { sla_enabled: true, scripting_enabled: true,  max_users: 5000, max_ci: 200_000, max_service_maps: 200 },
}
