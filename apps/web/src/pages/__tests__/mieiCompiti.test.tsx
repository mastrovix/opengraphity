/**
 * «I MIEI COMPITI» NON È PIÙ SOLO DELLE CHANGE (20 set 2026, ondata 3).
 *
 * La pagina nasceva sui cinque compiti delle change e si vedeva: ogni riga
 * mostrava «CI: …» e il numero della change, e il tipo di compito passava da
 * due mappe che **lanciano** su un valore sconosciuto (`lookupOrError`). Con
 * i compiti generici — che stanno su incident, problem e richieste, e non
 * hanno un CI — quelle assunzioni diventano difetti visibili.
 *
 * Questi test tengono le tre cose che cambiano davvero per chi guarda: la
 * riga porta al ticket giusto, il CI non si inventa quando non c'è, e il
 * titolo scritto nel disegnatore è quello che si legge.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { MyTasksPage } from '../MyTasksPage'
import { renderWithProviders } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_MY_TASKS } from '@/graphql/queries'

interface Riga {
  id: string; code: string; kind: string; role: string; action: string; status: string
  entityType: string; entityId: string; entityNumber: string
  ciId: string | null; ciName: string | null; phase: string; createdAt: string
}

const compitoGenerico = (over: Partial<Riga> = {}): Riga => ({
  id: 'k-1', code: 'TASK00000042', kind: 'task', role: '', action: 'Prepara la macchina',
  status: 'open', entityType: 'service_request', entityId: 'sr-1', entityNumber: 'RICH-000021',
  ciId: null, ciName: null, phase: 'in_progress', createdAt: '2026-09-20T10:00:00Z', ...over,
})

const compitoDiChange = (over: Partial<Riga> = {}): Riga => ({
  id: 'a-1', code: 'TASK00000007', kind: 'assessment', role: 'owner', action: 'Fill in the Functional assessment',
  status: 'pending', entityType: 'change', entityId: 'chg-1', entityNumber: 'CHG00000012',
  ciId: 'ci-1', ciName: 'DB portale clienti', phase: 'assessment', createdAt: '2026-09-19T10:00:00Z', ...over,
})

const tasksMock = (assignedToMe: Riga[], unassigned: Riga[] = []) => ({
  request: { query: GET_MY_TASKS },
  result: { data: { myTasks: { assignedToMe, unassigned } } },
})

describe('I miei compiti', () => {
  it('un compito generico porta alla pagina del suo TICKET, non a una pagina di compito che non esiste', async () => {
    renderWithProviders(<MyTasksPage />, { mocks: [meMock('admin'), tasksMock([compitoGenerico()])] })
    const righe = await screen.findAllByRole('link', { name: /Prepara la macchina|Compiti/ })
    expect(righe.some((a) => a.getAttribute('href') === '/requests/sr-1')).toBe(true)
  })

  it('ogni tipo di ticket ha la sua strada', async () => {
    renderWithProviders(<MyTasksPage />, {
      mocks: [meMock('admin'), tasksMock([
        compitoGenerico({ id: 'k-1', entityType: 'incident', entityId: 'i-1', entityNumber: 'INC00000026' }),
        compitoGenerico({ id: 'k-2', entityType: 'problem',  entityId: 'p-1', entityNumber: 'PRB00000003' }),
      ])],
    })
    await screen.findByText('INC00000026')
    const href = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(href).toContain('/incidents/i-1')
    expect(href).toContain('/problems/p-1')
  })

  /**
   * Il difetto che si sarebbe visto: «CI: —» su ogni compito di una
   * richiesta. Un CI che non c'entra non è un dato mancante.
   */
  it('senza CI non si scrive «CI:»', async () => {
    renderWithProviders(<MyTasksPage />, { mocks: [meMock('admin'), tasksMock([compitoGenerico()])] })
    await screen.findByText('RICH-000021')
    expect(screen.queryByText(/CI:/)).not.toBeInTheDocument()
  })

  it('il compito di una change continua a mostrare il suo CI', async () => {
    renderWithProviders(<MyTasksPage />, { mocks: [meMock('admin'), tasksMock([compitoDiChange()])] })
    expect(await screen.findByText('DB portale clienti')).toBeInTheDocument()
    expect(screen.getByText('CHG00000012')).toBeInTheDocument()
  })

  it('si legge il TITOLO scritto nel disegnatore, non una frase del prodotto', async () => {
    renderWithProviders(<MyTasksPage />, { mocks: [meMock('admin'), tasksMock([compitoGenerico({ action: 'Crea l’utenza' })])] })
    expect(await screen.findByText('Crea l’utenza')).toBeInTheDocument()
  })

  /**
   * `KIND_COLOR` e `STATE_COLOR` passano da `lookupOrError`, che LANCIA su un
   * valore sconosciuto: senza le voci per `task`/`open` la pagina sarebbe
   * esplosa alla prima riga generica.
   */
  it('il tipo e lo stato nuovi non fanno esplodere la pagina', async () => {
    renderWithProviders(<MyTasksPage />, { mocks: [meMock('admin'), tasksMock([compitoGenerico()])] })
    expect(await screen.findByText('TASK00000042')).toBeInTheDocument()
  })
})
