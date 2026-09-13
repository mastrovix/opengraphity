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
import { describe, it, expect, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { ConfigurationIssuesBanner } from './ConfigurationIssuesBanner'
import { renderWithProviders, userEvent } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'

/**
 * L'API manda FATTI, non frasi (13 set 2026). Questi mock portano quello che
 * porta l'API vera: una `kind`, che e la chiave, e i soli dati da interpolare.
 * La frase la compone il client — ed e il punto: in un browser in inglese il
 * banner era in italiano, perche la scriveva il server, che la lingua non la sa.
 */
interface Param { name: string; value: string }
interface Issue {
  kind: string; severity: string; params: Param[]
  gaps?: { kind: string; params: Param[] }[]
  where: string | null
}

const issuesMock = (configurationIssues: Issue[]) => ({
  request: { query: GET_CONFIGURATION_ISSUES },
  result: { data: { configurationIssues } },
})

/** Il caso reale di c-one: due stati aggiunti al vocabolario senza semantica. */
const SENZA_SEMANTICA: Issue = {
  kind: 'vocabulary_without_semantics',
  severity: 'warning',
  params: [{ name: 'statuses', value: 'expired, revoked' }, { name: 'count', value: '2' }],
  gaps: [],
  where: '/settings/event-policy',
}

/** Una voce la cui frase non porta enfasi, in nessuna lingua. */
const CHIAVI_RESIDUE: Issue = {
  kind: 'matrix_stale_keys',
  severity: 'warning',
  params: [{ name: 'matrix', value: 'priority' }, { name: 'count', value: '1' }],
  gaps: [],
  where: '/settings/domain-matrices',
}

afterEach(async () => { await i18n.changeLanguage('en') })

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
    expect(banner.textContent).toContain('in service')
    // E l'enfasi è vera enfasi, non testo normale.
    const forti = banner.querySelectorAll('strong')
    expect([...forti].map((e) => e.textContent)).toContain('in service')
  })

  it('il resto della frase NON è in grassetto (l\'enfasi dice quale metà conta)', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const banner = await screen.findByRole('status')
    const forti = [...banner.querySelectorAll('strong')].map((e) => e.textContent ?? '')
    expect(forti.some((f) => f.includes('expired'))).toBe(false)
  })

  it('una frase senza enfasi si rende intatta', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([CHIAVI_RESIDUE])],
    })
    expect(await screen.findByText('Matrix «priority»: 1 key left over from a rename.')).toBeInTheDocument()
  })

  /**
   * IL DIFETTO, quello vero: interfaccia inglese, banner italiano. L'API
   * componeva la frase e non sa in che lingua guarda chi legge. Questo test
   * mostra la stessa diagnosi — gli stessi byte dall'API — nelle due lingue.
   */
  it('la STESSA diagnosi si legge nella lingua dell\'interfaccia', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('in no list of the alarm policy')

    await i18n.changeLanguage('it')
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('in nessuna lista della policy degli allarmi')
    })
    // I DATI non cambiano: cambia la frase intorno.
    expect(screen.getByRole('status').textContent).toContain('expired, revoked')
  })

  it('il plurale segue il numero, che arriva come dato', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([CHIAVI_RESIDUE, { ...CHIAVI_RESIDUE, params: [{ name: 'matrix', value: 'severity' }, { name: 'count', value: '3' }] }])],
    })
    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('1 key left over')
    expect(banner.textContent).toContain('3 keys left over')
  })

  /**
   * Un'API più nuova del bundle: una `kind` che questo client non conosce. Non
   * si nasconde — si legge la chiave grezza, che e brutta ma dice la verita.
   * Mostrare niente sarebbe peggio: «C'e 1 cosa da sistemare» e sotto il vuoto.
   */
  it('una diagnosi che il client non conosce si legge grezza, non sparisce', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([{ kind: 'kind_del_futuro', severity: 'error', params: [{ name: 'x', value: '7' }], gaps: [], where: null }])],
    })
    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('configurationIssues.issue.kind_del_futuro')
    expect(banner.textContent).toContain('x=7')
  })

  /** I buchi sono un elenco di CHIAVI: le risolve il client, una per una. */
  it('i buchi di configurazione si leggono uno per uno, nella lingua giusta', async () => {
    renderWithProviders(<ConfigurationIssuesBanner />, {
      mocks: [meMock('admin'), issuesMock([{
        kind: 'provisioning_gap', severity: 'error', params: [{ name: 'count', value: '2' }],
        gaps: [
          { kind: 'no_teams', params: [] },
          { kind: 'no_workflows', params: [{ name: 'entityTypes', value: 'incident, change' }] },
        ],
        where: '/workflow',
      }])],
    })
    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('no teams')
    expect(banner.textContent).toContain('no active workflow for: incident, change')
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
