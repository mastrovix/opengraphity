import { gql } from '@apollo/client'

// ── Notification rules ───────────────────────────────────────────────────────

export const GET_NOTIFICATION_RULES = gql`
  query GetNotificationRules {
    notificationRules {
      id eventType enabled severityOverride titleKey channels target conditions isSeed
      stepPurpose stepCategory eventProduced
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget
      digestTime digestRecipients
    }
  }
`

// Canali che il dispatcher sa davvero consegnare per tipo di evento (D3.1):
// l'interfaccia offre SOLO questi, senza conoscere nomi di eventi o canali.
export const GET_NOTIFICATION_ROUTING = gql`
  query GetNotificationRouting {
    notificationRouting {
      defaultChannels
      byEventType { eventType channels }
      defaultTargets
      targetsByEventType { eventType targets }
    }
  }
`

/**
 * I tipi di evento che i workflow DI QUESTO TENANT possono davvero produrre
 * (D-22): il tipo stabile `<entità>.step_entered` e, per ogni passo, l'alias
 * col nome del passo. Il form delle regole e gli abbonamenti dei webhook in
 * uscita li offrono al posto di una lista di costanti — prima erano sei tipi
 * fissi, nessuno dei quali era un passo intermedio, e abbonarsi al proprio
 * passo era impossibile.
 */
export const GET_WORKFLOW_EVENT_TYPES = gql`
  query GetWorkflowEventTypes {
    workflowEventTypes {
      eventType entityType stepName stepLabel stepPurpose stepCategory stable
    }
  }
`
