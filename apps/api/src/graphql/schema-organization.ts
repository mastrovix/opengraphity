export function organizationSDL(): string {
  return `
  # ── Organizzazione: nome, marchio, numerazione, allegati, AI ─────────────────
  # Verifica «Cosa resta cablato», ondata 6: prima nel codice, in variabili
  # d'ambiente di piattaforma o solo da riga di comando.

  """Il marchio come lo mostrano portale e web: nome e logo."""
  type TenantBrandView {
    displayName: String!
    """Indirizzo del logo (stessa origine); null = il logo del prodotto."""
    logoUrl:     String
    """Vero finché l'organizzazione non ha scelto un marchio: il nome è quello del prodotto."""
    isDefault:   Boolean!
  }

  type TenantBrandSettings {
    displayName:  String!
    senderName:   String!
    replyTo:      String
    logoUrl:      String
    """\`image/png\` o \`image/svg+xml\`. Nei PDF entra solo il PNG."""
    logoMimeType: String
    isDefault:    Boolean!
  }

  input TenantBrandInput {
    displayName: String!
    senderName:  String!
    replyTo:     String
  }

  type TicketNumberFormat {
    prefix: String!
    digits: Int!
  }

  type TicketNumbering {
    incident:        TicketNumberFormat!
    problem:         TicketNumberFormat!
    change:          TicketNumberFormat!
    serviceRequest:  TicketNumberFormat!
    isDefault:       Boolean!
  }

  input TicketNumberFormatInput {
    prefix: String!
    digits: Int!
  }

  input TicketNumberingInput {
    incident:       TicketNumberFormatInput!
    problem:        TicketNumberFormatInput!
    change:         TicketNumberFormatInput!
    serviceRequest: TicketNumberFormatInput!
  }

  type AttachmentPolicy {
    maxSizeMb:  Int!
    extensions: [String!]!
    """Il tetto della piattaforma per la dimensione (MB)."""
    platformMaxSizeMb:  Int!
    """Le estensioni fra cui l'organizzazione può scegliere."""
    platformExtensions: [String!]!
    isDefault:  Boolean!
  }

  input AttachmentPolicyInput {
    maxSizeMb:  Int!
    extensions: [String!]!
  }

  type AIFeatureSwitches {
    triage:         Boolean!
    assistant:      Boolean!
    reportAnalysis: Boolean!
    postIncident:   Boolean!
    kbArticles:     Boolean!
    embeddings:     Boolean!
    """Disegna il modulo di una service request da una descrizione (19 set 2026)."""
    formDesigner:   Boolean!
    """Disegna una sezione di report da una descrizione (19 set 2026)."""
    reportDesigner: Boolean!
    """Il prodotto analizza i propri errori e propone rimedi (20 set 2026). L'unico spento di fabbrica: legge un archivio che attraversa il perimetro fra i clienti."""
    platformSelfAnalysis: Boolean!
  }

  type AISettings {
    features:             AIFeatureSwitches!
    clusterMinSimilarity: Float!
    clusterMinSize:       Int!
    """Vero quando la piattaforma ha un modello configurato: senza, nessuna funzione AI funziona comunque."""
    platformConfigured:   Boolean!
    isDefault:            Boolean!
  }

  input AIFeatureSwitchesInput {
    triage:         Boolean!
    assistant:      Boolean!
    reportAnalysis: Boolean!
    postIncident:   Boolean!
    kbArticles:     Boolean!
    embeddings:     Boolean!
    formDesigner:   Boolean!
    reportDesigner: Boolean!
    platformSelfAnalysis: Boolean!
  }

  input AISettingsInput {
    features:             AIFeatureSwitchesInput!
    clusterMinSimilarity: Float!
    clusterMinSize:       Int!
  }

  extend type Query {
    """Nome dell'organizzazione (admin)."""
    tenantName: String!
    """Nome e logo mostrati da portale e web: li legge ogni ruolo."""
    tenantBrand: TenantBrandView!
    """Il marchio completo: mittente e risposte (admin)."""
    tenantBrandSettings: TenantBrandSettings!
    """Prefisso e cifre dei numeri dei ticket nuovi (admin)."""
    ticketNumbering: TicketNumbering!
    """Dimensione e tipi degli allegati: lo leggono anche le pagine che caricano file."""
    attachmentPolicy: AttachmentPolicy!
    """Quali funzioni AI sono accese: lo leggono le pagine che le offrono."""
    aiSettings: AISettings!
    """
    Se gli script scritti dal cliente possono girare: validazione dei campi,
    azione «esegui script», trasformazione dei webhook e le FORMULE dei campi
    calcolati dei moduli (ondata 6). Era un limite di piano senza interruttore.
    """
    scriptingSettings: ScriptingSettings!
  }

  """L'interruttore degli script del cliente, e il piano con cui il tenant e' nato."""
  type ScriptingSettings {
    enabled: Boolean!
    """Il piano: resta come informazione (decide il valore iniziale), non come divieto."""
    plan:    String!
  }

  extend type Mutation {
    setTenantName(name: String!): String!
    setTenantBrand(input: TenantBrandInput!): TenantBrandSettings!
    """Vale per i ticket nuovi: i numeri esistenti non cambiano, il contatore prosegue."""
    setTicketNumbering(input: TicketNumberingInput!): TicketNumbering!
    setAttachmentPolicy(input: AttachmentPolicyInput!): AttachmentPolicy!
    """Una funzione spenta non chiama il modello."""
    setAISettings(input: AISettingsInput!): AISettings!
    """
    Accende o spegne gli script del cliente. Spenti, chi ne ha configurato uno
    riceve un rifiuto che lo dice: nessuno script viene saltato in silenzio.
    """
    setScriptingEnabled(enabled: Boolean!): ScriptingSettings!
  }
  `
}
