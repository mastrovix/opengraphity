/**
 * Gate di approvazione multi-parte (approvalCreation.ts):
 *   - stato del gate (totale / pendenti / presenza del Change Manager)
 *   - assertAllApprovalsSatisfied: fail-loud su requisiti assenti, CM mancante,
 *     requisiti pendenti; standard sempre passa
 *   - createChangeApprovals: standard → nessun record; senza team CM → CONFLICT
 *     (mai un gate parziale); con team CM → un'unica statement riconciliante
 *
 * I test pinnano il contratto "fail-open vietato": nessun ramo può lasciar
 * avanzare una change senza il Change Manager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('../../ci-utils.js', () => ({
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))
/**
 * I tipi pre-approvati sono dato del cliente (ondata 8): questo test misura il
 * GATE, non la policy, quindi la policy è un doppio pilotabile. Il suo
 * comportamento vero è in `lib/__tests__/changePolicy.test.ts`.
 */
let preApproved: string[] = ['standard']
vi.mock('../../../../lib/changePolicy.js', () => ({
  isPreApprovedChangeType: (_t: string, type: unknown) => Promise.resolve(typeof type === 'string' && preApproved.includes(type)),
  preApprovedChangeTypes:  () => Promise.resolve(preApproved),
}))

vi.mock('../../../../lib/logger.js', () => ({
  // `child` serve ai moduli che si prendono un logger di modulo (domainMatrix,
  // changePolicy): senza, l'import del gate fallisce prima dei test.
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

import { runQuery, runQueryOne } from '../../ci-utils.js'
import {
  getApprovalGateState,
  assertAllApprovalsSatisfied,
  areAllApprovalsSatisfied,
  createChangeApprovals,
} from '../approvalCreation.js'

const session = {} as Parameters<typeof runQuery>[0]
const mockedOne = vi.mocked(runQueryOne)
const mockedMany = vi.mocked(runQuery)

function gateRow(over: Partial<{ changeType: string | null; total: number; pending: number; cm: number }> = {}) {
  return { changeType: 'normal', total: 2, pending: 0, cm: 1, ...over }
}

async function expectCode(p: Promise<unknown>, code: string, msgPart?: string) {
  let caught: unknown
  try { await p } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(GraphQLError)
  expect((caught as GraphQLError).extensions['code']).toBe(code)
  if (msgPart) expect((caught as GraphQLError).message).toContain(msgPart)
}

beforeEach(() => {
  mockedOne.mockReset()
  mockedMany.mockReset()
})

describe('getApprovalGateState', () => {
  it('normalizza i contatori Neo4j e il tipo assente → normal', async () => {
    mockedOne.mockResolvedValueOnce({ changeType: null, total: 3, pending: 1, cm: 1 })
    const s = await getApprovalGateState(session, 'chg', 't1')
    expect(s).toEqual({ changeType: 'normal', total: 3, pending: 1, hasChangeManager: true })
  })
  it('NOT_FOUND se la change non esiste', async () => {
    mockedOne.mockResolvedValueOnce(null)
    await expectCode(getApprovalGateState(session, 'chg', 't1'), 'NOT_FOUND')
  })
})

describe('assertAllApprovalsSatisfied (gate condiviso da approve + executeChangeTransition)', () => {
  it('il tipo pre-approvato viene dalla LISTA del cliente, non dal letterale «standard»', async () => {
    // Ondata 8: un cliente che rinomina `standard` in `preautorizzata` deve
    // continuare ad avere quelle change pre-approvate. Prima il codice
    // confrontava il nome, e la pre-approvazione si spegneva in silenzio.
    preApproved = ['preautorizzata']
    mockedOne.mockResolvedValueOnce(gateRow({ changeType: 'preautorizzata', total: 0, pending: 0, cm: 0 }))
    await expect(assertAllApprovalsSatisfied(session, 'chg', 't1')).resolves.toBeUndefined()
    // e il letterale, che ora NON è nella lista, non passa più
    mockedOne.mockResolvedValueOnce(gateRow({ changeType: 'standard', total: 0, pending: 0, cm: 0 }))
    await expect(assertAllApprovalsSatisfied(session, 'chg', 't1')).rejects.toThrow(/Requisiti di approvazione non ancora creati/)
    preApproved = ['standard']
  })

  it('standard: passa sempre, anche senza record', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ changeType: 'standard', total: 0, cm: 0 }))
    await expect(assertAllApprovalsSatisfied(session, 'chg', 't1')).resolves.toBeUndefined()
  })
  it('CONFLICT se non esistono requisiti', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ total: 0, pending: 0, cm: 0 }))
    await expectCode(assertAllApprovalsSatisfied(session, 'chg', 't1'), 'CONFLICT', 'non ancora creati')
  })
  it('CONFLICT se manca il requisito del Change Manager anche con gli owner group approvati', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ total: 2, pending: 0, cm: 0 }))
    await expectCode(assertAllApprovalsSatisfied(session, 'chg', 't1'), 'CONFLICT', 'Change Manager')
  })
  it('CONFLICT con requisiti pendenti (conteggio nel messaggio)', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ total: 3, pending: 2 }))
    await expectCode(assertAllApprovalsSatisfied(session, 'chg', 't1'), 'CONFLICT', '2 requisiti')
  })
  it('passa quando tutti approvati e CM presente', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ total: 3, pending: 0, cm: 1 }))
    await expect(assertAllApprovalsSatisfied(session, 'chg', 't1')).resolves.toBeUndefined()
  })
})

describe('areAllApprovalsSatisfied (auto-advance)', () => {
  it('false senza CM, true con tutto approvato, true per standard', async () => {
    mockedOne.mockResolvedValueOnce(gateRow({ cm: 0 }))
    expect(await areAllApprovalsSatisfied(session, 'chg', 't1')).toBe(false)
    mockedOne.mockResolvedValueOnce(gateRow({ pending: 0, cm: 1 }))
    expect(await areAllApprovalsSatisfied(session, 'chg', 't1')).toBe(true)
    mockedOne.mockResolvedValueOnce(gateRow({ changeType: 'standard', total: 0, cm: 0 }))
    expect(await areAllApprovalsSatisfied(session, 'chg', 't1')).toBe(true)
  })
})

describe('createChangeApprovals', () => {
  it('standard: nessuna scrittura', async () => {
    mockedOne.mockResolvedValueOnce({ changeType: 'standard' })
    await createChangeApprovals(session, 'chg', 't1')
    expect(mockedMany).not.toHaveBeenCalled()
  })
  it('senza team Change Manager → CONFLICT e nessuna scrittura (niente gate parziale)', async () => {
    mockedOne
      .mockResolvedValueOnce({ changeType: 'normal' }) // change
      .mockResolvedValueOnce(null)                     // nessun team CM
    await expectCode(createChangeApprovals(session, 'chg', 't1'), 'CONFLICT', 'Change Manager')
    expect(mockedMany).not.toHaveBeenCalled()
  })
  it('con team CM: un\'unica statement che azzera e ricrea (riconciliazione)', async () => {
    mockedOne
      .mockResolvedValueOnce({ changeType: 'normal' })
      .mockResolvedValueOnce({ id: 'team-cm' })
    mockedMany.mockResolvedValueOnce([])
    await createChangeApprovals(session, 'chg', 't1')
    expect(mockedMany).toHaveBeenCalledTimes(1)
    const [, cypher, params] = mockedMany.mock.calls[0]!
    expect(cypher).toContain('DETACH DELETE old')
    expect(cypher).toContain("kind: 'change_manager'")
    expect(cypher).toContain("kind: 'owner_group'")
    expect(params).toMatchObject({ changeId: 'chg', tenantId: 't1', cmTeamId: 'team-cm' })
  })
})
