export const similaritySDL = `
  """Semantic similarity — powered by the Neo4j vector indexes."""
  type SimilarIncident {
    id: ID!
    number: String
    title: String!
    status: String!
    severity: String!
    createdAt: String
    resolvedAt: String
    "Cosine similarity in [0,1] — higher is more similar."
    score: Float!
  }

  type SuggestedArticle {
    id: ID!
    title: String!
    slug: String
    category: String
    score: Float!
  }

  """
  ready=false means the source incident has no embedding yet (it is computed
  asynchronously right after creation) — distinct from "no similar items".
  """
  type SimilarIncidentsResult {
    ready: Boolean!
    items: [SimilarIncident!]!
  }

  type SuggestedArticlesResult {
    ready: Boolean!
    items: [SuggestedArticle!]!
  }

  """AI-assisted triage suggestion — explicit, motivated, never auto-applied."""
  type SimilarForTriage {
    id: ID!
    number: String
    title: String!
    severity: String!
    category: String
    status: String!
    teamName: String
    score: Float!
  }

  type TriageSuggestion {
    severity: String!
    category: String!
    teamName: String
    confidence: String!
    motivation: String!
    riskFactors: [String!]!
    similarUsed: [SimilarForTriage!]!
  }
`
