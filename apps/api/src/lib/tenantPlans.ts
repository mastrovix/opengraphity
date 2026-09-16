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
/**
 * UTC, non Europe/Rome (revisione totale · C-27).
 *
 * Il prodotto è «inglese per default» e il fuso decide le scadenze SLA, l'ora
 * del digest e le passate OLA: un cliente irlandese onboardato senza
 * `--timezone` si ritrovava le scadenze calcolate sull'ora di Roma. UTC non è
 * la scelta di nessuno in particolare, quindi non finge di essere giusta: lo
 * script di onboarding lo scrive a schermo quando usa il default.
 */
export const DEFAULT_TENANT_TIMEZONE = 'UTC'

export const PLAN_SETTINGS: Record<Tenant['plan'], Tenant['settings']> = {
  starter:    { sla_enabled: true, scripting_enabled: false, max_users: 25,   max_ci: 500,     max_service_maps: 5 },
  pro:        { sla_enabled: true, scripting_enabled: true,  max_users: 250,  max_ci: 10_000,  max_service_maps: 50 },
  enterprise: { sla_enabled: true, scripting_enabled: true,  max_users: 5000, max_ci: 200_000, max_service_maps: 200 },
}
