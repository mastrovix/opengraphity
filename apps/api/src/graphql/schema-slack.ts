export function slackSDL(): string {
  return `
  # ── Slack dell'organizzazione (ondata 8 di «Nulla cablato») ──────────────────

  type SlackInstallation {
    """app = l'app OpenGrafo installata con «Aggiungi a Slack»; token = un'app dell'organizzazione."""
    mode:            String!
    teamId:          String!
    teamName:        String!
    installedAt:     String!
    installedByName: String
  }

  type SlackRequestUrls {
    commands:      String!
    actions:       String!
    oauthCallback: String!
  }

  type SlackSettings {
    """null = Slack non collegato."""
    installation:       SlackInstallation
    """La piattaforma ha l'app OpenGrafo e un indirizzo pubblico: si offre «Aggiungi a Slack»."""
    appInstallAvailable: Boolean!
    """La piattaforma può cifrare i token (SECRETS_ENCRYPTION_KEY)."""
    secretsConfigured:  Boolean!
    """Gli indirizzi da dare a Slack; null = PUBLIC_BASE_URL non impostato, Slack non raggiunge OpenGrafo."""
    requestUrls:        SlackRequestUrls
  }

  extend type Query {
    slackSettings: SlackSettings!
  }

  extend type Mutation {
    """L'indirizzo di Slack per installare l'app OpenGrafo; si torna a returnTo."""
    startSlackInstall(returnTo: String!): String!
    """Collega il workspace con il token del bot e il segreto di firma di un'app dell'organizzazione (provati prima)."""
    connectSlackWithToken(botToken: String!, signingSecret: String!): SlackInstallation!
    disconnectSlack: Boolean!
  }
  `
}
