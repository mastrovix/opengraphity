import { gql } from '@apollo/client'

// ── Notification rules ───────────────────────────────────────────────────────

export const GET_NOTIFICATION_RULES = gql`
  query GetNotificationRules {
    notificationRules {
      id eventType enabled severityOverride titleKey channels target conditions isSeed
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
