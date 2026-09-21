/**
 * L'escalation delle regole di notifica — revisione del 14 set 2026 · NT-8.
 *
 * La pagina delle regole offre il tipo «Escalation» (`incident.escalation`) con
 * un ritardo in minuti e un messaggio: «se l'incident non è risolto dopo N
 * minuti, avvisa». Il ritardo si salvava e nessun codice lo leggeva; il job
 * `escalation_check` era uno stub. Adesso:
 *  1. alla nascita di un incident (`incident.created`, dal consumatore delle
 *     automazioni) si programma un controllo per ogni regola di escalation
 *     attiva, dopo il suo ritardo;
 *  2. al controllo, se la regola c'è ancora ed è attiva e l'incident non è in
 *     un passo terminale, si pubblica `incident.escalation`: la regola stessa
 *     lo consegna, con i suoi canali, il suo bersaglio e il suo messaggio.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publishEvent } from './publishEvent.js'
import { systemText } from './systemText.js'
import { isEntityConcluded } from './workflowHelpers.js'

export const ESCALATION_EVENT = 'incident.escalation'

export async function scheduleNotificationEscalations(tenantId: string, incidentId: string): Promise<number> {
  const session = getSession(undefined, 'READ')
  let rules: Array<{ id: string; delay: unknown }>
  try {
    rules = await runQuery<{ id: string; delay: unknown }>(session, `
      MATCH (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType, enabled: true})
      WHERE r.escalation_delay_minutes IS NOT NULL AND r.escalation_delay_minutes > 0
      RETURN r.id AS id, r.escalation_delay_minutes AS delay
    `, { tenantId, eventType: ESCALATION_EVENT })
  } finally { await session.close() }
  const { scheduleEscalationCheck } = await import('../jobs/workflowJobWorker.js')
  for (const r of rules) await scheduleEscalationCheck(incidentId, tenantId, r.id, Number(r.delay))
  return rules.length
}

export type EscalationOutcome = 'escalated' | 'rule_gone' | 'incident_gone' | 'incident_closed'

export async function runEscalationCheck(tenantId: string, incidentId: string, ruleId: string): Promise<EscalationOutcome> {
  const session = getSession(undefined, 'READ')
  try {
    const rule = await runQueryOne<{ message: string | null; delay: unknown }>(session, `
      MATCH (r:NotificationRule {id: $ruleId, tenant_id: $tenantId, event_type: $eventType, enabled: true})
      RETURN r.escalation_message AS message, r.escalation_delay_minutes AS delay
    `, { ruleId, tenantId, eventType: ESCALATION_EVENT })
    if (!rule) return 'rule_gone'
    const incident = await runQueryOne<{ title: string; number: string | null }>(session, `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) RETURN i.title AS title, i.number AS number
    `, { incidentId, tenantId })
    if (!incident) return 'incident_gone'
    // «Non risolto dopo N minuti» si misura sulla CLASSE del passo
    // (`resolved`/`closed`), non sul flag «terminale» (revisione totale ·
    // C-26): un cliente che toglie «terminale» al suo passo Risolto riceveva
    // l'avviso «non risolto» su incident risolti da ore.
    if (await isEntityConcluded(session, incidentId, tenantId)) return 'incident_closed'
    const message = rule.message && rule.message.trim()
      ? rule.message
      : await systemText(tenantId, 'notification.escalationDefault', { title: incident.title, minutes: Number(rule.delay) })
    await publishEvent(ESCALATION_EVENT, tenantId, 'system', {
      id: incidentId, entity_id: incidentId, entity_type: 'incident', rule_id: ruleId,
      title: incident.title, number: incident.number, message,
    })
    return 'escalated'
  } finally {
    await session.close()
  }
}
