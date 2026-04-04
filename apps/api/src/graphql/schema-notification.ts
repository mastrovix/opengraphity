export function notificationSDL(): string {
  return `
  # ── Notifications ─────────────────────────────────────────────────────────────

  type NotificationChannel {
    id: ID!
    platform: String!
    name: String!
    webhookUrl: String
    channelId: String
    eventTypes: [String!]!
    active: Boolean!
    createdAt: String!
  }

  type NotificationRule {
    id:               ID!
    eventType:        String!
    enabled:          Boolean!
    severityOverride: String!
    titleKey:         String!
    channels:         [String!]!
    target:           String!
    conditions:       String
    isSeed:           Boolean!
    # Escalation fields (eventType = 'incident.escalation')
    escalationDelayMinutes: Int
    escalationTarget:       String
    escalationMessage:      String
    # SLA warning fields (eventType = 'sla.warning')
    slaWarningThresholdPercent: Int
    slaWarningTarget:           String
    # Digest fields (eventType = 'digest.daily')
    digestTime:       String
    digestRecipients: [String!]
  }

  input CreateNotificationChannelInput {
    platform: String!
    name: String!
    webhookUrl: String
    channelId: String
    eventTypes: [String!]!
  }

  input CreateNotificationRuleInput {
    eventType:        String!
    enabled:          Boolean
    severityOverride: String
    titleKey:         String!
    channels:         [String!]!
    target:           String!
    # Escalation
    escalationDelayMinutes: Int
    escalationTarget:       String
    escalationMessage:      String
    # SLA warning
    slaWarningThresholdPercent: Int
    slaWarningTarget:           String
    # Digest
    digestTime:       String
    digestRecipients: [String!]
  }

  input UpdateNotificationRuleInput {
    enabled:          Boolean
    severityOverride: String
    channels:         [String!]
    target:           String
    # Escalation
    escalationDelayMinutes: Int
    escalationTarget:       String
    escalationMessage:      String
    # SLA warning
    slaWarningThresholdPercent: Int
    slaWarningTarget:           String
    # Digest
    digestTime:       String
    digestRecipients: [String!]
  }
  `
}
