import { randomUUID } from 'crypto'
import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type {
  IncidentCreatedPayload,
  IncidentResolvedPayload,
  ChangeApprovedPayload,
  ChangeRejectedPayload,
  SLAWarningPayload,
  SLABreachedPayload,
  ProblemKnownErrorPayload,
} from '@opengraphity/types'
import { Message } from 'amqplib'
import { sseManager, InAppNotification } from './sse.js'
import { sendTeamsCard, TeamsCard } from './teams.js'

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

  async process(event: DomainEvent<unknown>, _msg: Message): Promise<void> {
    console.log(`[dispatcher] Processing event: ${event.type}`)

    let notification: InAppNotification | null = null
    let teamsCard: TeamsCard | null = null

    switch (event.type) {
      case 'incident.created': {
        const p = event.payload as IncidentCreatedPayload
        if (p.severity !== 'critical' && p.severity !== 'high') break
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'Nuovo Incident Critico',
          message: `${p.title} — ${p.severity}`,
          severity: mapIncidentSeverity(p.severity),
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        if (p.severity === 'critical') {
          teamsCard = {
            title: 'Nuovo Incident Critico',
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

      case 'incident.resolved': {
        const p = event.payload as IncidentResolvedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: "Incident Risolto",
          message: "L'incident è stato risolto",
          severity: 'success',
          entity_id: p.id,
          entity_type: 'incident',
          timestamp: event.timestamp,
          read: false,
        }
        break
      }

      case 'change.approved': {
        const p = event.payload as ChangeApprovedPayload
        notification = {
          id: randomUUID(),
          type: event.type,
          title: 'Change Approvato',
          message: `La change ${p.id} è stata approvata`,
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
          title: 'Change Rifiutato',
          message: `La change ${p.id} è stata rifiutata`,
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
          title: 'SLA in Scadenza',
          message: `Scade tra ${p.minutes_remaining} minuti`,
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
          title: 'SLA Violato',
          message: `SLA superato per ${p.entity_type} ${p.entity_id}`,
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
          title: 'Known Error Identificato',
          message: 'Workaround disponibile',
          severity: 'warning',
          entity_id: p.id,
          entity_type: 'problem',
          timestamp: event.timestamp,
          read: false,
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
  }
}

export async function createNotificationDispatcher(): Promise<NotificationDispatcher> {
  const dispatcher = new NotificationDispatcher()
  await dispatcher.start()
  return dispatcher
}
