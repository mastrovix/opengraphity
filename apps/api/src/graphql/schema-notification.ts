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
  }

  input UpdateNotificationRuleInput {
    enabled:          Boolean
    severityOverride: String
    channels:         [String!]
    target:           String
  }
  `
}
