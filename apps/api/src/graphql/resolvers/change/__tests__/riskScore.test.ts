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
 * dove il fattore ambiente è SEMPRE nel pool: ENV_WEIGHT = 5, ENV_MAX = 3,
 * envScore = 3 (production) / 1 (staging) / 0 (altro).
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  calculateTaskScore,
  calculateCIRiskScore,
  environmentScore,
  ENV_WEIGHT,
  ENV_MAX,
} from '../scoring.js'

describe('calculateTaskScore', () => {
  it('tutte le risposte al massimo + environment production (max) → 100', () => {
    const questions = [
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 3, score: 3, maxScore: 3 },
      { weight: 1, score: 2, maxScore: 2 },
    ]
    // num = den per ogni domanda e anche per il fattore ambiente (3 = ENV_MAX)
    expect(calculateTaskScore(questions, 'production')).toBe(100)
  })

  it('tutte le risposte a 0 in ambiente non production/staging → 0', () => {
    const questions = [
      { weight: 5, score: 0, maxScore: 3 },
      { weight: 3, score: 0, maxScore: 3 },
    ]
    expect(calculateTaskScore(questions, 'development')).toBe(0)
    expect(calculateTaskScore(questions, null)).toBe(0)
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
    expect(calculateTaskScore(questions, null)).toBe(56)
  })

  it('bonus environment: stesse risposte, production > staging > altro', () => {
    const questions = [
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 5, score: 3, maxScore: 3 },
      { weight: 3, score: 0, maxScore: 3 },
    ]
    // den = 39 + 15 = 54 sempre; num = 30 + 5·envScore
    expect(calculateTaskScore(questions, 'production')).toBe(83) // 45/54 → 83.33 → 83
    expect(calculateTaskScore(questions, 'staging')).toBe(65)    // 35/54 → 64.81 → 65
    expect(calculateTaskScore(questions, 'development')).toBe(56) // 30/54 → 55.55 → 56
  })

  it('arrotonda a intero (half-up di Math.round)', () => {
    // den = 5·5 + 15 = 40; num = 5·1 = 5 → 5/40·100 = 12.5 → 13
    expect(calculateTaskScore([{ weight: 5, score: 1, maxScore: 5 }], null)).toBe(13)
    expect(Number.isInteger(calculateTaskScore([{ weight: 5, score: 2, maxScore: 5 }], 'staging'))).toBe(true)
  })

  it('nessuna domanda → ValidationError (BAD_USER_INPUT), mai NaN', () => {
    // Il resolver rifiuta già i task senza domande; la funzione pura difende
    // il contratto lanciando invece di produrre un punteggio privo di senso.
    let error: unknown = null
    try { calculateTaskScore([], 'production') } catch (e) { error = e }
    expect(error).toBeInstanceOf(GraphQLError)
    expect((error as GraphQLError).message).toContain('Nessuna domanda di assessment')
    expect((error as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  })

  it('domande tutte con maxScore 0: il pool ambiente evita la divisione per zero', () => {
    // den = 0 + ENV_WEIGHT·ENV_MAX = 15 → mai NaN
    const score = calculateTaskScore([{ weight: 5, score: 0, maxScore: 0 }], 'production')
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(100) // 15/15
  })
})

describe('environmentScore', () => {
  it('production → 3 (max), staging → 1, altro/null → 0', () => {
    expect(environmentScore('production')).toBe(3)
    expect(environmentScore('staging')).toBe(1)
    expect(environmentScore('development')).toBe(0)
    expect(environmentScore(null)).toBe(0)
    expect(environmentScore(undefined)).toBe(0)
    expect(ENV_WEIGHT).toBe(5)
    expect(ENV_MAX).toBe(3)
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
