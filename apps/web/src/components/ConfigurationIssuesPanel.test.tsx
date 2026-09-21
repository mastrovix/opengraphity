/**
 * Il pannello della diagnostica (terza revisione; dal 20 set 2026 è il corpo
 * della pagina Configurazione ▸ Diagnostica, e non più un banner su ogni
 * pagina).
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
import { ConfigurationIssuesPanel } from './ConfigurationIssuesPanel'
import { renderWithProviders } from '@/test/utils'
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

describe('ConfigurationIssuesPanel', () => {
  it('un admin con un problema vede i rilievi', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    expect(await screen.findByRole('region')).toBeInTheDocument()
  })

  it('L\'ENFASI si rende come grassetto, non come asterischi', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const pannello = await screen.findByRole('region')
    // Questa è l'asserzione che il difetto violava.
    expect(pannello.textContent).not.toContain('**')
    expect(pannello.textContent).toContain('in service')
    // E l'enfasi è vera enfasi, non testo normale.
    const forti = pannello.querySelectorAll('strong')
    expect([...forti].map((e) => e.textContent)).toContain('in service')
  })

  it('il resto della frase NON è in grassetto (l\'enfasi dice quale metà conta)', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const pannello = await screen.findByRole('region')
    const forti = [...pannello.querySelectorAll('strong')].map((e) => e.textContent ?? '')
    expect(forti.some((f) => f.includes('expired'))).toBe(false)
  })

  it('una frase senza enfasi si rende intatta', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
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
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([SENZA_SEMANTICA])],
    })
    const pannello = await screen.findByRole('region')
    expect(pannello.textContent).toContain('in no list of the alarm policy')

    await i18n.changeLanguage('it')
    await waitFor(() => {
      expect(screen.getByRole('region').textContent).toContain('in nessuna lista della policy degli allarmi')
    })
    // I DATI non cambiano: cambia la frase intorno.
    expect(screen.getByRole('region').textContent).toContain('expired, revoked')
  })

  it('il plurale segue il numero, che arriva come dato', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([CHIAVI_RESIDUE, { ...CHIAVI_RESIDUE, params: [{ name: 'matrix', value: 'severity' }, { name: 'count', value: '3' }] }])],
    })
    const pannello = await screen.findByRole('region')
    expect(pannello.textContent).toContain('1 key left over')
    expect(pannello.textContent).toContain('3 keys left over')
  })

  /**
   * «(e altri N)» solo se N > 0. Visto nel browser: 3 team senza interno/esterno,
   * tutti e 3 in elenco, e la frase diceva «(and 0 more)».
   */
  it('team senza interno/esterno: «e altri N» compare solo quando ce ne sono altri', async () => {
    const voce = (count: string, teams: string, others: string): Issue => ({
      kind: 'teams_without_sourcing', severity: 'warning', where: '/teams', gaps: [],
      params: [{ name: 'count', value: count }, { name: 'teams', value: teams }, { name: 'others', value: others }],
    })
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([voce('3', 'Rete, Server, Desk', '0'), voce('12', 'Alfa, Beta', '10')])],
    })
    const pannello = await screen.findByRole('region')
    expect(pannello.textContent).toContain('Rete, Server, Desk.')
    expect(pannello.textContent).not.toContain('(and 0 more)')
    expect(pannello.textContent).toContain('Alfa, Beta (and 10 more)')
  })

  /**
   * Un'API più nuova del bundle: una `kind` che questo client non conosce. Non
   * si nasconde — si legge la chiave grezza, che e brutta ma dice la verita.
   * Mostrare niente sarebbe peggio: «C'e 1 cosa da sistemare» e sotto il vuoto.
   */
  it('una diagnosi che il client non conosce si legge grezza, non sparisce', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([{ kind: 'kind_del_futuro', severity: 'error', params: [{ name: 'x', value: '7' }], gaps: [], where: null }])],
    })
    const pannello = await screen.findByRole('region')
    expect(pannello.textContent).toContain('configurationIssues.issue.kind_del_futuro')
    expect(pannello.textContent).toContain('x=7')
  })

  /** I buchi sono un elenco di CHIAVI: le risolve il client, una per una. */
  it('i buchi di configurazione si leggono uno per uno, nella lingua giusta', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([{
        kind: 'provisioning_gap', severity: 'error', params: [{ name: 'count', value: '2' }],
        gaps: [
          { kind: 'no_teams', params: [] },
          { kind: 'no_workflows', params: [{ name: 'entityTypes', value: 'incident, change' }] },
        ],
        where: '/workflow',
      }])],
    })
    const pannello = await screen.findByRole('region')
    expect(pannello.textContent).toContain('no teams')
    expect(pannello.textContent).toContain('no active workflow for: incident, change')
  })

  it('chi non è admin non lo vede: non è lui che può rimediare', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('operator'), issuesMock([SENZA_SEMANTICA])],
    })
    await waitFor(() => { expect(screen.queryByRole('region')).not.toBeInTheDocument() })
  })

  /**
   * Nella sua pagina «niente da sistemare» si DICE: una pagina vuota non
   * distingue «tutto a posto» da «la diagnostica non ha risposto». È la
   * differenza col banner, che quando non c'era niente semplicemente non c'era.
   */
  it('niente da sistemare → lo dice', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([])],
    })
    expect(await screen.findByText(/nothing to fix|niente da sistemare/i)).toBeInTheDocument()
  })

  it('una voce senza `where` non offre il pulsante, invece di offrirne uno che non porta da nessuna parte', async () => {
    renderWithProviders(<ConfigurationIssuesPanel />, {
      mocks: [meMock('admin'), issuesMock([{ ...SENZA_SEMANTICA, where: null }])],
    })
    await screen.findByRole('region')
    expect(screen.queryByRole('button', { name: /Vai a sistemare|Go and fix it/i })).not.toBeInTheDocument()
  })
})
