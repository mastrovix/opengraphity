import { gql } from '@apollo/client'

// ── Organizzazione: nome, marchio, numerazione, allegati, AI ──────────────────
// Verifica «Cosa resta cablato», ondata 6.

export const GET_TENANT_NAME = gql`
  query GetTenantName { tenantName }
`

/** Nome e logo dell'organizzazione: li legge ogni ruolo. */
export const GET_TENANT_BRAND = gql`
  query GetTenantBrand { tenantBrand { displayName logoUrl isDefault } }
`

export const GET_TENANT_BRAND_SETTINGS = gql`
  query GetTenantBrandSettings {
    tenantBrandSettings { displayName senderName replyTo logoUrl logoMimeType isDefault }
  }
`

export const GET_TICKET_NUMBERING = gql`
  query GetTicketNumbering {
    ticketNumbering {
      incident { prefix digits }
      problem { prefix digits }
      change { prefix digits }
      serviceRequest { prefix digits }
      isDefault
    }
  }
`

export const GET_ATTACHMENT_POLICY = gql`
  query GetAttachmentPolicy {
    attachmentPolicy { maxSizeMb extensions platformMaxSizeMb platformExtensions isDefault }
  }
`

/**
 * I campi si ELENCANO, non si interpolano da `AI_FEATURE_KEYS`: il guardiano
 * `apps/api/src/graphql/__tests__/webDocuments.test.ts` legge questi documenti
 * come TESTO e li valida contro lo schema, e un `${…}` glieli renderebbe
 * illeggibili (mi e successo il 19 set 2026). L'allineamento con l'elenco lo
 * controlla `aiSettingsDocument.test.ts` nel web.
 */
export const GET_AI_SETTINGS = gql`
  query GetAISettings {
    aiSettings {
      features { triage assistant reportAnalysis postIncident kbArticles embeddings formDesigner }
      clusterMinSimilarity clusterMinSize platformConfigured isDefault
    }
  }
`

/** L'interruttore degli script del cliente (ondata 6). */
export const GET_SCRIPTING_SETTINGS = gql`
  query GetScriptingSettings {
    scriptingSettings { enabled plan }
  }
`
