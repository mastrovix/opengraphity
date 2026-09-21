/**
 * Revisione del 14 set 2026 · NT-8/F6: il preavviso SLA diventa un campo della
 * policy (`SLAPolicyNode.warning_minutes`) e dello stato (`SLAStatus.
 * tier_warning_minutes`, che lo scheduler legge). Era 30 minuti fissi nel
 * codice per tutti i clienti: le policy e gli stati esistenti ricevono quel
 * valore, così niente cambia finché l'amministratore non lo modifica dalla
 * pagina SLA Policies. Idempotente: tocca solo dove manca.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_SLA_WARNING_MINUTES } from '@opengraphity/types'

export const slaWarningMinutes: Migration = {
  id: '20260923_1050_sla_warning_minutes',
  description: `Preavviso SLA per policy: warning_minutes = ${DEFAULT_SLA_WARNING_MINUTES} su SLAPolicyNode e tier_warning_minutes sugli SLAStatus dove manca`,
  async up(session) {
    const policies = await session.run(`
      MATCH (p:SLAPolicyNode) WHERE p.warning_minutes IS NULL
      SET p.warning_minutes = $minutes
      RETURN p.tenant_id AS tenant, count(*) AS n
    `, { minutes: DEFAULT_SLA_WARNING_MINUTES })
    const statuses = await session.run(`
      MATCH (s:SLAStatus) WHERE s.tier_warning_minutes IS NULL
      SET s.tier_warning_minutes = $minutes
      RETURN s.tenant_id AS tenant, count(*) AS n
    `, { minutes: DEFAULT_SLA_WARNING_MINUTES })
    for (const r of policies.records) console.log(`[${slaWarningMinutes.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} policy`)
    for (const r of statuses.records) console.log(`[${slaWarningMinutes.id}] ${String(r.get('tenant'))}: ${String(r.get('n'))} SLAStatus`)
  },
}
