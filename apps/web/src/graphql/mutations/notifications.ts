import { gql } from '@apollo/client'

// ── Notification rules ───────────────────────────────────────────────────────

export const UPDATE_NOTIFICATION_RULE = gql`
  mutation UpdateNotificationRule($id: ID!, $input: UpdateNotificationRuleInput!) {
    updateNotificationRule(id: $id, input: $input) {
      id eventType enabled severityOverride titleKey channels target isSeed
      stepPurpose stepCategory eventProduced
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget digestTime digestRecipients
    }
  }
`

export const CREATE_NOTIFICATION_RULE = gql`
  mutation CreateNotificationRule($input: CreateNotificationRuleInput!) {
    createNotificationRule(input: $input) {
      id eventType enabled severityOverride titleKey channels target isSeed
      stepPurpose stepCategory eventProduced
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget digestTime digestRecipients
    }
  }
`

export const DELETE_NOTIFICATION_RULE = gql`
  mutation DeleteNotificationRule($id: ID!) {
    deleteNotificationRule(id: $id)
  }
`
