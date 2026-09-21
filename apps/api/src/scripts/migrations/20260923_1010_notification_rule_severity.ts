/**
 * Revisione del 14 set 2026 · NT-1: la severità delle regole di notifica torna
 * nel suo vocabolario (`NOTIFICATION_SEVERITIES`: info, success, warning, error).
 *
 * Fino a questa revisione `updateNotificationRule` accettava le priorità dei
 * ticket (low/medium/high/critical) e rifiutava le severità che la pagina
 * offriva: le regole salvate con una priorità hanno una severità che il
 * pannello non riconosce. Qui si riportano nel vocabolario, con la
 * corrispondenza dichiarata (low → info, medium → warning, high/critical →
 * error) e una riga di log per ciascuna. Una severità assente diventa `info`,
 * lo stesso valore che la creazione assegna. Idempotente: tocca solo i valori
 * fuori vocabolario.
 */
import type { Migration } from '@opengraphity/neo4j'
import { NOTIFICATION_SEVERITIES } from '@opengraphity/types'

const DA_PRIORITA: Readonly<Record<string, string>> = { low: 'info', medium: 'warning', high: 'error', critical: 'error' }

export const notificationRuleSeverity: Migration = {
  id: '20260923_1010_notification_rule_severity',
  description: 'NotificationRule.severity_override riportata nel vocabolario delle severità dei messaggi (le priorità accettate per errore diventano info/warning/error)',
  async up(session) {
    const res = await session.run(`
      MATCH (r:NotificationRule)
      WHERE r.severity_override IS NULL OR NOT r.severity_override IN $allowed
      WITH r, r.severity_override AS prima
      SET r.severity_override = coalesce($map[prima], 'info')
      RETURN r.tenant_id AS tenant, r.event_type AS eventType, prima, r.severity_override AS dopo
      ORDER BY tenant, eventType
    `, { allowed: [...NOTIFICATION_SEVERITIES], map: DA_PRIORITA })
    for (const r of res.records) {
      console.log(`[${notificationRuleSeverity.id}] ${String(r.get('tenant'))} / ${String(r.get('eventType'))}: ${JSON.stringify(r.get('prima'))} → "${String(r.get('dopo'))}"`)
    }
    console.log(`[${notificationRuleSeverity.id}] ${String(res.records.length)} regole riportate nel vocabolario`)
  },
}
