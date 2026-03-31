import type { Session } from 'neo4j-driver'
import { v4 as uuidv4 } from 'uuid'

interface RuleDef {
  event_type: string
  severity:   string
  channels:   string[]
  target:     string
  title_key:  string
}

const DEFAULT_RULES: RuleDef[] = [
  { event_type: 'incident.created',             severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.created.title'      },
  { event_type: 'incident.assigned',            severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.assigned.title'     },
  { event_type: 'incident.in_progress',         severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.in_progress.title'  },
  { event_type: 'incident.on_hold',             severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.on_hold.title'      },
  { event_type: 'incident.escalated',           severity: 'error',   channels: ['in_app', 'slack'], target: 'all',      title_key: 'notification.incident.escalated.title'    },
  { event_type: 'incident.resolved',            severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.resolved.title'     },
  { event_type: 'incident.closed',              severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.incident.closed.title'       },
  { event_type: 'change.approved',              severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.change.approved.title'       },
  { event_type: 'change.completed',             severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.change.completed.title'      },
  { event_type: 'change.failed',                severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.change.failed.title'         },
  { event_type: 'change.rejected',              severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.change.rejected.title'       },
  { event_type: 'change.task_assigned',         severity: 'info',    channels: ['in_app'],          target: 'assignee', title_key: 'notification.change.task_assigned.title'  },
  { event_type: 'problem.created',              severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.problem.created.title'       },
  { event_type: 'problem.under_investigation',  severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.problem.investigating.title' },
  { event_type: 'problem.deferred',             severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.problem.deferred.title'      },
  { event_type: 'problem.resolved',             severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.problem.resolved.title'      },
  { event_type: 'problem.closed',               severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.problem.closed.title'        },
  { event_type: 'sla.warning',                  severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.sla.warning.title'           },
  { event_type: 'sla.breached',                 severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.sla.breached.title'          },
]

export async function seedNotificationRules(tenantId: string, session: Session): Promise<void> {
  const now = new Date().toISOString()
  let created = 0
  let skipped = 0

  for (const rule of DEFAULT_RULES) {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})
         ON CREATE SET
           r.id                = $id,
           r.enabled           = true,
           r.severity_override = $severity,
           r.title_key         = $titleKey,
           r.channels          = $channels,
           r.target            = $target,
           r.conditions        = null,
           r.created_at        = $now,
           r.updated_at        = $now
         RETURN (r.created_at = $now) AS wasCreated`,
        {
          tenantId,
          eventType: rule.event_type,
          id:        uuidv4(),
          severity:  rule.severity,
          titleKey:  rule.title_key,
          channels:  rule.channels,
          target:    rule.target,
          now,
        },
      ),
    )
    const wasCreated = result.records[0]?.get('wasCreated') as boolean
    if (wasCreated) created++; else skipped++
  }

  console.log(`  ✓ NotificationRule: ${created} create, ${skipped} già esistenti`)
}
