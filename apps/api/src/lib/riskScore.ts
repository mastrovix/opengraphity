export interface RiskScoreParams {
  productionCIs:  number
  blastRadiusCIs: number
  openIncidents:  number
  failedChanges:  number
  ongoingChanges: number
}

export interface RiskScoreResult {
  score:   number
  level:   string
  details: string[]
}

export function calculateRiskScore(params: RiskScoreParams): RiskScoreResult {
  let score = 0
  const details: string[] = []

  const prodScore = params.productionCIs * 20
  if (prodScore > 0) {
    score += prodScore
    details.push(`+${prodScore} (${params.productionCIs} CI in production)`)
  }

  const blastScore = Math.min(params.blastRadiusCIs * 10, 40)
  if (blastScore > 0) {
    score += blastScore
    details.push(`+${blastScore} (${params.blastRadiusCIs} CI nel blast radius)`)
  }

  const incidentScore = params.openIncidents * 15
  if (incidentScore > 0) {
    score += incidentScore
    details.push(`+${incidentScore} (${params.openIncidents} incident aperti)`)
  }

  const failedScore = params.failedChanges * 10
  if (failedScore > 0) {
    score += failedScore
    details.push(`+${failedScore} (${params.failedChanges} change falliti)`)
  }

  const ongoingScore = params.ongoingChanges * 5
  if (ongoingScore > 0) {
    score += ongoingScore
    details.push(`+${ongoingScore} (${params.ongoingChanges} change in corso)`)
  }

  const level =
    score >= 76 ? 'critical' :
    score >= 51 ? 'high' :
    score >= 26 ? 'medium' : 'low'

  return { score, level, details }
}
