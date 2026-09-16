import { gql } from '@apollo/client/core'

// ── Portal: Tickets ───────────────────────────────────────────────────────────

export const GET_MY_TICKETS = gql`
  query MyTickets($status: String, $page: Int, $pageSize: Int, $language: String) {
    myTickets(status: $status, page: $page, pageSize: $pageSize, language: $language) {
      items {
        id number type title status statusCategory statusLabel priority priorityLabel priorityColor category
        createdAt updatedAt assignedTeam
      }
      total
    }
  }
`

export const GET_MY_TICKET = gql`
  query MyTicket($id: ID!, $language: String) {
    myTicket(id: $id, language: $language) {
      id number type title description status statusCategory statusLabel priority priorityLabel priorityColor category
      createdAt updatedAt assignedTeam
      comments {
        id body isInternal authorId authorName authorEmail createdAt
        editedAt editedByName deletedAt deletedByName
      }
      attachments {
        id filename mimeType sizeBytes uploadedBy uploadedAt downloadUrl
      }
      history {
        fromStep toStep fromLabel toLabel label triggeredAt triggeredBy
      }
      customFields { name label fieldType value valueLabel(language: $language) }
    }
  }
`

/** Le categorie del ticket: il vocabolario del cliente con le sue etichette (giro del 14 set 2026). */
export const GET_TICKET_CATEGORIES = gql`
  query TicketCategories($language: String) {
    ticketCategories(language: $language) { name label }
  }
`

/** Le severità offerte nel portale, con le parole scelte dall'amministratore (verifica «Cosa resta cablato», ondata 1). */
export const GET_PORTAL_SEVERITY_CHOICES = gql`
  query PortalSeverityChoices($language: String) {
    portalSeverityChoices(language: $language) { value label color }
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
      id name email role permissions language
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

/** I campi del cliente offerti all'utente finale aprendo un incident o una richiesta (verifica «Cosa resta cablato», ondata 4). */
export const GET_PORTAL_CUSTOM_FIELDS = gql`
  query PortalCustomFields($entityType: String!, $category: String, $language: String) {
    portalCustomFields(entityType: $entityType, category: $category) {
      name label fieldType required
      options(language: $language) { value label }
    }
  }
`

/** Nome e logo dell'organizzazione nell'intestazione (verifica «Cosa resta cablato», ondata 6). */
export const GET_TENANT_BRAND = gql`
  query GetTenantBrand { tenantBrand { displayName logoUrl isDefault } }
`

/**
 * Il modulo della voce di catalogo (moduli del catalogo, ondata 1).
 *
 * `endUser: true` non è un dettaglio: chiede all'API di offrire SOLO i campi
 * che il modulo destina agli utenti finali. Il server poi rifiuta comunque una
 * risposta a un campo non offerto — il browser decide cosa mostrare, il server
 * decide cosa accettare.
 */
export const GET_PORTAL_CATALOG_FORM = gql`
  query GetPortalCatalogForm($itemId: ID!, $language: String) {
    catalogFormToFill(itemId: $itemId, endUser: true) {
      itemId
      revision
      definition
      fields {
        name fieldType label required vocabulary help formula
        labels { language label }
        helps { language label }
        options(language: $language) { value label }
        tableColumns(language: $language) { name label fieldType required options { value label } }
      }
    }
  }
`
