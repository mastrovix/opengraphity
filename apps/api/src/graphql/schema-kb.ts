export function knowledgeBaseSDL(): string {
  return `#graphql

  type KBArticle {
    id:                 ID!
    title:              String!
    slug:               String!
    body:               String!
    category:           String!
    tags:               [String!]!
    status:             String!
    authorId:           String!
    authorName:         String!
    views:              Int!
    helpfulCount:       Int!
    notHelpfulCount:    Int!
    createdAt:          String!
    updatedAt:          String!
    publishedAt:        String
    workflowInstanceId: ID
    currentStep:        String
    version:            Int!
    lastEditedByName:   String
    """Who the article is for: \`staff\` (the portal does not show it) or \`everyone\` (24 Sep 2026)."""
    audience:           String!
    """The vote of the person reading: true helpful, false not helpful, null none (one vote per person)."""
    myVote:             Boolean
  }

  type KBRelatedArticle {
    id:         ID!
    title:      String!
    slug:       String!
    category:   String!
    views:      Int!
    """How many tags it shares with the article it is related to."""
    sharedTags: Int!
  }

  type KBArticleVersion {
    version:      Int!
    title:        String!
    body:         String!
    category:     String!
    tags:         [String!]!
    editedById:   String
    editedByName: String
    editedAt:     String!
  }

  type KBArticlesResult {
    items: [KBArticle!]!
    total: Int!
  }

  """Una categoria della Knowledge Base: un valore del vocabolario kb_category del cliente."""
  type KBCategory {
    name:  String!
    """L'etichetta nella lingua chiesta (o in quella del cliente)."""
    label: String!
    """Il colore del Dizionario (neutral, success, info, purple, warning, orange, danger), o null."""
    color: String
    """Articoli pubblicati in questa categoria (anche zero)."""
    count: Int!
  }
  `
}
