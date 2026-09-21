/**
 * Revisione totale del 16 set 2026 · B-33: il preavviso sullo stato SLA
 * (`SLAStatus.tier_warning_minutes`) deve essere un intero positivo — lo
 * scheduler e il badge del ticket ci contano, e dove non lo era la pagina di
 * dettaglio del ticket falliva per intero.
 *
 * La migrazione del 23 set metteva il default solo dove la proprietà era NULL:
 * uno zero o un negativo (scritti a mano o da un import) restavano. Qui il
 * valore si riprende dalla POLICY dello stato, che è la sua sorgente, e solo
 * se nemmeno la policy ce l'ha si mette il default del prodotto. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_SLA_WARNING_MINUTES } from '@opengraphity/types'

export const slaWarningRepair: Migration = {
  id:          '20261002_1020_sla_warning_repair',
  description: 'tier_warning_minutes non positivo sugli SLAStatus: ripreso dalla policy (B-33)',

  async up(session) {
    const fromPolicy = await session.run(`
      MATCH (s:SLAStatus)
      WHERE s.tier_warning_minutes IS NULL OR s.tier_warning_minutes <= 0
      MATCH (p:SLAPolicyNode {id: s.policy_id, tenant_id: s.tenant_id})
      WHERE p.warning_minutes IS NOT NULL AND p.warning_minutes > 0
      SET s.tier_warning_minutes = p.warning_minutes
      RETURN count(s) AS n`)
    const fallback = await session.run(`
      MATCH (s:SLAStatus)
      WHERE s.tier_warning_minutes IS NULL OR s.tier_warning_minutes <= 0
      SET s.tier_warning_minutes = $minutes
      RETURN count(s) AS n`, { minutes: DEFAULT_SLA_WARNING_MINUTES })
    const policies = await session.run(`
      MATCH (p:SLAPolicyNode)
      WHERE p.warning_minutes IS NULL OR p.warning_minutes <= 0
      SET p.warning_minutes = $minutes
      RETURN count(p) AS n`, { minutes: DEFAULT_SLA_WARNING_MINUTES })
    console.log(`[${slaWarningRepair.id}] dalla policy: ${String(fromPolicy.records[0]?.get('n') ?? 0)}`)
    console.log(`[${slaWarningRepair.id}] default del prodotto: ${String(fallback.records[0]?.get('n') ?? 0)}`)
    console.log(`[${slaWarningRepair.id}] policy riparate: ${String(policies.records[0]?.get('n') ?? 0)}`)
  },
}
