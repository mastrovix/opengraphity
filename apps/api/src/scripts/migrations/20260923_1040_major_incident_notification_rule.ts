/**
 * Revisione del 14 set 2026 · IT-24 e NT-8: le regole di notifica predefinite
 * `incident.major_declared` e `digest.daily` (alle 08:00, com'era il digest
 * cablato, così niente cambia finché l'amministratore non la modifica) sui
 * tenant esistenti. Stesso seed dell'onboarding
 * (MERGE per tenant_id + event_type): idempotente, non ritocca le regole che
 * l'amministratore ha già.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../../lib/seedNotificationRules.js'

export const majorIncidentNotificationRule: Migration = {
  id: '20260923_1040_major_incident_notification_rule',
  description: 'NotificationRule predefinite nuove su ogni tenant: incident.major_declared (la dichiarazione di Major Incident ora pubblica un evento) e digest.daily (il digest era cablato alle 08:00)',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) WHERE t.id IS NOT NULL RETURN t.id AS id ORDER BY t.id`)
    let created = 0
    for (const record of tenants.records) created += (await seedNotificationRules(String(record.get('id')), session)).created
    console.log(`[${majorIncidentNotificationRule.id}] ${tenants.records.length} tenant: ${created} regole create`)
  },
}
