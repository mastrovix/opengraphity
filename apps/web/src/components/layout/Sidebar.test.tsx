import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { gql } from '@apollo/client'
import { Sidebar } from './Sidebar'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock, anomalyStatsMock, anomalyStatsErrorMock } from '@/test/mocks/gql'

// Stesso documento (privato) di Sidebar.tsx: il MockLink confronta la query stampata.
const MY_PENDING_APPROVALS_COUNT = gql`
  query MyPendingApprovalsCount {
    myPendingApprovals { id }
    pendingTicketApprovals { kind entityId onBehalf }
  }
`
function pendingMock(n = 0, tickets: Array<{ onBehalf: boolean }> = []): GqlMock {
  return {
    request: { query: MY_PENDING_APPROVALS_COUNT },
    result: { data: {
      myPendingApprovals: Array.from({ length: n }, (_, i) => ({ __typename: 'ApprovalRequest', id: `a${i}` })),
      pendingTicketApprovals: tickets.map((t, i) => ({ __typename: 'PendingTicketApproval', kind: 'change', entityId: `c${i}`, ...t })),
    } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

function renderSidebar(role: string, opts: { route?: string; collapsed?: boolean; mocks?: GqlMock[] } = {}) {
  const onToggle = vi.fn()
  const utils = renderWithProviders(
    <Sidebar collapsed={opts.collapsed ?? false} width={240} onToggle={onToggle} />,
    { route: opts.route ?? '/dashboard', mocks: opts.mocks ?? [meMock(role), anomalyStatsMock(0), pendingMock(0)] },
  )
  return { ...utils, onToggle }
}

const nav = () => screen.getByRole('navigation', { name: 'Main menu' })

describe('Sidebar — visibilità per ruolo', () => {
  it('utente non admin: dei gruppi di amministrazione solo quello della Knowledge Base', async () => {
    renderSidebar('operator')
    // le voci arrivano coi permessi di `me` (ondata 7): nessuna voce prima di sapere cosa si apre
    expect(await within(nav()).findByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(within(nav()).getByRole('button', { name: 'ITIL Processes' })).toBeInTheDocument()
    // dopo il caricamento di `me` (mock a delay 0) i gruppi admin restano assenti
    await new Promise((r) => setTimeout(r, 10))
    for (const group of ['Organization & access', 'Process rules', 'Data model', 'External connections', 'Platform']) {
      expect(within(nav()).queryByRole('button', { name: group }), group).not.toBeInTheDocument()
    }
    // Ondata 7: l'amministrazione mostra le sole pagine che il ruolo apre — per
    // l'operator la gestione della Knowledge Base (kb.write), nel suo gruppo.
    const catalog = within(nav()).getByRole('button', { name: 'Catalog & knowledge base' })
    await userEvent.click(catalog)
    const panel = document.getElementById(catalog.getAttribute('aria-controls')!)!
    expect(within(panel).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/admin/knowledge-base'])
  })

  // Review of the pages, 26 Sep 2026: one group per topic, a page in one group only.
  it('admin: the administration in six groups by topic, each with its own pages', async () => {
    renderSidebar('admin')
    expect(await within(nav()).findByText('ADMINISTRATION')).toBeInTheDocument()
    const pagesOf = async (group: string): Promise<string[]> => {
      const button = within(nav()).getByRole('button', { name: group })
      if (button.getAttribute('aria-expanded') === 'false') await userEvent.click(button)
      const panel = document.getElementById(button.getAttribute('aria-controls')!)!
      return within(panel).getAllByRole('link').map((l) => l.getAttribute('href')!)
    }
    expect(await pagesOf('Organization & access')).toEqual(['/settings/organization', '/teams', '/users', '/roles', '/security/login'])
    expect(await pagesOf('Process rules')).toEqual(['/workflow', '/settings/itil-designer', '/admin/sla-policies', '/admin/ola-uc',
      '/admin/assessment-questions', '/admin/business-rules', '/admin/triggers', '/settings/anomaly-rules', '/settings/notification-rules'])
    expect(await pagesOf('Catalog & knowledge base')).toEqual(['/admin/service-catalog', '/settings/catalog-forms', '/admin/knowledge-base'])
    expect(await pagesOf('Data model')).toEqual(['/settings/enum-designer', '/settings/domain-matrices', '/settings/ci-types'])
    expect(await pagesOf('External connections')).toEqual(['/admin/integrations', '/settings/notifications', '/settings/sync'])
    expect(await pagesOf('Platform')).toEqual(['/settings/diagnostics', '/logs', '/admin/audit', '/admin/queues', '/admin/monitoring'])
    // The renamed pages read as what they are (point 3 of the review).
    expect(within(nav()).getByRole('link', { name: 'Ticket types' })).toHaveAttribute('href', '/settings/itil-designer')
    expect(within(nav()).getByRole('link', { name: 'Dictionary' })).toHaveAttribute('href', '/settings/enum-designer')
    expect(within(nav()).getByRole('link', { name: 'Catalog forms' })).toHaveAttribute('href', '/settings/catalog-forms')
  })

  it('the group of the current page starts open, with that page lit', async () => {
    renderSidebar('admin', { route: '/settings/domain-matrices' })
    const data = await within(nav()).findByRole('button', { name: 'Data model' })
    expect(data).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Process rules' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).getByRole('link', { name: 'Domain matrices' })).toHaveAttribute('aria-current', 'page')
  })

  it('finché `me` non risponde (o è null) nessuna voce admin', async () => {
    renderSidebar('x', { mocks: [meMock(null), anomalyStatsMock(0), pendingMock(0)] })
    await new Promise((r) => setTimeout(r, 20))
    expect(within(nav()).queryByRole('button', { name: 'Organization & access' })).not.toBeInTheDocument()
  })
})

describe('Sidebar — gruppi collassabili', () => {
  it('un gruppo chiuso ha aria-expanded=false; il click lo apre e mostra le voci', async () => {
    const { user } = renderSidebar('operator')
    const itil = await within(nav()).findByRole('button', { name: 'ITIL Processes' })
    expect(itil).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav()).queryByRole('link', { name: 'Incidents' })).not.toBeInTheDocument()

    await user.click(itil)
    expect(itil).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(itil.getAttribute('aria-controls')!)!
    expect(within(panel).getByRole('link', { name: 'Incidents' })).toHaveAttribute('href', '/incidents')
    expect(within(panel).getByRole('link', { name: 'Changes' })).toHaveAttribute('href', '/changes')

    await user.click(itil)
    expect(itil).toHaveAttribute('aria-expanded', 'false')
  })

  it('il gruppo che contiene la route corrente parte aperto', async () => {
    renderSidebar('operator', { route: '/problems/42' })
    const itil = await within(nav()).findByRole('button', { name: 'ITIL Processes' })
    expect(itil).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav()).getByRole('button', { name: 'Reporting' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('sidebar collassata: i gruppi diventano link icona con title, il bottone di espansione ha aria-expanded=false', async () => {
    const { user, onToggle } = renderSidebar('operator', { collapsed: true })
    expect(await within(nav()).findByTitle('ITIL Processes')).toHaveAttribute('href', '/incidents')
    expect(within(nav()).queryByRole('button', { name: 'ITIL Processes' })).not.toBeInTheDocument()
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  /*
   * IL MENU A COMPARSA (20 set 2026, dal giro nel browser: «con la sidebar
   * compressa i sotto-menu non esistono»).
   *
   * Con la sidebar stretta il gruppo si riduceva alla sua icona, che porta
   * alla PRIMA voce: Costruttore di report, Report SLA e OLA/UC sparivano dal
   * menu, e nessuno poteva sapere che esistessero. Ora le voci sono nel DOM,
   * in un pannellino accanto (si mostra con CSS al passaggio o col Tab):
   * quello che il test può pretendere è che ci SIANO e che portino dove
   * devono.
   */
  it('sidebar collassata: le voci del gruppo restano raggiungibili nel menu a comparsa', async () => {
    renderSidebar('admin', { collapsed: true })
    const gruppo = await within(nav()).findByRole('group', { name: 'Reporting' })
    const voci = within(gruppo).getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(voci).toContain('/custom-reports')
    expect(voci.length).toBeGreaterThan(1)
  })

  it('sidebar espansa: il bottone "Collapse sidebar" ha aria-expanded=true', () => {
    renderSidebar('operator')
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('Sidebar — badge', () => {
  it('anomalie critiche > 0 → badge con conteggio e nome accessibile', async () => {
    const { user } = renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsMock(3), pendingMock(0)] })
    await user.click(await within(nav()).findByRole('button', { name: 'Analysis' }))
    expect(await screen.findByLabelText('3 critical anomalies')).toHaveTextContent('3')
  })

  it('errore nel caricamento anomalie → badge "!" con messaggio nel title (mai nascosto)', async () => {
    const { user } = renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsErrorMock('stats down'), pendingMock(0)] })
    await user.click(await within(nav()).findByRole('button', { name: 'Analysis' }))
    const badge = await screen.findByLabelText('Error loading anomalies')
    expect(badge).toHaveTextContent('!')
    expect(badge).toHaveAttribute('title', 'stats down')
  })

  it('approvazioni pendenti → badge sulla voce Approvals', async () => {
    renderSidebar('operator', { mocks: [meMock('operator'), anomalyStatsMock(0), pendingMock(2)] })
    expect(await screen.findByLabelText('2 pending')).toHaveTextContent('2')
  })

  it('what I could decide only for another team does not count (24 Sep 2026)', async () => {
    renderSidebar('admin', { mocks: [meMock('admin'), anomalyStatsMock(0), pendingMock(1, [{ onBehalf: false }, { onBehalf: true }, { onBehalf: true }])] })
    expect(await screen.findByLabelText('2 pending')).toHaveTextContent('2')
  })
})

describe('Sidebar — Monitoraggio (Event Management)', () => {
  it('end user: nessun gruppo Monitoraggio (nessun permesso event.read / service.read)', async () => {
    renderSidebar('end_user')
    await new Promise((r) => setTimeout(r, 10))
    expect(within(nav()).queryByRole('button', { name: 'Monitoring' })).not.toBeInTheDocument()
  })

  it('viewer: gruppo Monitoraggio con Allarmi e Salute CI, senza Sorgenti né Policy', async () => {
    const { user } = renderSidebar('viewer')
    const group = await within(nav()).findByRole('button', { name: 'Monitoring' })
    await user.click(group)
    const panel = document.getElementById(group.getAttribute('aria-controls')!)!
    expect(within(panel).getByRole('link', { name: 'Alarms' })).toHaveAttribute('href', '/events')
    expect(within(panel).getByRole('link', { name: 'CI health' })).toHaveAttribute('href', '/monitoring/health')
    expect(within(panel).queryByRole('link', { name: 'Sources' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: 'Event policy' })).not.toBeInTheDocument()
  })

  it('/settings/event-policy: attivo solo il gruppo Monitoraggio, nessun gruppo di amministrazione', async () => {
    renderSidebar('admin', { route: '/settings/event-policy' })
    const monitoring = await within(nav()).findByRole('button', { name: 'Monitoring' })
    expect(monitoring).toHaveAttribute('aria-expanded', 'true')
    for (const group of ['Organization & access', 'Process rules', 'Catalog & knowledge base', 'Data model', 'External connections', 'Platform']) {
      expect(within(nav()).getByRole('button', { name: group }), group).toHaveAttribute('aria-expanded', 'false')
    }
  })
})

describe('Sidebar — una voce accesa sola', () => {
  // Su /reports/sla si accendevano «SLA Report» e «AI Analysis» (/reports):
  // ogni voce confrontava il percorso per prefisso. Il test prende TUTTE le
  // voci del menu admin e, pagina per pagina, vuole accesa solo quella.
  it('per ogni voce del menu, sulla sua pagina è accesa solo lei', async () => {
    const { container, unmount, user } = renderSidebar('admin')
    await within(nav()).findByRole('button', { name: 'Organization & access' })
    // Le voci di un gruppo chiuso non sono nel DOM: si aprono tutti.
    for (const b of within(nav()).getAllByRole('button')) {
      if (b.getAttribute('aria-expanded') === 'false') await user.click(b)
    }
    const hrefs = [...new Set(Array.from(container.querySelectorAll<HTMLAnchorElement>('nav a[href]')).map((a) => a.getAttribute('href')!))]
    unmount()
    expect(hrefs).toEqual(expect.arrayContaining(['/reports', '/reports/sla', '/reports/ola-uc', '/incidents', '/admin/sla-policies']))

    for (const href of hrefs) {
      const r = renderSidebar('admin', { route: href })
      await within(nav()).findByRole('button', { name: 'Organization & access' })
      const accese = Array.from(r.container.querySelectorAll('a[aria-current="page"]')).map((a) => a.getAttribute('href'))
      expect({ pagina: href, accese }).toEqual({ pagina: href, accese: [href] })
      r.unmount()
    }
  /*
   * IL TEMPO, DICHIARATO (21 set 2026).
   *
   * Questo test monta la barra una volta per OGNI voce del menu — decine di
   * render con il metamodello e i provider dentro. Sul mio Mac finisce in
   * poco; sul runner della CI, che fa girare tutti i pacchetti insieme, ha
   * misurato 5055 ms contro i 5000 del default, ed era rosso per 55
   * millisecondi.
   *
   * Non si accorcia il test — quello che prova (su ogni pagina è accesa una
   * voce sola, e la sua) vale esattamente perché le guarda tutte. Si dice
   * invece quanto tempo gli serve, invece di lasciarlo dipendere da quanto è
   * scattante la macchina di turno.
   */
  }, 60_000)

  it('una pagina interna accende la voce da cui discende, e solo quella', async () => {
    const { container } = renderSidebar('admin', { route: '/reports/sla/qualcosa' })
    await within(nav()).findByRole('button', { name: 'Organization & access' })
    expect(Array.from(container.querySelectorAll('a[aria-current="page"]')).map((a) => a.getAttribute('href'))).toEqual(['/reports/sla'])
  })
})
