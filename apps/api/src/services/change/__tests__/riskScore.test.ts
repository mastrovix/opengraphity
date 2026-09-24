/**
 * Assessment scoring (change process) — pure functions in ../scoring.ts.
 *
 * Complementare a src/lib/__tests__/riskScore.test.ts (che copre il risk
 * score "ambientale" calculateRiskScore): qui si testa il punteggio delle
 * AssessmentTask, il risk per-CI e nient'altro.
 *
 * Formula reale (assessmentMutations.completeAssessmentTask → calculateTaskScore):
 *   score = round( (Σ weight·score + ENV_WEIGHT·envScore)
 *                / (Σ weight·maxScore + ENV_WEIGHT·ENV_MAX) · 100 )
 * con ENV_WEIGHT = peso del cliente (`Tenant.change_environment_weight`, fabbrica 5), ENV_MAX = 3,
 * envScore = punteggio dell'ambiente dalla matrice `environment_risk` (0..3,
 * lib/environmentRisk.ts; seme: production 3, staging 1, gli altri 0).
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  calculateTaskScore,
  calculateCIRiskScore,
  ENV_MAX,
} from '../scoring.js'
import { FACTORY_ENVIRONMENT_WEIGHT as W } from '../../../lib/changeEnvironmentWeight.js'

describe('calculateTaskScore', () => {
  it('tutte le risposte al massimo + environment production (max) → 100', () => {
    const questions = [
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 3, score: 3, maxScore: 3 },
      { weight: 1, score: 2, maxScore: 2 },
    ]
    // num = den per ogni domanda e anche per il fattore ambiente (3 = ENV_MAX)
    expect(calculateTaskScore(questions, 3, W)).toBe(100)
  })

  it('tutte le risposte a 0 in ambiente non production/staging → 0', () => {
    const questions = [
      { weight: 5, score: 0, maxScore: 3 },
      { weight: 3, score: 0, maxScore: 3 },
    ]
    expect(calculateTaskScore(questions, 0, W)).toBe(0)
    expect(calculateTaskScore(questions, 0, W)).toBe(0)
  })

  it('mix calcolato a mano, env neutro: 2 domande w5 3/3 + 1 domanda w3 0/3 → 56', () => {
    // num = 5·3 + 5·3 + 3·0            = 30
    // den = 5·3 + 5·3 + 3·3            = 39
    // + fattore ambiente (sempre attivo): num += 5·0 = 0, den += 5·3 = 15
    // → 30 / 54 · 100 = 55.55… → round → 56
    // (senza il fattore ambiente sarebbe 30/39·100 ≈ 77: la formula reale
    //  include SEMPRE il pool ambiente, quindi l'atteso è 56)
    const questions = [
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 3, score: 0, maxScore: 3 },
    ]
    expect(calculateTaskScore(questions, 0, W)).toBe(56)
  })

  it('bonus environment: stesse risposte, production > staging > altro', () => {
    const questions = [
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 3, score: 0, maxScore: 3 },
    ]
    // den = 39 + 15 = 54 sempre; num = 30 + 5·envScore
    expect(calculateTaskScore(questions, 3, W)).toBe(83) // 45/54 → 83.33 → 83
    expect(calculateTaskScore(questions, 1, W)).toBe(65)    // 35/54 → 64.81 → 65
    expect(calculateTaskScore(questions, 0, W)).toBe(56) // 30/54 → 55.55 → 56
  })

  it('arrotonda a intero (half-up di Math.round)', () => {
    // den = 5·5 + 15 = 40; num = 5·1 = 5 → 5/40·100 = 12.5 → 13
    expect(calculateTaskScore([{ weight: 5, score: 1, maxScore: 5 }], 0, W)).toBe(13)
    expect(Number.isInteger(calculateTaskScore([{ weight: 5, score: 2, maxScore: 5 }], 1, W))).toBe(true)
  })

  it('nessuna domanda → ValidationError (BAD_USER_INPUT), mai NaN', () => {
    // Il resolver rifiuta già i task senza domande; la funzione pura difende
    // il contratto lanciando invece di produrre un punteggio privo di senso.
    let error: unknown = null
    try { calculateTaskScore([], 3, W) } catch (e) { error = e }
    expect(error).toBeInstanceOf(GraphQLError)
    expect((error as GraphQLError).message).toContain('No assessment question')
    expect((error as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  })

  it('domande tutte con maxScore 0: il pool ambiente evita la divisione per zero', () => {
    // den = 0 + ENV_WEIGHT·ENV_MAX = 15 → mai NaN
    const score = calculateTaskScore([{ weight: 5, score: 0, maxScore: 0 }], 3, W)
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(100) // 15/15
  })
})

describe('fattore ambiente', () => {
  it('peso di fabbrica e massimo della scala', () => {
    expect(W).toBe(5)
    expect(ENV_MAX).toBe(3)
  })

  /** Giro nel browser del 14 set 2026 (#32): col peso 5 cablato, risposte migliori in produzione → 89. */
  it('il peso è del cliente: con peso 1 le risposte migliori in produzione non sono più rischio alto', () => {
    const best = [{ weight: 1, score: 0, maxScore: 3 }]
    expect(calculateTaskScore(best, 3, 5)).toBe(83)
    expect(calculateTaskScore(best, 3, 1)).toBe(50)
    expect(calculateTaskScore(best, 3, 0)).toBe(0)
  })

  it('peso 0 e nessuna opzione con punteggio: errore detto, mai NaN', () => {
    expect(() => calculateTaskScore([{ weight: 1, score: 0, maxScore: 0 }], 3, 0)).toThrow(/nothing to score/)
  })

  it('un punteggio ambiente fuori scala è un errore, non un numero accettato', () => {
    expect(() => calculateTaskScore([{ weight: 1, score: 1, maxScore: 1 }], 4, W)).toThrow()
    expect(() => calculateTaskScore([{ weight: 1, score: 1, maxScore: 1 }], -1, W)).toThrow()
  })
})

describe('calculateCIRiskScore', () => {
  it('media aritmetica dei punteggi owner e support', () => {
    expect(calculateCIRiskScore(80, 60)).toBe(70)
    expect(calculateCIRiskScore(0, 0)).toBe(0)
    expect(calculateCIRiskScore(100, 100)).toBe(100)
  })

  it('arrotonda a intero: (77 + 56) / 2 = 66.5 → 67', () => {
    expect(calculateCIRiskScore(77, 56)).toBe(67)
  })
})
