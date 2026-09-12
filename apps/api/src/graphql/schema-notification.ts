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
    """
    Restringimento delle regole sul tipo STABILE <entità>.step_entered (D-22):
    la regola scatta solo per i passi con quello scopo. Vocabolario chiuso
    WORKFLOW_STEP_PURPOSES; null = nessun restringimento per scopo.
    """
    stepPurpose:      String
    "Come stepPurpose, ma per la categoria del passo (active | waiting | resolved | …)."
    stepCategory:     String
    """
    Falso quando NIENTE nel prodotto né nei workflow di questo tenant produce
    il tipo di evento della regola: la regola è accesa e non scatterà mai. È il
    caso della regola di fabbrica incident.on_hold, morta da sempre perché il
    passo si chiama pending. La pagina lo mostra: prima non risultava da
    nessuna parte (il dispatcher usciva su if (!rule) return).
    """
    eventProduced:    Boolean!
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
    "Tutti i bersagli del vocabolario: quelli offerti per un tipo di evento che non ha una riga dedicata."
    defaultTargets: [String!]!
    "I bersagli che hanno senso per ciascun tipo di evento: alla nascita di un ticket non esistono ancora assegnatario e team."
    targetsByEventType: [NotificationEventTargets!]!
  }

  type NotificationEventTargets {
    eventType: String!
    targets: [String!]!
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
    # Restringimento per i soli tipi <entità>.step_entered: scopo e/o categoria
    # del passo. Su ogni altro tipo di evento sono rifiutati.
    stepPurpose:      String
    stepCategory:     String
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
    # "" (stringa vuota) toglie il restringimento; assente = non cambia.
    stepPurpose:      String
    stepCategory:     String
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
