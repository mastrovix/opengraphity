/**
 * QueueStatsPage (revisione 2, D2.2 lato interfaccia): le code arrivano dal
 * server con `group` e `retryable`; la pagina le raggruppa per sottosistema
 * con intestazioni tradotte, mostra il rigioco solo dove `retryable` è vero e
 * spiega in una riga che le code dei consumer non si rigiocano. Nessun nome di
 * coda è scritto nel web: qui i nomi sono dati di prova.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { QueueStatsPage, groupQueues } from './QueueStatsPage'
import { GET_QUEUE_STATS, GET_QUEUE_JOBS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const counts = (over: Partial<Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused', number>> = {}) => ({
  __typename: 'QueueJobCounts', waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0, ...over,
})

const QUEUES = [
  { __typename: 'QueueStat', name: 'workflow-jobs',            group: 'itsm',     retryable: true,  counts: counts({ failed: 1 }) },
  { __typename: 'QueueStat', name: 'events-ingest',            group: 'events',   retryable: true,  counts: counts({ failed: 2 }) },
  { __typename: 'QueueStat', name: 'service-impact-consumer',  group: 'services', retryable: false, counts: counts({ failed: 1 }) },
  { __typename: 'QueueStat', name: 'notification-service',     group: 'platform', retryable: false, counts: counts() },
  { __typename: 'QueueStat', name: 'events-correlate',         group: 'events',   retryable: true,  counts: counts() },
]

const statsMock: GqlMock = {
  request: { query: GET_QUEUE_STATS },
  result: { data: { queueStats: QUEUES } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function jobsMock(queueName: string): GqlMock {
  return {
    request: { query: GET_QUEUE_JOBS, variables: (v) => (v as { queueName: string }).queueName === queueName },
    result: { data: { queueJobs: [{
      __typename: 'QueueJob', id: `job-${queueName}`, name: 'job', queueName, status: 'failed', data: '{}',
      timestamp: '2026-09-11T08:00:00Z', processedOn: null, finishedOn: null, failedReason: 'boom', stacktrace: [],
      attemptsMade: 3, maxAttempts: 3, returnValue: null,
    }] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

describe('groupQueues', () => {
  it('ordina i gruppi allarmi → servizi → ITSM → piattaforma, un gruppo nuovo dichiarato dal server va in coda col suo nome', () => {
    const groups = groupQueues([...QUEUES, { name: 'x', group: 'zeta', retryable: false, counts: counts() }, { name: 'y', group: 'alpha', retryable: false, counts: counts() }])
    expect(groups.map((g) => g.group)).toEqual(['events', 'services', 'itsm', 'platform', 'alpha', 'zeta'])
    expect(groups[0]!.queues.map((q) => q.name)).toEqual(['events-ingest', 'events-correlate'])
  })
})

describe('QueueStatsPage', () => {
  it('raggruppa le code per sottosistema con intestazioni tradotte e conteggio', async () => {
    renderWithProviders(<QueueStatsPage />, { mocks: [statsMock] })
    expect(await screen.findByText('events-ingest')).toBeInTheDocument()

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Alarms2 queues', 'Services1 queue', 'ITSM1 queue', 'Platform1 queue'])
    expect(screen.getByText('5 queues')).toBeInTheDocument()

    // ogni coda sta nella sezione del suo gruppo
    const services = screen.getByRole('region', { name: /Services/ })
    expect(within(services).getByText('service-impact-consumer')).toBeInTheDocument()
    expect(within(services).queryByText('events-ingest')).not.toBeInTheDocument()

    // la riga che spiega che le code dei consumer non si rigiocano
    expect(screen.getByText(/Domain consumer queues .* cannot be retried from the UI/)).toBeInTheDocument()
  })

  it('coda rigiocabile: un job fallito ha il pulsante Retry; coda non rigiocabile: etichetta e nessun pulsante', async () => {
    const { user } = renderWithProviders(<QueueStatsPage />, { mocks: [statsMock, jobsMock('events-ingest'), jobsMock('service-impact-consumer')] })
    await screen.findByText('events-ingest')

    // le code non rigiocabili sono marcate già nell'intestazione
    expect(screen.getAllByText('Not retryable from the UI')).toHaveLength(2)

    // rigiocabile → Retry
    await user.click(screen.getByRole('button', { name: /events-ingest/ }))
    await user.click(await screen.findByRole('button', { name: /job-events-ingest/ }))
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()

    // non rigiocabile → nessun Retry, etichetta nel dettaglio
    await user.click(screen.getByRole('button', { name: /service-impact-consumer/ }))
    await user.click(await screen.findByRole('button', { name: /job-service-impact-consumer/ }))
    const details = screen.getAllByText('boom').map((el) => el.closest('div'))
    expect(details.length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)   // solo quello di events-ingest
    expect(screen.getAllByText('Not retryable from the UI').length).toBeGreaterThan(2)
  })
})
