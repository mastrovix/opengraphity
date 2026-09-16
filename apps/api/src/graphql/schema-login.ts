export function loginSDL(): string {
  return `
  # ── Accesso dell'organizzazione: regole delle password e login aziendale ─────
  # Ondata 8 di «Nulla cablato»: si scrivono nel realm Keycloak dell'organizzazione.

  type PasswordRules {
    minLength:       Int!
    uppercase:       Int!
    lowercase:       Int!
    digits:          Int!
    special:         Int!
    notUsername:     Boolean!
    notEmail:        Boolean!
    """Password precedenti non riusabili (0 = nessun controllo)."""
    history:         Int!
    """Giorni dopo i quali la password va cambiata (0 = mai)."""
    expireDays:      Int!
    lockoutEnabled:  Boolean!
    lockoutFailures: Int!
    lockoutMinutes:  Int!
  }

  input PasswordRulesInput {
    minLength:       Int!
    uppercase:       Int!
    lowercase:       Int!
    digits:          Int!
    special:         Int!
    notUsername:     Boolean!
    notEmail:        Boolean!
    history:         Int!
    expireDays:      Int!
    lockoutEnabled:  Boolean!
    lockoutFailures: Int!
    lockoutMinutes:  Int!
  }

  type LoginProvider {
    """microsoft | google | saml"""
    kind:              String!
    displayName:       String!
    enabled:           Boolean!
    clientId:          String
    tenant:            String
    hostedDomain:      String
    metadataUrl:       String
    """L'indirizzo di ritorno da registrare presso il provider."""
    redirectUri:       String!
    """SAML: i metadati di OpenGrafo da dare al provider."""
    samlSpMetadataUrl: String
  }

  """Il segreto non si legge mai: si scrive, e si riscrive per attivare (si prova in quel momento)."""
  input LoginProviderInput {
    kind:         String!
    displayName:  String
    clientId:     String
    clientSecret: String
    tenant:       String
    hostedDomain: String
    metadataUrl:  String
  }

  type LoginProviderCheck {
    key:    String!
    ok:     Boolean!
    detail: String
  }

  type LoginProviderTest {
    ok:     Boolean!
    checks: [LoginProviderCheck!]!
  }

  """Gli indirizzi da registrare presso un provider: servono PRIMA di avere id e segreto."""
  type LoginProviderAddresses {
    kind:              String!
    redirectUri:       String!
    samlSpMetadataUrl: String
  }

  """
  Una regola che il realm porta FUORI dall'intervallo che il prodotto governa
  (revisione totale · A-19): un realm configurato dalla console di Keycloak può
  avere «blocca dopo 2 tentativi». La pagina la mostra e dice perché il valore
  non si può alzare o abbassare da qui, invece di rifiutare ogni salvataggio
  senza spiegazioni.
  """
  type PasswordRuleOutOfRange {
    rule:  String!
    value: Int!
    min:   Int!
    max:   Int!
  }

  type LoginSettings {
    passwordRules: PasswordRules!
    """Vuoto quando il realm sta tutto dentro gli intervalli del prodotto."""
    passwordRulesOutOfRange: [PasswordRuleOutOfRange!]!
    providers:     [LoginProvider!]!
    addresses:     [LoginProviderAddresses!]!
  }

  extend type Query {
    loginSettings: LoginSettings!
  }

  extend type Mutation {
    setPasswordRules(input: PasswordRulesInput!): PasswordRules!
    testLoginProvider(input: LoginProviderInput!): LoginProviderTest!
    """activate: true = prova e, se passa, accende; false = salva spento."""
    saveLoginProvider(input: LoginProviderInput!, activate: Boolean!): LoginProvider!
    deactivateLoginProvider(kind: String!): LoginProvider!
    removeLoginProvider(kind: String!): Boolean!
  }
  `
}
