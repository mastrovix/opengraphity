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
