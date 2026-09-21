/**
 * Revisione del 14 set 2026 · CH-3: il fattore ambiente dell'assessment
 * confrontava l'ambiente del CI con due letterali (`production` → 3,
 * `staging` → 1, tutto il resto 0). Un cliente con ambienti rinominati o
 * aggiunti nel Dizionario otteneva il punteggio minimo per tutti, senza un
 * errore. Ora è la matrice di dominio `environment_risk` (ambiente → punteggio
 * 0..3), seminata con i valori di prima e modificabile dalla pagina.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, close: vi.fn(async () => {}) }) }))
vi.mock('../enumScope.js', () => ({ loadTenantEnumOverrides: vi.fn(async () => new Map()) }))

const { environmentRiskScore, ENV_RISK_SCALE } = await import('../environmentRisk.js')
const { invalidateDomainMatrix, DOMAIN_MATRIX_KINDS, DOMAIN_MATRIX_SEEDS } = await import('../domainMatrix.js')
const { ValidationError } = await import('../errors.js')

const matrix = (entries: Record<string, string> | null) => {
  executeRead.mockReset()
  executeRead.mockResolvedValue({
    records: entries === null ? [] : [{ get: (k: string) => (k === 'entries' ? JSON.stringify(entries) : '2026-09-14T00:00:00Z') }],
  })
}

describe('environmentRiskScore', () => {
  beforeEach(() => { invalidateDomainMatrix('t1') })

  it('il seme è il comportamento di prima: production 3, staging 1, gli altri 0', async () => {
    matrix(null)
    expect(await environmentRiskScore('t1', 'production')).toBe(3)
    expect(await environmentRiskScore('t1', 'staging')).toBe(1)
    expect(await environmentRiskScore('t1', 'development')).toBe(0)
    expect(await environmentRiskScore('t1', 'testing')).toBe(0)
    expect(await environmentRiskScore('t1', 'dr')).toBe(0)
  })

  it('un ambiente rinominato o aggiunto dal cliente vale quanto dice la sua matrice', async () => {
    matrix({ prod: '3', collaudo: '2', sviluppo: '0' })
    expect(await environmentRiskScore('t1', 'prod')).toBe(3)
    expect(await environmentRiskScore('t1', 'collaudo')).toBe(2)
  })

  it('un ambiente che la matrice non conosce è un errore che lo nomina, non uno 0', async () => {
    matrix({ production: '3' })
    const err = await environmentRiskScore('t1', 'preprod').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(String((err as Error).message)).toContain('preprod')
  })

  it('una cella fuori scala è un errore', async () => {
    matrix({ production: '7' })
    await expect(environmentRiskScore('t1', 'production')).rejects.toThrow(/environment_risk/)
  })

  it('CI senza ambiente dichiarato → nessun contributo (0), come prima', async () => {
    matrix(null)
    expect(await environmentRiskScore('t1', null)).toBe(0)
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('la matrice è dichiarata con la scala 0..3 e un seme per ogni ambiente di fabbrica', () => {
    const spec = DOMAIN_MATRIX_KINDS.environment_risk
    expect(spec.inputs).toEqual(['environment'])
    expect(spec.scale).toEqual(ENV_RISK_SCALE)
    expect(Object.keys(DOMAIN_MATRIX_SEEDS.environment_risk).sort()).toEqual(['development', 'dr', 'production', 'staging', 'testing'])
  })
})
