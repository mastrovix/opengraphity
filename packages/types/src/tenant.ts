export interface Tenant {
  id: string
  name: string
  plan: 'starter' | 'pro' | 'enterprise'
  timezone: string
  settings: TenantSettings
  created_at: string
}

export interface TenantSettings {
  sla_enabled: boolean
  scripting_enabled: boolean
  max_users: number
  max_ci: number
  /** Servizi monitorati: numero massimo di ServiceMap del tenant (createServiceMap rifiuta oltre il limite). */
  max_service_maps: number
}
