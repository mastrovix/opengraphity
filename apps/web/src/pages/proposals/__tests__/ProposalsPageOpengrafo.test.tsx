/**
 * LA PAGINA CON I DATI VERI DI `opengrafo` (20 set 2026).
 *
 * Segnalazione del proprietario: «in opengrafo la pagina proposal va in
 * errore». Il backend regge — il resolver e il documento GraphQL intero,
 * eseguiti nel container contro lo schema di quel tenant, rispondono con 2
 * proposte — quindi la caduta è nel rendering, e la differenza fra i due
 * tenant è il DATO.
 *
 * Le due righe qui sotto sono copiate dal grafo, non inventate.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { GET_PROPOSALS } from '@/graphql/queries/proposals'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { ProposalsPage } from '../ProposalsPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const param = (name: string, value: string) => ({ __typename: 'ProposalParam', name, value })

const proposta = {
  __typename: 'Proposal',
  id: '7714dc83-8284-4685-9d5b-0e149c5eecb8',
  area: 'platform',
  kind: 'proposal.platformSharedFault',
  params: [
    param('service', 'opengrafo-api'),
    param('module', 'bullmq'),
    param('template', '[bullmq] queue connection error'),
    param('count', '234'),
    param('days', '1'),
  ],
  evidence: {
    __typename: 'ProposalEvidence',
    n: 234, windowDays: 1, hiddenRefs: 0, refs: [],
    extra: [
      param('fingerprint', '0e45270f148dc2fe36e71bd3c741790b'),
      param('lastDay', '2026-09-20'),
    ],
  },
  occurrences: 234,
  windowDays: 1,
  actionType: null,
  rationale: 'On 2026-09-20 all three processes logged BullMQ queue connection errors within the same single day.',
  rationaleLanguage: 'en',
  status: 'open',
  createdAt: '2026-09-20T18:50:00.000Z',
  decidedAt: null, decidedBy: null, decidedByName: null,
  rejectedKind: null, rejectedNote: null, notNowUntil: null,
  auditEntryId: null, executionError: null, undoable: false,
}

const risultato = {
  __typename: 'ProposalPage',
  total: 1, maxOpen: 5, lastRunAt: '2026-09-20T18:50:00.000Z', aiAvailable: true,
  counts: { __typename: 'ProposalCounts', open: 1, accepted: 0, rejected: 0, notNow: 0, expired: 0, superseded: 0 },
  items: [proposta],
}

const mocks = (): GqlMock[] => [{
  request: { query: GET_PROPOSALS, variables: { status: ['open', 'not_now'], limit: 50, offset: 0 } },
  result: { data: { proposals: risultato } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}]

describe('ProposalsPage con una proposta di PIATTAFORMA', () => {
  it('si disegna senza cadere: titolo, area, prove vuote e nessun bottone «accetta»', async () => {
    renderWithProviders(<ProposalsPage />, { mocks: mocks(), route: '/proposals', path: '/proposals' })
    // Il titolo della proposta, costruito dal `kind` + i `params`.
    expect(await screen.findByText(/fails together with other processes/)).toBeTruthy()
    // L'area di piattaforma ha la sua etichetta: niente chiave grezza a schermo.
    expect(screen.queryByText(/proposals\.area\./)).toBeNull()
    /*
     * `actionType: null` — sei generi su otto sono così. Non c'è niente da
     * eseguire, quindi non si offre un bottone che fallirebbe. È anche il
     * difetto aperto: chi è d'accordo non ha un modo per dirlo.
     */
    expect(screen.queryByRole('button', { name: /^Accetta$|^Accept$/ })).toBeNull()
  })
})
