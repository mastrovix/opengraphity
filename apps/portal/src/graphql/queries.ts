import { gql } from '@apollo/client/core'

// ── Portal: Tickets ───────────────────────────────────────────────────────────

export const GET_MY_TICKETS = gql`
  query MyTickets($status: String, $page: Int, $pageSize: Int, $language: String) {
    myTickets(status: $status, page: $page, pageSize: $pageSize, language: $language) {
      items {
        id number type title status statusCategory statusLabel priority category
        createdAt updatedAt assignedTeam
      }
      total
    }
  }
`

export const GET_MY_TICKET = gql`
  query MyTicket($id: ID!, $language: String) {
    myTicket(id: $id, language: $language) {
      id number type title description status statusCategory statusLabel priority category
      createdAt updatedAt assignedTeam
      comments {
        id body isInternal authorId authorName authorEmail createdAt
      }
      attachments {
        id filename mimeType sizeBytes uploadedBy uploadedAt downloadUrl
      }
      history {
        fromStep toStep fromLabel toLabel label triggeredAt triggeredBy
      }
    }
  }
`

/** Le categorie del ticket: il vocabolario del cliente con le sue etichette (giro del 14 set 2026). */
export const GET_TICKET_CATEGORIES = gql`
  query TicketCategories($language: String) {
    ticketCategories(language: $language) { name label }
  }
`

export const GET_MY_TICKET_STATS = gql`
  query MyTicketStats {
    myTicketStats {
      open inProgress resolved total
    }
  }
`

// ── Knowledge Base ────────────────────────────────────────────────────────────

export const GET_KB_ARTICLES = gql`
  query KBArticles($search: String, $category: String, $page: Int, $pageSize: Int) {
    kbArticles(search: $search, category: $category, status: "published", page: $page, pageSize: $pageSize) {
      items {
        id title slug body category tags views helpfulCount notHelpfulCount createdAt publishedAt
      }
      total
    }
  }
`

export const GET_KB_ARTICLE_BY_SLUG = gql`
  query KBArticleBySlug($slug: String!) {
    kbArticleBySlug(slug: $slug) {
      id title slug body category tags views
      helpfulCount notHelpfulCount authorName createdAt publishedAt
    }
  }
`

export const GET_KB_CATEGORIES = gql`
  query KBCategories($language: String) {
    kbCategories(language: $language) {
      name label count
    }
  }
`

// ── User ──────────────────────────────────────────────────────────────────────

export const GET_ME = gql`
  query Me {
    me {
      id name email role
    }
  }
`

// Field visibility/requirement rules: documents live in @opengraphity/web-core
// (GET_FIELD_VISIBILITY_RULES / GET_FIELD_REQUIREMENT_RULES) next to useFormFieldRules.

export const GET_SERVICE_CATALOG = gql`
  query ServiceCatalog {
    serviceCatalogItems(activeOnly: true) {
      id name description category requiresApproval
    }
  }
`

/**
 * In che lingua si legge questo cliente. Il portale la chiede come il web: la
 * lingua predefinita e configurazione dell'azienda e sta nel grafo, e per un
 * `end_user` — che non ha nessuna pagina dove scegliere la propria — e l'unica
 * cosa che decide.
 */
export const GET_TENANT_LANGUAGE_SETTINGS = gql`
  query GetTenantLanguageSettings {
    tenantLanguageSettings { available defaultLanguage fallback }
  }
`
