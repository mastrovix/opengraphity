import { gql } from '@apollo/client'

/** Slack dell'organizzazione (ondata 8): stato del collegamento e indirizzi da dare a Slack. */
export const GET_SLACK_SETTINGS = gql`
  query GetSlackSettings {
    slackSettings {
      installation { mode teamId teamName installedAt installedByName }
      appInstallAvailable
      secretsConfigured
      requestUrls { commands actions oauthCallback }
    }
  }
`

/** Regole delle password e login aziendale del realm dell'organizzazione (ondata 8). */
export const GET_LOGIN_SETTINGS = gql`
  query GetLoginSettings {
    loginSettings {
      passwordRules { minLength uppercase lowercase digits special notUsername notEmail history expireDays lockoutEnabled lockoutFailures lockoutMinutes }
      passwordRulesOutOfRange { rule value min max }
      providers { kind displayName enabled clientId tenant hostedDomain metadataUrl redirectUri samlSpMetadataUrl }
      addresses { kind redirectUri samlSpMetadataUrl }
    }
  }
`
