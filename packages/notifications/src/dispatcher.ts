import { randomUUID } from 'crypto'
import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type {
  IncidentCreatedPayload,
  IncidentResolvedPayload,
  IncidentEscalatedPayload,
  ChangeApprovedPayload,
  ChangeRejectedPayload,
  SLAWarningPayload,
  SLABreachedPayload,
  ProblemKnownErrorPayload,
} from '@opengraphity/types'
import { sseManager, InAppNotification } from './sse.js'
import { sendTeamsCard, TeamsCard } from './teams.js'
import { dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification } from './consumer.js'
import type { IncidentData, ChangeTaskPayload } from './formatters.js'

interface EnrichedIncidentPayload {
  id: string; title: string; severity: string; status: string
  ciName?: string; assignedTo?: string; resolved_at?: string
}

type SeverityLevel = InAppNotification['severity']

function mapIncidentSeverity(severity: string): SeverityLevel {
  switch (severity) {
    case 'critical': return 'error'
    case 'high':     return 'warning'
    case 'medium':   return 'info'
    default:         return 'info'
  }
}

export class NotificationDispatcher extends BaseConsumer<unknown> {
  constructor() {
    super('notification-service')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    console.log(`[dispatcher] Processing event: ${event.type}`)

    let notification: InAppNotification | null = null
    let teamsCard: TeamsCard | null = null

    switch (event.type) {
      case 'incident.created': {
        const p = event.payload as IncidentCreatedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.incident.created.title',
          message: `${p.title} — ${p.severity}`,
          severity: mapIncidentSeverity(p.severity),
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        if (p.severity === 'critical') {
          teamsCard = {
            title: 'notification.incident.created.title',
            message: `${p.title} — ${p.severity}`,
            color: 'FF0000',
            facts: [
              { name: 'Severity', value: p.severity },
              { name: 'Incident ID', value: p.id },
            ],
          }
        }
        break
      }

      case 'incident.assigned': {
        const p = event.payload as EnrichedIncidentPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.incident.assigned.title',
          message: `${p.title} — ${p.assignedTo !== '—' ? p.assignedTo : ''}`.trimEnd().replace(/\s—\s$/, ''),
          severity: 'info',
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'incident.in_progress': {
        const p = event.payload as EnrichedIncidentPayload
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.incident.in_progress.title',
          message: p.title ?? `Incident ${p.id}`,
          severity: 'info',
          entity_id: p.id, entity_type: 'incident',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'incident.on_hold': {
        const p = event.payload as EnrichedIncidentPayload
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.incident.on_hold.title',
          message: p.title ?? `Incident ${p.id}`,
          severity: 'warning',
          entity_id: p.id, entity_type: 'incident',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'incident.escalated': {
        const p = event.payload as EnrichedIncidentPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.incident.escalated.title',
          message: p.title ?? `Incident ${p.id}`,
          severity: 'warning',
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'incident.resolved': {
        const p = event.payload as IncidentResolvedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.incident.resolved.title',
          message: '',
          severity: 'success',
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'incident.closed': {
        const p = event.payload as EnrichedIncidentPayload
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.incident.closed.title',
          message: p.title ?? `Incident ${p.id}`,
          severity: 'info',
          entity_id: p.id, entity_type: 'incident',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'change.approved': {
        const p = event.payload as ChangeApprovedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.change.approved.title',
          message: p.title ?? p.id,
          severity: 'success',
          entity_id: p.id,
          entity_type: 'change',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'change.rejected': {
        const p = event.payload as ChangeRejectedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.change.rejected.title',
          message: p.title ?? p.id,
          severity: 'error',
          entity_id: p.id,
          entity_type: 'change',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'sla.warning': {
        const p = event.payload as SLAWarningPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.sla.warning.title',
          message: `${p.minutes_remaining}`,
          severity: 'warning',
          entity_id: p.entity_id,
          entity_type: p.entity_type,
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'sla.breached': {
        const p = event.payload as SLABreachedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.sla.breached.title',
          message: `${p.entity_type} ${p.entity_id}`,
          severity: 'error',
          entity_id: p.entity_id,
          entity_type: p.entity_type,
          timestamp: event.timestamp,
          read: false,
        }
        teamsCard = {
          title: 'SLA Violato',
          message: `SLA superato per ${p.entity_type} ${p.entity_id}`,
          color: 'FF0000',
          facts: [
            { name: 'Entity Type', value: p.entity_type },
            { name: 'Entity ID', value: p.entity_id },
            { name: 'Breached At', value: p.breached_at },
          ],
        }
        break
      }

      case 'problem.known_error': {
        const p = event.payload as ProblemKnownErrorPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'notification.problem.known_error.title',
          message: '',
          severity: 'warning',
          entity_id: p.id,
          entity_type: 'problem',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'change.completed': {
        const p = event.payload as ChangeApprovedPayload
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.change.completed.title',
          message: p.title ?? p.id,
          severity: 'success',
          entity_id: p.id, entity_type: 'change',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'change.failed': {
        const p = event.payload as ChangeApprovedPayload
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.change.failed.title',
          message: p.title ?? p.id,
          severity: 'error',
          entity_id: p.id, entity_type: 'change',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'change.task_assigned': {
        const p = event.payload as { changeTitle?: string; ciName?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.change.task_assigned.title',
          message: `${p.changeTitle ?? ''} — ${p.ciName ?? ''}`.replace(/^\s*—\s*|\s*—\s*$/, '').trim() || '',
          severity: 'info',
          entity_type: 'change',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'problem.created': {
        const p = event.payload as { id: string; title?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.problem.created.title',
          message: p.title ?? `Problem ${p.id}`,
          severity: 'warning',
          entity_id: p.id, entity_type: 'problem',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'problem.under_investigation': {
        const p = event.payload as { id: string; title?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.problem.investigating.title',
          message: p.title ?? `Problem ${p.id}`,
          severity: 'info',
          entity_id: p.id, entity_type: 'problem',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'problem.deferred': {
        const p = event.payload as { id: string; title?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.problem.deferred.title',
          message: p.title ?? `Problem ${p.id}`,
          severity: 'warning',
          entity_id: p.id, entity_type: 'problem',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'problem.resolved': {
        const p = event.payload as { id: string; title?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.problem.resolved.title',
          message: p.title ?? `Problem ${p.id}`,
          severity: 'success',
          entity_id: p.id, entity_type: 'problem',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      case 'problem.closed': {
        const p = event.payload as { id: string; title?: string }
        notification = {
          id: randomUUID(), type: event.type,
          title: 'notification.problem.closed.title',
          message: p.title ?? `Problem ${p.id}`,
          severity: 'info',
          entity_id: p.id, entity_type: 'problem',
          timestamp: event.timestamp, read: false,
        }
        break
      }

      default:
        console.log(`[dispatcher] Event type "${event.type}" — no notification rule, skipping`)
        return
    }

    if (notification) {
      sseManager.sendToTenant(event.tenant_id, notification)
    }

    if (teamsCard) {
      await sendTeamsCard(teamsCard)
    }

    // ── Slack/Teams channel notifications ────────────────────────────────────
    await this.dispatchToChannels(event)
  }

  private async dispatchToChannels(event: DomainEvent<unknown>): Promise<void> {
    const INCIDENT_EVENT_MAP: Record<string, 'assigned' | 'resolved' | 'escalation' | 'sla_breach'> = {
      'incident.created':   'assigned',
      'incident.resolved':  'resolved',
      'incident.escalated': 'escalation',
      'incident.assigned':  'assigned',
    }

    if (event.type === 'change.approved') {
      const p = event.payload as EnrichedIncidentPayload
      if (p.id && p.title) {
        await dispatchChangeNotification(event.tenant_id, {
          id:          p.id,
          title:       p.title,
          type:        (p as unknown as { type?: string }).type ?? '—',
          status:      p.status ?? 'scheduled',
          tenantId:    event.tenant_id,
        })
      }
      return
    }

    if (event.type === 'change.task_assigned') {
      const p = event.payload as ChangeTaskPayload
      await dispatchChangeTaskNotification(event.tenant_id, p)
      return
    }

    if (event.type === 'sla.breached') {
      const p = event.payload as SLABreachedPayload
      if (p.entity_type !== 'incident') return
      const incident: IncidentData = {
        id: p.entity_id, title: `SLA breach su incident ${p.entity_id}`,
        severity: 'high', status: 'open', tenantId: event.tenant_id,
      }
      await dispatchIncidentNotification(event.tenant_id, 'sla_breach', incident)
      return
    }

    const notifType = INCIDENT_EVENT_MAP[event.type]
    if (!notifType) return

    const p = event.payload as EnrichedIncidentPayload
    if (!p.id || !p.title) {
      console.warn(`[dispatcher] Skipping channel dispatch — missing payload fields for event ${event.type}`)
      return
    }
    const incident: IncidentData = {
      id:           p.id,
      title:        p.title,
      severity:     p.severity,
      status:       p.status,
      ciNames:      p.ciName && p.ciName !== '—' ? [p.ciName] : undefined,
      assigneeName: p.assignedTo && p.assignedTo !== '—' ? p.assignedTo : null,
      tenantId:     event.tenant_id,
    }
    await dispatchIncidentNotification(event.tenant_id, notifType, incident)
  }
}

export async function createNotificationDispatcher(): Promise<NotificationDispatcher> {
  const dispatcher = new NotificationDispatcher()
  await dispatcher.start()
  return dispatcher
}
