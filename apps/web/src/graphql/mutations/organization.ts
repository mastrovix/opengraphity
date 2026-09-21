import { gql } from '@apollo/client'

// Verifica «Cosa resta cablato», ondata 6.

export const SET_TENANT_NAME = gql`
  mutation SetTenantName($name: String!) { setTenantName(name: $name) }
`

export const SET_TENANT_BRAND = gql`
  mutation SetTenantBrand($input: TenantBrandInput!) {
    setTenantBrand(input: $input) { displayName senderName replyTo logoUrl logoMimeType isDefault }
  }
`

export const SET_TICKET_NUMBERING = gql`
  mutation SetTicketNumbering($input: TicketNumberingInput!) {
    setTicketNumbering(input: $input) {
      incident { prefix digits }
      problem { prefix digits }
      change { prefix digits }
      serviceRequest { prefix digits }
      isDefault
    }
  }
`

export const SET_ATTACHMENT_POLICY = gql`
  mutation SetAttachmentPolicy($input: AttachmentPolicyInput!) {
    setAttachmentPolicy(input: $input) { maxSizeMb extensions platformMaxSizeMb platformExtensions isDefault }
  }
`

export const SET_AI_SETTINGS = gql`
  mutation SetAISettings($input: AISettingsInput!) {
    setAISettings(input: $input) {
      features { triage assistant reportAnalysis postIncident kbArticles embeddings }
      clusterMinSimilarity clusterMinSize platformConfigured isDefault
    }
  }
`

export const UPDATE_COMMENT = gql`
  mutation UpdateComment($id: ID!, $body: String!) {
    updateComment(id: $id, body: $body) { id body editedAt editedByName }
  }
`

export const DELETE_COMMENT = gql`
  mutation DeleteComment($id: ID!) { deleteComment(id: $id) }
`

/** Accende o spegne gli script del cliente: validazioni, azioni, webhook e formule. */
export const SET_SCRIPTING_ENABLED = gql`
  mutation SetScriptingEnabled($enabled: Boolean!) {
    setScriptingEnabled(enabled: $enabled) { enabled plan }
  }
`
