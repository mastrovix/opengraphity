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
    """L'organizzazione ha spento gli embedding: niente somiglianze (ondata 6)."""
    disabled: Boolean!
    """Why the computation of the embedding failed; null while it is queued or done (D15)."""
    failure: String
    items: [SimilarIncident!]!
  }

  type SuggestedArticlesResult {
    ready: Boolean!
    """L'organizzazione ha spento gli embedding: niente suggerimenti (ondata 6)."""
    disabled: Boolean!
    """Why the computation of the embedding failed; null while it is queued or done (D15)."""
    failure: String
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
  type ResolutionDraft {
    draft: String!
  }

  type ProblemCandidateIncident {
    id: ID!
    number: String
    title: String!
    status: String!
    severity: String!
  }

  """Candidato Problem da incident ricorrenti — suggerimento, mai auto-creato."""
  type ProblemCandidate {
    title: String!
    motivation: String!
    incidents: [ProblemCandidateIncident!]!
  }

  """
  The candidates, and what the clustering looked at to find them (D15): an
  empty list means «no cluster» only when the open incidents were analysed.
  """
  type ProblemCandidatesResult {
    candidates: [ProblemCandidate!]!
    "Open incidents compared with each other: the most recent, up to the cap."
    examined: Int!
    "Open incidents left out because their embedding is not computed yet: it has been queued."
    notAnalysed: Int!
    "Of those left out, how many had their computation fail (see the job queue)."
    analysisFailures: Int!
    "True when there are more open incidents than the cap: the older ones were not examined."
    capped: Boolean!
  }
`
