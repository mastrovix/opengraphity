import { gql } from '@apollo/client/core'

// ── Portal: Tickets ───────────────────────────────────────────────────────────

export const GET_MY_TICKETS = gql`
  query MyTickets($status: String, $page: Int, $pageSize: Int) {
    myTickets(status: $status, page: $page, pageSize: $pageSize) {
      items {
        id type title status priority category
        createdAt updatedAt assignedTeam
      }
      total
    }
  }
`

export const GET_MY_TICKET = gql`
  query MyTicket($id: ID!) {
    myTicket(id: $id) {
      id type title description status priority category
      createdAt updatedAt assignedTeam
      comments {
        id body isInternal authorId authorName authorEmail createdAt
      }
      attachments {
        id filename mimeType sizeBytes uploadedBy uploadedAt downloadUrl
      }
      history {
        fromStep toStep label triggeredAt triggeredBy
      }
    }
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
  query KBCategories {
    kbCategories {
      name count
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

export const GET_FIELD_VISIBILITY_RULES = gql`
  query GetFieldVisibilityRules($entityType: String!) {
    fieldVisibilityRules(entityType: $entityType) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const GET_FIELD_REQUIREMENT_RULES = gql`
  query GetFieldRequirementRules($entityType: String!, $workflowStep: String) {
    fieldRequirementRules(entityType: $entityType, workflowStep: $workflowStep) {
      id entityType fieldName required workflowStep
    }
  }
`
