import { describe, it, expect } from 'vitest'
import { calculateRiskScore } from '../riskScore.js'

describe('calculateRiskScore', () => {
  it('score 0 con nessun fattore', () => {
    const result = calculateRiskScore({
      productionCIs: 0, blastRadiusCIs: 0, openIncidents: 0, failedChanges: 0, ongoingChanges: 0,
    })
    expect(result.score).toBe(0)
    expect(result.level).toBe('low')
    expect(result.details).toHaveLength(0)
  })

  it('score critical con CI production e incident aperti', () => {
    const result = calculateRiskScore({
      productionCIs: 3, blastRadiusCIs: 5, openIncidents: 2, failedChanges: 1, ongoingChanges: 0,
    })
    // 3*20=60 + min(5*10,40)=40 + 2*15=30 + 1*10=10 = 140
    expect(result.score).toBe(140)
    expect(result.level).toBe('critical')
  })

  it('score medium con solo blast radius', () => {
    const result = calculateRiskScore({
      productionCIs: 0, blastRadiusCIs: 3, openIncidents: 0, failedChanges: 0, ongoingChanges: 0,
    })
    // 3*10 = 30
    expect(result.score).toBe(30)
    expect(result.level).toBe('medium')
  })

  it('cap blast radius a 40', () => {
    const result = calculateRiskScore({
      productionCIs: 0, blastRadiusCIs: 10, openIncidents: 0, failedChanges: 0, ongoingChanges: 0,
    })
    expect(result.score).toBe(40)
  })

  it('level thresholds corretti', () => {
    // 4*5=20 → low
    expect(calculateRiskScore({
      productionCIs: 0, blastRadiusCIs: 0, openIncidents: 0, failedChanges: 0, ongoingChanges: 4,
    }).level).toBe('low')

    // 1*20 + 2*5=10 = 30 → medium
    expect(calculateRiskScore({
      productionCIs: 1, blastRadiusCIs: 0, openIncidents: 0, failedChanges: 0, ongoingChanges: 2,
    }).level).toBe('medium')

    // 2*20=40 + 2*10=20 + 1*15=15 = 75 → high (< 76)
    expect(calculateRiskScore({
      productionCIs: 2, blastRadiusCIs: 2, openIncidents: 1, failedChanges: 0, ongoingChanges: 0,
    }).level).toBe('high')
  })

  it('details contengono le descrizioni dei fattori', () => {
    const result = calculateRiskScore({
      productionCIs: 1, blastRadiusCIs: 2, openIncidents: 1, failedChanges: 1, ongoingChanges: 1,
    })
    expect(result.details.some((d) => d.includes('production'))).toBe(true)
    expect(result.details.some((d) => d.includes('blast radius'))).toBe(true)
    expect(result.details.some((d) => d.includes('incident'))).toBe(true)
    expect(result.details.some((d) => d.includes('falliti'))).toBe(true)
    expect(result.details.some((d) => d.includes('in corso'))).toBe(true)
  })
})
