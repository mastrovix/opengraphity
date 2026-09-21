import { gql } from '@apollo/client'

export const START_SLACK_INSTALL = gql`
  mutation StartSlackInstall($returnTo: String!) {
    startSlackInstall(returnTo: $returnTo)
  }
`

export const CONNECT_SLACK_WITH_TOKEN = gql`
  mutation ConnectSlackWithToken($botToken: String!, $signingSecret: String!) {
    connectSlackWithToken(botToken: $botToken, signingSecret: $signingSecret) { mode teamId teamName installedAt installedByName }
  }
`

export const DISCONNECT_SLACK = gql`
  mutation DisconnectSlack {
    disconnectSlack
  }
`

export const SET_PASSWORD_RULES = gql`
  mutation SetPasswordRules($input: PasswordRulesInput!) {
    setPasswordRules(input: $input) { minLength uppercase lowercase digits special notUsername notEmail history expireDays lockoutEnabled lockoutFailures lockoutMinutes }
  }
`

export const TEST_LOGIN_PROVIDER = gql`
  mutation TestLoginProvider($input: LoginProviderInput!) {
    testLoginProvider(input: $input) { ok checks { key ok detail } }
  }
`

export const SAVE_LOGIN_PROVIDER = gql`
  mutation SaveLoginProvider($input: LoginProviderInput!, $activate: Boolean!) {
    saveLoginProvider(input: $input, activate: $activate) { kind displayName enabled clientId tenant hostedDomain metadataUrl redirectUri samlSpMetadataUrl }
  }
`

export const DEACTIVATE_LOGIN_PROVIDER = gql`
  mutation DeactivateLoginProvider($kind: String!) {
    deactivateLoginProvider(kind: $kind) { kind displayName enabled clientId tenant hostedDomain metadataUrl redirectUri samlSpMetadataUrl }
  }
`

export const REMOVE_LOGIN_PROVIDER = gql`
  mutation RemoveLoginProvider($kind: String!) {
    removeLoginProvider(kind: $kind)
  }
`
