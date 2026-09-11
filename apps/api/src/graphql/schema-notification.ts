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

  """
  Canali che il dispatcher sa davvero consegnare (revisione 2, D3.1). L'interfaccia
  delle regole offre SOLO questi per il tipo scelto; una regola che ne chiede altri
  viene rifiutata in scrittura (BAD_USER_INPUT) e, se scritta per altre vie, fa
  fallire il job di notifica con un errore esplicito invece di sparire in silenzio.
  """
  type NotificationRouting {
    "Canali instradabili per qualunque tipo di evento senza una riga dedicata (in_app, email)."
    defaultChannels: [String!]!
    "Tipi di evento con un formatter Slack/Teams dedicato e i loro canali (comprendono sempre i predefiniti)."
    byEventType: [NotificationRoutableChannels!]!
  }

  type NotificationRoutableChannels {
    eventType: String!
    channels:  [String!]!
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
