/**
 * Il punteggio dell'analisi d'impatto della change: una somma pesata dei
 * fattori, con i pesi del cliente (`lib/impactWeights.ts`) e limitata a 100.
 * Il livello NON si decide qui: è la fascia di rischio del cliente
 * (`riskBandOf`), che chi chiama applica al punteggio.
 */
import { MAX_RISK_SCORE } from './riskBands.js'
import type { ImpactWeightValues } from './impactWeights.js'

export interface RiskScoreParams {
  productionCIs:  number
  blastRadiusCIs: number
  openIncidents:  number
  failedChanges:  number
  ongoingChanges: number
}

export interface RiskScoreResult {
  score:   number
  details: string[]
}

export function calculateRiskScore(params: RiskScoreParams, weights: ImpactWeightValues): RiskScoreResult {
  let score = 0
  const details: string[] = []
  const add = (points: number, what: string) => {
    if (points <= 0) return
    score += points
    details.push(`+${String(points)} (${what})`)
  }

  add(params.productionCIs * weights.productionCI, `${String(params.productionCIs)} CI in the highest-risk environment`)
  add(Math.min(params.blastRadiusCIs * weights.blastRadiusCI, weights.blastRadiusCap), `${String(params.blastRadiusCIs)} CI in the blast radius`)
  add(params.openIncidents * weights.openIncident, `${String(params.openIncidents)} open incidents`)
  add(params.failedChanges * weights.failedChange, `${String(params.failedChanges)} failed changes`)
  add(params.ongoingChanges * weights.ongoingChange, `${String(params.ongoingChanges)} ongoing changes`)

  // Le fasce di rischio coprono 0..100: un punteggio oltre sarebbe senza fascia.
  return { score: Math.min(score, MAX_RISK_SCORE), details }
}
