/**
 * Il banner della diagnostica (terza revisione).
 *
 * Non aveva test. Due difetti sono venuti fuori solo aprendo un browser vero:
 * l'enfasi `**…**` dei messaggi resa come asterischi, e il pulsante «Vai a
 * sistemare» che puntava a una rotta inesistente (quello lo pinna
 * `__tests__/configurationIssueRoutes.test.ts`, che risolve i `where` contro
 * `main.tsx`).
 *
 * Il primo non poteva essere preso da nessun test sul contenuto: il testo CON
 * gli asterischi è esattamente quello che un'asserzione ingenua si aspetta. Si
 * prende solo guardando la forma resa — `<strong>` — che è quello che fa questo
 * file.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ConfigurationIssuesBanner } from './ConfigurationIssuesBanner'
import { renderWithProviders, userEvent } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'

interface Issue { kind: string; severity: string; message: string; where: string | null }

const issuesMock = (configurationIssues: Issue[]) => ({
  request: { query: GET_CONFIGURATION_ISSUES },
  result: { data: { configurationIssues } },
})

/** Il caso reale di c-one, con l'enfasi che il messaggio porta davvero. */
const SENZA_SEMANTICA: Issue = {
  kind: 'vocabulary_without_semantics',
  severity: 'warning',
  message: 'Questi stati del ciclo di vita non sono in nessuna lista della policy degli allarmi: '
    + 'expired, revoked. Per il prodotto sono CI **in servizio**: i loro allarmi aprono incident.',
  where: '/settings/event-policy',
}

describe('ConfigurationIssuesBanner', () => {
  it('un admin con un problema vede il banner', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })

  it('L\'ENFASI si rende come grassetto, non come asterischi', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const banner = await screen.findByRole('status')
    // Questa è l'asserzione che il difetto violava.
    expect(banner.textContent).not.toContain('**')
    expect(banner.textContent).toContain('in servizio')
    // E l'enfasi è vera enfasi, non testo normale.
    const forti = banner.querySelectorAll('strong')
    expect([...forti].map((e) => e.textContent)).toContain('in servizio')
  })

  it('il resto della frase NON è in grassetto (l\'enfasi dice quale metà conta)', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const banner = await screen.findByRole('status')
    const forti = [...banner.querySelectorAll('strong')].map((e) => e.textContent ?? '')
    expect(forti.some((f) => f.includes('expired'))).toBe(false)
  })

  it('un messaggio senza enfasi si rende intatto', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([{ ...SENZA_SEMANTICA, message: 'Niente enfasi qui.' }])],
    })
    expect(await screen.findByText('Niente enfasi qui.')).toBeInTheDocument()
  })

  it('chi non è admin non lo vede: non è lui che può rimediare', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('operator'), issuesMock([SENZA_SEMANTICA])],
    })
    await waitFor(() => { expect(screen.queryByRole('status')).not.toBeInTheDocument() })
  })

  it('niente da sistemare → niente banner (un banner sempre acceso diventa invisibile)', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([])],
    })
    await waitFor(() => { expect(screen.queryByRole('status')).not.toBeInTheDocument() })
  })

  it('si può chiudere', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const banner = await screen.findByRole('status')
    await userEvent.click(screen.getByRole('button', { name: /Nascondi fino al prossimo caricamento|Hide until the next load/i }))
    expect(banner).not.toBeInTheDocument()
  })

  it('una voce senza `where` non offre il pulsante, invece di offrirne uno che non porta da nessuna parte', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([{ ...SENZA_SEMANTICA, where: null }])],
    })
    await screen.findByRole('status')
    expect(screen.queryByRole('button', { name: /Vai a sistemare|Go and fix it/i })).not.toBeInTheDocument()
  })
})
