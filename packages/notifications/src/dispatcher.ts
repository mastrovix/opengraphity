import { randomUUID } from 'crypto'
import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { getSession } from '@opengraphity/neo4j'
import { sseManager, InAppNotification } from './sse.js'
import { sendTeamsCard, TeamsCard } from './teams.js'
import { dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification } from './consumer.js'
import type { IncidentData, ChangeTaskPayload } from './formatters.js'

// ── Rule model ────────────────────────────────────────────────────────────────

interface NotificationRule {
  id:               string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
}

// ── Rule cache (60s TTL, per-process) ─────────────────────────────────────────

interface CachedRule { rule: NotificationRule | null; expiresAt: number }

const CACHE_TTL_MS = 60_000
const ruleCache = new Map<string, CachedRule>()

function cacheKey(tenantId: string, eventType: string): string {
  return `${tenantId}:${eventType}`
}

async function fetchRule(tenantId: string, eventType: string): Promise<NotificationRule | null> {
  const session = getSession()
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})
         RETURN r`,
        { tenantId, eventType },
      ),
    )
    if (!result.records.length) return null
    const props = result.records[0].get('r').properties as Record<string, unknown>
    if (!props['enabled']) return null
    return {
      id:               props['id']                as string,
      enabled:          props['enabled']           as boolean,
      severityOverride: (props['severity_override'] ?? 'info') as string,
      titleKey:         props['title_key']         as string,
      channels:         (props['channels']         as string[]) ?? ['in_app'],
      target:           (props['target']           as string)   ?? 'all',
    }
  } finally {
    await session.close()
  }
}

async function getRule(tenantId: string, eventType: string): Promise<NotificationRule | null> {
  const key = cacheKey(tenantId, eventType)
  const cached = ruleCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.rule
  const rule = await fetchRule(tenantId, eventType)
  ruleCache.set(key, { rule, expiresAt: Date.now() + CACHE_TTL_MS })
  return rule
}

export function invalidateRuleCache(tenantId: string, eventType?: string): void {
  if (eventType) {
    ruleCache.delete(cacheKey(tenantId, eventType))
  } else {
    for (const key of ruleCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) ruleCache.delete(key)
    }
  }
}

// ── Payload helpers ───────────────────────────────────────────────────────────

function extractEntityId(payload: unknown): string | undefined {
  const p = payload as Record<string, unknown>
  const id = p['id'] ?? p['entity_id']
  return typeof id === 'string' ? id : undefined
}

function extractEntityType(eventType: string, payload: unknown): string {
  const p = payload as Record<string, unknown>
  if (typeof p['entity_type'] === 'string') return p['entity_type']
  return eventType.split('.')[0] ?? 'unknown'
}

function extractMessage(eventType: string, payload: unknown): string {
  const p = payload as Record<string, unknown>

  const title      = typeof p['title']      === 'string' && p['title']      ? p['title']      as string : null
  const severity   = typeof p['severity']   === 'string' && p['severity']   ? p['severity']   as string : null
  const assignedTo = typeof p['assignedTo'] === 'string' && p['assignedTo'] !== '—' ? p['assignedTo'] as string : null
  const changeTitle= typeof p['changeTitle']=== 'string' && p['changeTitle'] ? p['changeTitle'] as string : null
  const ciName     = typeof p['ciName']     === 'string' && p['ciName'] !== '—' ? p['ciName']     as string : null
  const minRem     = typeof p['minutes_remaining'] === 'number' ? (p['minutes_remaining'] as number) : null
  const entityType = typeof p['entity_type'] === 'string' ? p['entity_type'] as string : null
  const entityId   = typeof p['entity_id']   === 'string' ? p['entity_id']   as string : null

  if (minRem !== null) return String(minRem)
  if (changeTitle)     return ciName ? `${changeTitle} — ${ciName}` : changeTitle
  if (entityType && entityId && !title) return `${entityType} ${entityId}`

  const parts: string[] = []
  if (title)      parts.push(title)
  if (severity && eventType === 'incident.created') parts.push(severity)
  if (assignedTo) parts.push(assignedTo)
  return parts.join(' — ')
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export class NotificationDispatcher extends BaseConsumer<unknown> {
  constructor() {
    super('notification-service')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    // Workflow step custom notification (embed rule in payload, no DB lookup)
    if (event.type === 'workflow.step.entered') {
      await this.processWorkflowStep(event)
      return
    }

    const rule = await getRule(event.tenant_id, event.type)
    if (!rule) return

    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        event.type,
      title:       rule.titleKey,
      message:     extractMessage(event.type, event.payload),
      severity:    rule.severityOverride as InAppNotification['severity'],
      entity_id:   extractEntityId(event.payload),
      entity_type: extractEntityType(event.type, event.payload),
      timestamp:   event.timestamp,
      read:        false,
    }

    if (rule.channels.includes('in_app')) {
      sseManager.sendToTenant(event.tenant_id, notification)
    }

    if (rule.channels.some((c) => c === 'slack' || c === 'teams')) {
      await this.dispatchToChannels(event, rule.channels)
    }

    if (rule.channels.includes('email')) {
      await this.dispatchEmail(event, notification)
    }
  }

  private async processWorkflowStep(event: DomainEvent<unknown>): Promise<void> {
    const p = event.payload as {
      stepName: string
      entityType: string
      entityId: string
      notifyRule: { title_key: string; severity: string; channels: string[]; target: string }
    }
    const nr = p.notifyRule
    if (!nr) return

    const notification: InAppNotification = {
      id:          randomUUID(),
      type:        'workflow.step.entered',
      title:       nr.title_key,
      message:     p.stepName,
      severity:    nr.severity as InAppNotification['severity'],
      entity_id:   p.entityId,
      entity_type: p.entityType,
      timestamp:   event.timestamp,
      read:        false,
    }

    if (nr.channels.includes('in_app')) {
      sseManager.sendToTenant(event.tenant_id, notification)
    }

  }

  // ── Slack / Teams channel dispatch (driven by rule.channels) ────────────────

  private async dispatchToChannels(event: DomainEvent<unknown>, channels: string[]): Promise<void> {
    const hasSlack = channels.includes('slack')
    const hasTeams = channels.includes('teams')
    if (!hasSlack && !hasTeams) return

    // Change approved → Slack
    if (event.type === 'change.approved') {
      const p = event.payload as Record<string, unknown>
      if (p['id'] && p['title']) {
        await dispatchChangeNotification(event.tenant_id, {
          id:       p['id']     as string,
          title:    p['title']  as string,
          type:     (p['type']  as string) ?? '—',
          status:   (p['status'] as string) ?? 'scheduled',
          tenantId: event.tenant_id,
        })
      }
      return
    }

    // Change task assigned → Slack
    if (event.type === 'change.task_assigned') {
      await dispatchChangeTaskNotification(event.tenant_id, event.payload as ChangeTaskPayload)
      return
    }

    // SLA breached → Slack + Teams card
    if (event.type === 'sla.breached') {
      const p = event.payload as Record<string, unknown>
      if (hasTeams) {
        const card: TeamsCard = {
          title:   'SLA Violato',
          message: `SLA superato per ${p['entity_type']} ${p['entity_id']}`,
          color:   'FF0000',
          facts: [
            { name: 'Entity Type', value: p['entity_type'] as string },
            { name: 'Entity ID',   value: p['entity_id']   as string },
            { name: 'Breached At', value: p['breached_at'] as string },
          ],
        }
        await sendTeamsCard(card)
      }
      if (hasSlack && p['entity_type'] === 'incident') {
        const incident: IncidentData = {
          id:       p['entity_id'] as string,
          title:    `SLA breach su incident ${p['entity_id']}`,
          severity: 'high',
          status:   'open',
          tenantId: event.tenant_id,
        }
        await dispatchIncidentNotification(event.tenant_id, 'sla_breach', incident)
      }
      return
    }

    // Incident critical → Teams card on incident.created
    if (event.type === 'incident.created' && hasTeams) {
      const p = event.payload as Record<string, unknown>
      if (p['severity'] === 'critical') {
        const card: TeamsCard = {
          title:   'notification.incident.created.title',
          message: `${p['title']} — ${p['severity']}`,
          color:   'FF0000',
          facts: [
            { name: 'Severity',    value: p['severity'] as string },
            { name: 'Incident ID', value: p['id']       as string },
          ],
        }
        await sendTeamsCard(card)
      }
    }

    // Incident Slack dispatch
    const INCIDENT_EVENT_MAP: Record<string, 'assigned' | 'resolved' | 'escalation' | 'sla_breach'> = {
      'incident.created':   'assigned',
      'incident.resolved':  'resolved',
      'incident.escalated': 'escalation',
      'incident.assigned':  'assigned',
    }
    const notifType = INCIDENT_EVENT_MAP[event.type]
    if (!notifType) return

    const p = event.payload as Record<string, unknown>
    if (!p['id'] || !p['title']) return

    const incident: IncidentData = {
      id:           p['id']         as string,
      title:        p['title']      as string,
      severity:     p['severity']   as string,
      status:       p['status']     as string,
      ciNames:      typeof p['ciName'] === 'string' && p['ciName'] !== '—' ? [p['ciName'] as string] : undefined,
      assigneeName: typeof p['assignedTo'] === 'string' && p['assignedTo'] !== '—' ? p['assignedTo'] as string : null,
      tenantId:     event.tenant_id,
    }
    await dispatchIncidentNotification(event.tenant_id, notifType, incident)
  }

  private async dispatchEmail(event: DomainEvent<unknown>, notification: InAppNotification): Promise<void> {
    try {
      const { sendEmail } = await import('./email.js')

      // Only send to admin/operator users with real email addresses
      const session = getSession()
      try {
        const result = await session.executeRead(tx => tx.run(
          `MATCH (u:User {tenant_id: $tenantId})
           WHERE u.role IN ['admin', 'operator', 'TENANT_ADMIN', 'OPERATOR']
             AND u.email IS NOT NULL
             AND u.email <> ''
             AND NOT u.email CONTAINS '@demo.'
             AND NOT u.email CONTAINS '@opengrafo.com'
             AND NOT u.email =~ 'usr-\\\\d+@.*'
           RETURN u.email AS email`,
          { tenantId: event.tenant_id },
        ))
        const emails = result.records.map(r => r.get('email') as string).filter(Boolean)
        if (emails.length === 0) return

        const subject = `[${event.tenant_id}] ${notification.title}: ${notification.message.slice(0, 80)}`
        const html = `<div style="font-family:Arial,sans-serif;padding:16px;">
          <h2 style="color:#0F172A;margin:0 0 8px;">${notification.title}</h2>
          <p style="color:#64748B;margin:0 0 16px;">${notification.message}</p>
          ${notification.entity_id ? `<a href="${process.env['APP_URL'] ?? 'http://localhost:5173'}/${notification.entity_type ?? 'incidents'}s/${notification.entity_id}" style="color:#0EA5E9;">Vedi dettagli</a>` : ''}
        </div>`

        // Batch emails (Resend limit: 50 per call)
        for (let i = 0; i < emails.length; i += 50) {
          const batch = emails.slice(i, i + 50)
          await sendEmail({ to: batch, subject, html })
        }
      } finally {
        await session.close()
      }
    } catch {
      // Email delivery failure is non-fatal
    }
  }
}

export async function createNotificationDispatcher(): Promise<NotificationDispatcher> {
  const dispatcher = new NotificationDispatcher()
  await dispatcher.start()
  return dispatcher
}
