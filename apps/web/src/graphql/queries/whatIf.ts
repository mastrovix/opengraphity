import { gql } from '@apollo/client'

// ── What-if planning ─────────────────────────────────────────────────────────

export const WHAT_IF_ANALYSIS = gql`
  query WhatIfAnalysis($ciId: ID!, $action: String!, $depth: Int) {
    whatIfAnalysis(ciId: $ciId, action: $action, depth: $depth) {
      targetCI { id name type environment status impactLevel impactPath isRedundant }
      action
      impactedCIs { id name type environment status impactLevel impactPath isRedundant }
      impactedServices { id name type impactLevel impactPath isRedundant }
      impactedTeams { id name role impactedCICount }
      totalImpacted riskScore hasRedundancy openIncidents summary
    }
  }
`
