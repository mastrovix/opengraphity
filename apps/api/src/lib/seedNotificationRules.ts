import type { Queryable } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'
import { notificationLogger } from './logger.js'

interface RuleDef {
  event_type: string
  severity:   string
  channels:   string[]
  target:     string
  title_key:  string
  /**
   * Stato iniziale della regola per un tenant NUOVO (assente = attiva). Vale
   * solo ON CREATE: nei tenant esistenti la regola resta com'è (MERGE).
   * `event.received` nasce spenta (revisione, 3.3): con la dieta di rumore
   * scatta solo all'apertura di un ciclo, ma per uno strumento con centinaia
   * di allarmi è comunque un toast per allarme a tutto il tenant; l'incident
   * correlato (`event.correlated`) e la salute del CI restano notificati.
   */
  enabled?:   boolean
}

export const DEFAULT_NOTIFICATION_RULES: readonly RuleDef[] = [
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
  { event_type: 'ola.breached',                 severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.ola.breached.title'          },
  // Discovery / Sync
  { event_type: 'sync.completed',               severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.sync.completed.title'        },
  { event_type: 'sync.failed',                  severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.sync.failed.title'           },
  { event_type: 'conflict.created',             severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.sync.conflict.title'         },
  // Event Management (allarmi dal monitoraggio → salute del CI)
  { event_type: 'event.received',               severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.received.title',       enabled: false },
  { event_type: 'event.resolved',               severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.resolved.title'        },
  { event_type: 'event.orphan',                 severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.orphan.title'          },
  { event_type: 'ci.health_changed',            severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.ci.health_changed.title'     },
  // Event Management, ondata 3 (correlazione automatica e finestre di change)
  { event_type: 'event.suppressed',             severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.event.suppressed.title'      },
  { event_type: 'event.correlated',             severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.correlated.title'      },
  // Event Management, ondata 4 (sfarfallio e tempeste di allarmi)
  { event_type: 'event.flapping',               severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.flapping.title'        },
  { event_type: 'event.stable',                 severity: 'info',    channels: ['in_app'],          target: 'all',      title_key: 'notification.event.stable.title'          },
  { event_type: 'event.storm_started',          severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.event.storm_started.title'   },
  { event_type: 'event.storm_ended',            severity: 'success', channels: ['in_app'],          target: 'all',      title_key: 'notification.event.storm_ended.title'     },
  // Servizi monitorati, ondata 3: la salute del servizio è un avviso in app
  // (cambia anche in meglio); l'incident aperto dal monitoraggio è il segnale
  // che un servizio di business è giù.
  { event_type: 'service.health_changed',       severity: 'warning', channels: ['in_app'],          target: 'all',      title_key: 'notification.service.health_changed.title' },
  { event_type: 'service.incident_opened',      severity: 'error',   channels: ['in_app'],          target: 'all',      title_key: 'notification.service.incident_opened.title' },
]

// Ogni canale seminato dev'essere instradabile dal dispatcher per quel tipo
// (ROUTABLE_CHANNELS_BY_EVENT in @opengraphity/notifications): `slack` su
// event.storm_started, service.incident_opened e sync.failed era inerte —
// nessun formatter, nessuna consegna, nessun errore (revisione 2, D3.1). Il
// test lib/__tests__/seedNotificationRules.test.ts lo pinna; la migrazione
// 20260911_1150 ripulisce le regole già scritte sui tenant esistenti.

/**
 * I tipi di evento che il prodotto semina, in ordine: l'interfaccia li usa per
 * sapere quali bersagli offrire per ciascuno (`notificationRouting`). Derivati
 * dalle regole di serie, così non esiste una seconda lista da tenere allineata.
 */
export const SEEDED_EVENT_TYPES: readonly string[] = DEFAULT_NOTIFICATION_RULES.map((r) => r.event_type)

export interface SeedNotificationRulesResult { created: number; skipped: number }

/**
 * Crea le regole di notifica predefinite del tenant (MERGE per
 * tenant_id + event_type: idempotente, non ritocca quelle esistenti — anche
 * `enabled` vale solo alla creazione, quindi un default che cambia non
 * riaccende né spegne nulla nei tenant già seminati).
 * Accetta una sessione o una transazione gestita (`Queryable`), così la
 * chiamano sia l'onboarding sia le migrazioni.
 */
export async function seedNotificationRules(tenantId: string, session: Queryable): Promise<SeedNotificationRulesResult> {
  const now = new Date().toISOString()
  let created = 0
  let skipped = 0

  for (const rule of DEFAULT_NOTIFICATION_RULES) {
    const result = await session.run(
      `MERGE (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})
       ON CREATE SET
         r.id                = $id,
         r.enabled           = $enabled,
         r.severity_override = $severity,
         r.title_key         = $titleKey,
         r.channels          = $channels,
         r.target            = $target,
         r.conditions        = null,
         r.is_seed           = true,
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
        enabled:   rule.enabled ?? true,
        now,
      },
    )
    const wasCreated = result.records[0]?.get('wasCreated') as boolean
    if (wasCreated) created++; else skipped++
  }

  notificationLogger.info({ tenantId, created, skipped }, 'NotificationRule seed completato')
  return { created, skipped }
}
