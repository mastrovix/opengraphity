/**
 * Il punteggio dell'analisi d'impatto (ondata 5 di «Nulla cablato»): i pesi sono
 * quelli del cliente, il punteggio si ferma a 100 e il livello non si decide
 * qui (è la fascia di rischio del cliente, in impact.ts).
 */
import { describe, it, expect } from 'vitest'
import { calculateRiskScore } from '../riskScore.js'
import { FACTORY_IMPACT_WEIGHTS as F, assertImpactWeights } from '../impactWeights.js'

const none = { productionCIs: 0, blastRadiusCIs: 0, openIncidents: 0, failedChanges: 0, ongoingChanges: 0 }

describe('calculateRiskScore', () => {
  it('con i pesi di fabbrica dà i punteggi di prima', () => {
    expect(calculateRiskScore(none, F)).toEqual({ score: 0, details: [] })
    // 1*20 + 2*5 = 30
    expect(calculateRiskScore({ ...none, productionCIs: 1, ongoingChanges: 2 }, F).score).toBe(30)
    // 2*20 + 2*10 + 1*15 = 75
    expect(calculateRiskScore({ ...none, productionCIs: 2, blastRadiusCIs: 2, openIncidents: 1 }, F).score).toBe(75)
    // blast radius fermo al suo massimo
    expect(calculateRiskScore({ ...none, blastRadiusCIs: 10 }, F).score).toBe(40)
  })

  it('i pesi del cliente comandano: zero toglie un fattore, il massimo del blast radius è suo', () => {
    const w = { ...F, productionCI: 0, blastRadiusCI: 7, blastRadiusCap: 14, openIncident: 1 }
    const r = calculateRiskScore({ ...none, productionCIs: 3, blastRadiusCIs: 5, openIncidents: 4 }, w)
    expect(r.score).toBe(14 + 4)
    expect(r.details.some((d) => d.includes('highest-risk environment'))).toBe(false)
  })

  it('il punteggio si ferma a 100: le fasce di rischio non vanno oltre', () => {
    // 3*20 + 40 + 2*15 + 10 = 140 prima; ora 100
    expect(calculateRiskScore({ productionCIs: 3, blastRadiusCIs: 5, openIncidents: 2, failedChanges: 1, ongoingChanges: 0 }, F).score).toBe(100)
  })

  it('i dettagli nominano ogni fattore che ha pesato', () => {
    const r = calculateRiskScore({ productionCIs: 1, blastRadiusCIs: 2, openIncidents: 1, failedChanges: 1, ongoingChanges: 1 }, F)
    for (const part of ['highest-risk environment', 'blast radius', 'open incidents', 'failed changes', 'ongoing changes']) {
      expect(r.details.some((d) => d.includes(part))).toBe(true)
    }
  })
})

describe('assertImpactWeights', () => {
  it('accetta i pesi di fabbrica e rifiuta chiavi mancanti, in più o fuori intervallo', () => {
    expect(assertImpactWeights({ ...F }, 'x')).toEqual(F)
    const { openIncident: _o, ...missing } = F
    expect(() => assertImpactWeights(missing, 'x')).toThrow(/openIncident/)
    expect(() => assertImpactWeights({ ...F, surprise: 1 }, 'x')).toThrow(/surprise/)
    expect(() => assertImpactWeights({ ...F, productionCI: 101 }, 'x')).toThrow(/productionCI/)
    expect(() => assertImpactWeights({ ...F, ongoingChange: 1.5 }, 'x')).toThrow(/ongoingChange/)
    expect(() => assertImpactWeights({ ...F, recentChangesDays: 0 }, 'x')).toThrow(/recentChangesDays/)
  })
})
