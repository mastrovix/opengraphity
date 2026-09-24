/** CMDB Health (24 Sep 2026): the live data-quality checks of the CMDB — services/cmdbHealth.ts. */
export function cmdbHealthSDL(): string {
  return `
  # ── CMDB Health ───────────────────────────────────────────────────────────────

  type CmdbHealthCheck {
    """One of: chain_orphan, chain_incomplete, relation_not_admitted, missing_owner_group, missing_support_group, certificate_unrelated, application_without_cis, certificate_expired_in_use, duplicate_name, required_field_empty."""
    key:             String!
    """How many CIs the check finds."""
    count:           Int!
    """How many CIs it looked at: the CIs in service it applies to."""
    population:      Int!
    """CI types the check could not look at (a certificate type without an expiry field)."""
    notCheckedTypes: [String!]!
    """A check the drawn CMDB chains decide, and the tenant has drawn none."""
    needsChains:     Boolean!
  }

  """For one CMDB chain: its roots in service, and how many have every required link all the way down."""
  type CmdbChainCoverage {
    chainId:  ID!
    name:     String!
    kind:     String!
    roots:    Int!
    complete: Int!
  }

  """A required link of a chain that a CI in service lacks."""
  type CmdbHealthMissingLink {
    chain:        String!
    ciType:       String!
    relationType: String!
    direction:    String!
  }

  type CmdbHealth {
    checks:          [CmdbHealthCheck!]!
    """The statuses the tenant calls retired: their CIs are left out."""
    retiredStatuses: [String!]!
    """How many CMDB chains the tenant has drawn."""
    chainCount:      Int!
    chainCoverage:   [CmdbChainCoverage!]!
  }

  type CmdbHealthItem {
    id:            ID!
    name:          String!
    """The CI type name (e.g. server)."""
    type:          String!
    environment:   String
    status:        String
    """certificate_expired_in_use: when it expired."""
    expiresAt:     String
    """certificate_expired_in_use: how many CIs in service are related to it."""
    inUseBy:       Int
    """duplicate_name: how many other CIs of its type have the same name."""
    sameName:      Int
    """required_field_empty: the labels of the required fields left empty."""
    missingFields: [String!]!
    """chain_incomplete: the required links the CI lacks."""
    missingLinks:  [CmdbHealthMissingLink!]!
    """relation_not_admitted: the relation no chain admits, and the CI at its other end."""
    relation:      String
    relatedId:     ID
    relatedName:   String
    relatedType:   String
  }

  type CmdbHealthItems {
    items:      [CmdbHealthItem!]!
    total:      Int!
    population: Int!
  }

  extend type Query {
    cmdbHealth: CmdbHealth!
    cmdbHealthItems(check: String!, type: String, environment: String, limit: Int, offset: Int): CmdbHealthItems!
  }
  `
}
