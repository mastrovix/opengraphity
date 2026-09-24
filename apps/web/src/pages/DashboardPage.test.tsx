/**
 * THE DASHBOARD PAGE: the person's dashboards, the one on screen, and the
 * "Customize" mode where its widgets are arranged and saved.
 *
 * It is the first page most people open, so what is pinned here is what they
 * rely on every day:
 *  - it opens on the dashboard marked as default (not just the first of the
 *    list), draws its report and custom widgets, and says how to fill it
 *    when it is empty;
 *  - the selector lists every dashboard with its audience, and switches;
 *  - creating, renaming, sharing, setting as default and deleting send what
 *    the dialogs show, and a failure is said, never swallowed, with the
 *    dialog kept open;
 *  - in Customize mode the layout is saved as ONE layout, in the order and
 *    widths on screen, with removed widgets left out and added ones created;
 *    a failed or unconfirmed save keeps the arrangement for a retry, and
 *    Cancel throws the arrangement away;
 *  - custom widgets are created, edited and deleted from the same mode, on
 *    the server at once: Cancel does not undo them.
 *
 * The tests at the end found defects while they were being written; all are
 * fixed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, setCssVars } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { DashboardPage } from './DashboardPage'

/*
 * The fake Apollo of the page tests, with two additions:
 *  - a query named in `finto.inCaricamento` is still loading;
 *  - the server's answer to a mutation can be HELD (`finto.porta`), to see
 *    the page while it waits.
 */
const finto = vi.hoisted(() => ({ inCaricamento: new Set<string>(), porta: null as Promise<void> | null }))
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (...args: Parameters<typeof base.useQuery>) => {
      const r = base.useQuery(...args)
      return finto.inCaricamento.has(nomeOperazione(args[0])) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [run, state] = base.useMutation(...args) as [(o?: unknown) => Promise<unknown>, unknown]
      const held = async (o?: unknown) => {
        if (finto.porta) await finto.porta
        return run(o)
      }
      return [held, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// The widget dialog picks its default colour from the theme tokens.
let clearCssVars: () => void = () => {}
beforeAll(() => {
  resetCssVarCache()
  clearCssVars = setCssVars({
    '--color-brand': '#0284c7', '--color-success': '#16a34a', '--color-danger': '#ef4444',
    '--color-warning': '#eab308', '--color-purple-light': '#8b5cf6', '--color-slate': '#64748b',
  })
})
afterAll(() => { clearCssVars(); resetCssVarCache() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const reportWidget = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, order: 0, colSpan: 6, reportTemplateId: 'rt1', reportSectionId: `s-${id}`,
  data: JSON.stringify({ value: 42, label: 'open' }), error: null,
  reportSection: { id: `s-${id}`, title, chartType: 'kpi' }, reportTemplate: { id: 'rt1', name: 'Weekly report' },
  ...over,
})

const customWidget = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, widgetType: 'counter', entityType: 'incident', metric: 'count', groupByField: null, filterField: null,
  filterValue: null, timeRange: null, size: 'small', color: '#0ea5e9', position: 0, dashboardId: 'd1', ...over,
})

const dashboard = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, description: null, role: null, isDefault: false, isPersonal: true, isShared: false, visibility: 'private',
  createdAt: '2026-09-01T08:00:00Z', createdBy: { id: 'u-1', name: 'Test User' }, sharedWith: [] as { id: string; name: string }[],
  widgets: [] as ReturnType<typeof reportWidget>[], customWidgets: [] as ReturnType<typeof customWidget>[],
  ...over,
})

const OPS = dashboard('d1', 'Operations', {
  isDefault: true,
  widgets: [reportWidget('w1', 'Open incidents'), reportWidget('w2', 'Backlog', { colSpan: 4 }), reportWidget('w3', 'Aging', { colSpan: 2 })],
  customWidgets: [customWidget('cw1', 'Critical tickets')],
})
const DESK = dashboard('d2', 'Service desk', { visibility: 'teams', sharedWith: [{ id: 't1', name: 'Network' }] })
const ALL = dashboard('d3', 'Everyone', { visibility: 'all' })
const NIGHT = dashboard('d9', 'Night shift')
// One object per dashboard, always the same: the page syncs its state from them.
const BY_ID: Record<string, ReturnType<typeof dashboard>> = { d1: OPS, d2: DESK, d3: ALL, d9: NIGHT }

/** The signed-in user. */
const meAs = (id: string, permissions: string[]) => ({ me: {
  id, name: 'Test User', email: 'test@example.com', role: 'operator', roleName: null, permissions,
  slackId: null, emailNotifications: null, language: null, teams: [],
} })

const TEMPLATES = [
  { id: 'rt1', name: 'Weekly report', sections: [{ id: 's-w1', title: 'Open incidents', chartType: 'kpi', order: 0 }] },
  { id: 'rt2', name: 'SLA report', sections: [{ id: 's9', title: 'Breaches', chartType: 'kpi', order: 0 }] },
]

const SAVED_LAYOUT = { saveDashboardLayout: { id: 'd1', name: 'Operations', widgets: [reportWidget('w1', 'Open incidents')] } }

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.refetch.mockImplementation(async () => ({ data: {} }))
  finto.inCaricamento.clear()
  finto.porta = null
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [DESK, OPS, ALL] }
  // The owner of the dashboards above, without dashboard.manageAll.
  apolloFinto.risposte['GetMe'] = meAs('u-1', [])
  apolloFinto.risposte['GetDashboard'] = (v?: Record<string, unknown>) => ({ dashboard: BY_ID[String(v?.['id'])] ?? null })
  apolloFinto.risposte['GetReportTemplates'] = { reportTemplates: TEMPLATES }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't1', name: 'Network' }, { id: 't2', name: 'Security' }] }
  apolloFinto.risposte['GetWidgetData'] = { widgetData: { value: 7, label: null, series: [] } }
  apolloFinto.risposte['GetWidgetCatalog'] = { widgetCatalog: [{ entityType: 'incident', label: 'Incident', group: 'itsm', fields: [] }] }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Incident', fields: [] }] }
  apolloFinto.esiti['CreateDashboard'] = { data: { createDashboard: { id: 'd9', name: 'Night shift' } } }
  apolloFinto.esiti['SaveDashboardLayout'] = { data: SAVED_LAYOUT }
  apolloFinto.esiti['CreateCustomWidget'] = { data: { createCustomWidget: customWidget('cw9', 'Escalations') } }
  apolloFinto.esiti['UpdateCustomWidget'] = { data: { updateCustomWidget: customWidget('cw1', 'Critical and high') } }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const selector = () => screen.getByRole('button', { name: 'Select dashboard' })
const dialog = (name: string) => screen.getByRole('dialog', { name })
type User = ReturnType<typeof renderWithProviders>['user']

async function openDashboard(user: User, name: RegExp) {
  await user.click(selector())
  await user.click(screen.getByRole('button', { name }))
}

async function customize(user: User) {
  await user.click(screen.getByRole('button', { name: /Customize/ }))
  // The edit mode is loaded lazily.
  await screen.findByText('Add from report')
  return screen.getByRole('button', { name: /Save/ })
}

/** The custom widget dialog is loaded lazily. */
const widgetDialog = (name: 'New custom widget' | 'Edit widget') => screen.findByRole('dialog', { name })

/** The report widgets being arranged, by section title, in the order on screen. */
const TITLES = ['Open incidents', 'Backlog', 'Aging', 'Breaches']
const arranged = () => Array.from(document.querySelectorAll<HTMLElement>('[aria-roledescription="sortable"]'))
  .map((el) => TITLES.find((title) => within(el).queryByText(title) !== null))

const savedLayout = () => (apolloFinto.chiamata('SaveDashboardLayout')?.['widgets'] as Array<Record<string, unknown>>)

/** jsdom has no layout: each widget being arranged gets a box in a row, 400 px apart. */
function placeWidgetsInARow() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const sortable = this.getAttribute('aria-roledescription') === 'sortable'
    const x = sortable ? Array.from(this.parentElement!.children).indexOf(this) * 400 : 0
    const [width, height] = sortable ? [300, 200] : [0, 0]
    return { x, y: 0, left: x, top: 0, right: x + width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
  })
}

/** Drags a widget by its handle to the given x, then waits until the library lets clicks through again. */
async function dragWidget(title: string, toX: number) {
  const card = screen.getByText(title, { selector: 'div' }).closest('[aria-roledescription="sortable"]') as HTMLElement
  const handle = within(card).getByTitle('Drag')
  fireEvent.pointerDown(handle, { isPrimary: true, button: 0, clientX: 10, clientY: 10 })
  fireEvent.pointerMove(document, { clientX: 30, clientY: 10 })
  fireEvent.pointerMove(document, { clientX: toX, clientY: 10 })
  fireEvent.pointerUp(document, { clientX: toX, clientY: 10 })
  const probe = vi.fn()
  const button = document.createElement('button')
  button.addEventListener('click', probe)
  document.body.append(button)
  await waitFor(() => { button.click(); expect(probe).toHaveBeenCalled() })
  button.remove()
}

/** Holds the server's answer to the next mutations until `rispondi()`. */
function holdTheServer() {
  let rispondi!: () => void
  finto.porta = new Promise((r) => { rispondi = r })
  return () => act(() => { rispondi() })
}

// ── View mode ────────────────────────────────────────────────────────────────

describe('DashboardPage — the dashboard on screen', () => {
  it('opens the default dashboard, not the first of the list, and draws its report and custom widgets', async () => {
    renderWithProviders(<DashboardPage />)
    expect(selector()).toHaveTextContent('Operations')
    expect(apolloFinto.chiamata('GetDashboard')).toEqual({ id: 'd1', language: 'en' })
    expect(await screen.findByText('Open incidents')).toBeInTheDocument()
    expect(screen.getByText('Backlog')).toBeInTheDocument()
    expect(await screen.findByText('Critical tickets')).toBeInTheDocument()
    expect(await screen.findByText('7')).toBeInTheDocument()
    // View mode: nothing to edit on the cards.
    expect(screen.queryByRole('button', { name: 'Edit widget' })).toBeNull()
  })

  it('without a default, the first dashboard of the list is opened', () => {
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [DESK, ALL] }
    renderWithProviders(<DashboardPage />)
    expect(selector()).toHaveTextContent('Service desk')
    expect(apolloFinto.chiamata('GetDashboard')).toEqual({ id: 'd2', language: 'en' })
  })

  it('an empty dashboard says how to fill it', () => {
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [ALL] }
    renderWithProviders(<DashboardPage />)
    expect(screen.getByText(/This dashboard is empty\. Click/)).toHaveTextContent('This dashboard is empty. Click Customize to add your reports.')
  })

  it('shows "Loading..." while the list loads, and while the chosen dashboard loads', () => {
    finto.inCaricamento.add('GetMyDashboards')
    const { unmount } = renderWithProviders(<DashboardPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select dashboard' })).toBeNull()
    unmount()

    finto.inCaricamento.clear()
    finto.inCaricamento.add('GetDashboard')
    renderWithProviders(<DashboardPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('the selector lists every dashboard — a star on the default, the audience of the shared ones — and switches', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    expect(selector()).toHaveAttribute('aria-expanded', 'false')
    await user.click(selector())
    expect(selector()).toHaveAttribute('aria-expanded', 'true')
    const ops = screen.getByRole('button', { name: /Operations/ })
    const desk = screen.getByRole('button', { name: /Service desk/ })
    const all = screen.getByRole('button', { name: /Everyone/ })
    expect(within(ops).getByText('★')).toBeInTheDocument()
    expect(within(desk).queryByText('★')).toBeNull()
    expect(within(desk).getByText('team')).toBeInTheDocument()
    expect(within(all).getByText('all')).toBeInTheDocument()
    // A private dashboard has no audience to show.
    expect(ops).toHaveTextContent(/^★Operations$/)

    await user.click(desk)
    expect(selector()).toHaveTextContent('Service desk')
    expect(selector()).toHaveAttribute('aria-expanded', 'false')
    expect(apolloFinto.chiamata('GetDashboard')).toEqual({ id: 'd2', language: 'en' })
  })
})

// ── Create ───────────────────────────────────────────────────────────────────

describe('DashboardPage — a new dashboard', () => {
  async function openCreate(user: User) {
    await user.click(selector())
    await user.click(screen.getByRole('button', { name: /New dashboard/ }))
    return dialog('New dashboard')
  }

  it('needs a name; shared with teams it asks which ones; the new dashboard is then opened', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openCreate(user)
    const create = within(dlg).getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled()
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), '  Night shift ')
    expect(create).toBeEnabled()
    expect(within(dlg).queryByRole('checkbox')).toBeNull()
    await user.selectOptions(within(dlg).getByRole('combobox', { name: 'Visibility' }), 'Shared with teams')
    await user.click(within(dlg).getByRole('checkbox', { name: 'Security' }))
    await user.click(within(dlg).getByRole('checkbox', { name: 'Network' }))
    await user.click(within(dlg).getByRole('checkbox', { name: 'Security' }))
    expect(within(dlg).getByRole('checkbox', { name: 'Security' })).not.toBeChecked()

    // The reloaded list has the new dashboard.
    apolloFinto.refetch.mockImplementation(async () => {
      apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [DESK, OPS, ALL, NIGHT] }
      return { data: {} }
    })
    await user.click(create)
    expect(apolloFinto.chiamata('CreateDashboard')).toEqual({ input: { name: 'Night shift', visibility: 'teams', sharedWithTeamIds: ['t1'] } })
    await waitFor(() => expect(selector()).toHaveTextContent('Night shift'))
    expect(apolloFinto.chiamata('GetDashboard')).toEqual({ id: 'd9', language: 'en' })
    expect(toast.success).toHaveBeenCalledWith('Dashboard created')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter in the name creates it; a private dashboard is shared with nobody, even with teams ticked before', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openCreate(user)
    const visibility = within(dlg).getByRole('combobox', { name: 'Visibility' })
    await user.selectOptions(visibility, 'Shared with teams')
    await user.click(within(dlg).getByRole('checkbox', { name: 'Network' }))
    await user.selectOptions(visibility, 'Private (only me)')
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Mine{Enter}')
    expect(apolloFinto.chiamata('CreateDashboard')).toEqual({ input: { name: 'Mine', visibility: 'private', sharedWithTeamIds: [] } })
  })

  it('Enter with no name creates nothing; Cancel closes the dialog', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openCreate(user)
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), '   {Enter}')
    expect(apolloFinto.chiamate['CreateDashboard']).toBeUndefined()
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with no team to share with — or before the teams have arrived — it says so', async () => {
    apolloFinto.risposte['GetTeams'] = { teams: [] }
    const { user, unmount } = renderWithProviders(<DashboardPage />)
    let dlg = await openCreate(user)
    await user.selectOptions(within(dlg).getByRole('combobox', { name: 'Visibility' }), 'Shared with teams')
    expect(within(dlg).getByText('No teams')).toBeInTheDocument()
    unmount()

    delete apolloFinto.risposte['GetTeams']
    const second = renderWithProviders(<DashboardPage />)
    dlg = await openCreate(second.user)
    await second.user.selectOptions(within(dlg).getByRole('combobox', { name: 'Visibility' }), 'Shared with teams')
    expect(within(dlg).getByText('No teams')).toBeInTheDocument()
    expect(within(dlg).queryByRole('checkbox')).toBeNull()
  })

  it('while it is created the button says "Creating…" and cannot be pressed', async () => {
    const rispondi = holdTheServer()
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openCreate(user)
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Night shift')
    await user.click(within(dlg).getByRole('button', { name: 'Create' }))
    expect(await within(dlg).findByRole('button', { name: 'Creating…' })).toBeDisabled()
    rispondi()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a failed creation says why and keeps the dialog with the name typed', async () => {
    apolloFinto.esiti['CreateDashboard'] = { error: new Error('quota reached') }
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openCreate(user)
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Night shift')
    await user.click(within(dlg).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dashboard creation failed: quota reached'))
    expect(within(dialog('New dashboard')).getByRole('textbox', { name: 'Name' })).toHaveValue('Night shift')
    expect(within(dialog('New dashboard')).getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})

// ── Settings ─────────────────────────────────────────────────────────────────

describe('DashboardPage — settings', () => {
  const openSettings = async (user: User) => {
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    return dialog('Dashboard settings')
  }

  it('shows the name and audience; saving sends them, reloads the list and the dashboard, and closes', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const dlg = await openSettings(user)
    const name = within(dlg).getByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('Operations')
    expect(within(dlg).getByRole('combobox', { name: 'Visibility' })).toHaveValue('private')
    // Already the default: nothing to set.
    expect(within(dlg).queryByRole('button', { name: /Set as default/ })).toBeNull()

    await user.clear(name)
    await user.type(name, 'Ops room')
    await user.selectOptions(within(dlg).getByRole('combobox', { name: 'Visibility' }), 'Everyone in the tenant')
    await user.click(within(dlg).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateDashboard')).toEqual({ id: 'd1', input: { name: 'Ops room', visibility: 'all', sharedWithTeamIds: [] } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Dashboard updated')
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
  })

  it('a team dashboard opens with its teams ticked; a blank name keeps the current one', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await openDashboard(user, /Service desk/)
    const dlg = await openSettings(user)
    expect(within(dlg).getByRole('checkbox', { name: 'Network' })).toBeChecked()
    await user.click(within(dlg).getByRole('checkbox', { name: 'Security' }))
    await user.click(within(dlg).getByRole('checkbox', { name: 'Network' }))
    await user.clear(within(dlg).getByRole('textbox', { name: 'Name' }))
    await user.click(within(dlg).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateDashboard')).toEqual({ id: 'd2', input: { name: 'Service desk', visibility: 'teams', sharedWithTeamIds: ['t2'] } })
  })

  it('"Set as default" is offered on another dashboard, and sets it without closing the dialog', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await openDashboard(user, /Service desk/)
    const dlg = await openSettings(user)
    await user.click(within(dlg).getByRole('button', { name: /Set as default/ }))
    expect(apolloFinto.chiamata('UpdateDashboard')).toEqual({ id: 'd2', input: { isDefault: true } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Dashboard set as default'))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
    expect(dialog('Dashboard settings')).toBeInTheDocument()
  })

  it('a failed update or "set as default" says why and keeps the dialog', async () => {
    apolloFinto.esiti['UpdateDashboard'] = { error: new Error('name taken') }
    const { user } = renderWithProviders(<DashboardPage />)
    await openDashboard(user, /Service desk/)
    const dlg = await openSettings(user)
    await user.click(within(dlg).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dashboard update failed: name taken'))
    await user.click(within(dlg).getByRole('button', { name: /Set as default/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(dialog('Dashboard settings')).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('while saving the button says "Saving…"; Cancel closes without saving', async () => {
    const rispondi = holdTheServer()
    const { user } = renderWithProviders(<DashboardPage />)
    let dlg = await openSettings(user)
    await user.click(within(dlg).getByRole('button', { name: 'Save' }))
    expect(await within(dlg).findByRole('button', { name: 'Saving…' })).toBeDisabled()
    rispondi()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    dlg = await openSettings(user)
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['UpdateDashboard']).toHaveLength(1)
  })
})

// ── Delete ───────────────────────────────────────────────────────────────────

describe('DashboardPage — deleting a dashboard', () => {
  it('asks for a confirmation, deletes, and opens the default dashboard', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await openDashboard(user, /Service desk/)
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    const dlg = dialog('Dashboard settings')
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }))
    expect(apolloFinto.chiamate['DeleteDashboard']).toBeUndefined()
    await user.click(within(dlg).getByRole('button', { name: 'Confirm deletion' }))
    expect(apolloFinto.chiamata('DeleteDashboard')).toEqual({ id: 'd2' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Dashboard deleted')
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(selector()).toHaveTextContent('Operations')
  })

  it('the only dashboard cannot be deleted', async () => {
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [OPS] }
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    expect(within(dialog('Dashboard settings')).queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('while deleting the button says "Deleting…"; a failure says why and keeps the dialog', async () => {
    apolloFinto.esiti['DeleteDashboard'] = { error: new Error('still shared') }
    const rispondi = holdTheServer()
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    const dlg = dialog('Dashboard settings')
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }))
    await user.click(within(dlg).getByRole('button', { name: 'Confirm deletion' }))
    expect(await within(dlg).findByRole('button', { name: 'Deleting…' })).toBeDisabled()
    rispondi()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dashboard deletion failed: still shared'))
    expect(dialog('Dashboard settings')).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Confirm deletion' })).toBeEnabled()
    expect(selector()).toHaveTextContent('Operations')
  })
})

// ── Customize: report widgets ────────────────────────────────────────────────

describe('DashboardPage — customizing the layout', () => {
  it('"Customize" replaces Customize and Settings with Save and Cancel', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Customize/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Settings/ })).toBeNull()
    expect(arranged()).toEqual(['Open incidents', 'Backlog', 'Aging'])
  })

  it('saves ONE layout as arranged — widths, removed widgets left out, added sections created — then shows the dashboard', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Width (columns)' })[0]!, '12 cols')
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[1]!)
    await user.click(screen.getByRole('button', { name: /^SLA report/ }))
    await user.click(screen.getByRole('button', { name: 'Add Breaches' }))
    expect(arranged()).toEqual(['Open incidents', 'Aging', 'Breaches'])
    expect(screen.getByText('new')).toBeInTheDocument()

    await user.click(save)
    expect(apolloFinto.chiamata('SaveDashboardLayout')).toEqual({ dashboardId: 'd1', language: 'en', widgets: [
      { id: 'w1', reportTemplateId: 'rt1', reportSectionId: 's-w1', colSpan: 12 },
      { id: 'w3', reportTemplateId: 'rt1', reportSectionId: 's-w3', colSpan: 2 },
      { id: null, reportTemplateId: 'rt2', reportSectionId: 's9', colSpan: 4 },
    ] })
    await waitFor(() => expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Dashboard saved')
  })

  it('a section added and removed in the same session is simply not saved', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    await user.click(screen.getByRole('button', { name: /^SLA report/ }))
    await user.click(screen.getByRole('button', { name: 'Add Breaches' }))
    // The report stays open; a second click closes it.
    await user.click(screen.getByRole('button', { name: /^SLA report/ }))
    expect(screen.queryByRole('button', { name: 'Add Breaches' })).toBeNull()
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[3]!)
    expect(arranged()).toEqual(['Open incidents', 'Backlog', 'Aging'])
    await user.click(save)
    expect(savedLayout().map((w) => w['id'])).toEqual(['w1', 'w2', 'w3'])
  })

  it('dragging a widget onto another saves the new order', async () => {
    placeWidgetsInARow()
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    // "Open incidents" (first) dropped on "Aging" (third).
    await dragWidget('Open incidents', 810)
    expect(arranged()).toEqual(['Backlog', 'Aging', 'Open incidents'])
    await user.click(save)
    expect(savedLayout().map((w) => w['id'])).toEqual(['w2', 'w3', 'w1'])
  })

  it('a widget dropped back on itself changes nothing', async () => {
    placeWidgetsInARow()
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    await dragWidget('Open incidents', 20)
    expect(arranged()).toEqual(['Open incidents', 'Backlog', 'Aging'])
    await user.click(save)
    expect(savedLayout().map((w) => w['id'])).toEqual(['w1', 'w2', 'w3'])
  })

  it('a widget removed before reordering stays out of the saved layout', async () => {
    placeWidgetsInARow()
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[1]!)
    await dragWidget('Open incidents', 410)
    expect(arranged()).toEqual(['Aging', 'Open incidents'])
    await user.click(save)
    expect(savedLayout().map((w) => w['id'])).toEqual(['w3', 'w1'])
  })

  it('Cancel throws the arrangement away: the dashboard, and the next Customize, are as saved', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[0]!)
    expect(arranged()).toEqual(['Backlog', 'Aging'])
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(await screen.findByText('Open incidents')).toBeInTheDocument()
    await customize(user)
    expect(arranged()).toEqual(['Open incidents', 'Backlog', 'Aging'])
    expect(apolloFinto.chiamate['SaveDashboardLayout']).toBeUndefined()
  })

  it('switching dashboard while customizing leaves Customize without saving', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[0]!)
    await openDashboard(user, /Service desk/)
    expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument()
    expect(apolloFinto.chiamate['SaveDashboardLayout']).toBeUndefined()
    await openDashboard(user, /Operations/)
    expect(await screen.findByText('Open incidents')).toBeInTheDocument()
  })

  it('a failed save stays in Customize with the arrangement, and a retry sends the same layout', async () => {
    apolloFinto.esiti['SaveDashboardLayout'] = { error: new Error('layout conflict') }
    const { user } = renderWithProviders(<DashboardPage />)
    const save = await customize(user)
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[0]!)
    await user.click(save)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Error while saving: layout conflict'))
    expect(arranged()).toEqual(['Backlog', 'Aging'])
    const first = savedLayout()
    apolloFinto.esiti['SaveDashboardLayout'] = { data: SAVED_LAYOUT }
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(savedLayout()).toEqual(first)
    await waitFor(() => expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument())
  })

  it('a save the server does not confirm is an error, not a silent success', async () => {
    apolloFinto.esiti['SaveDashboardLayout'] = { data: {} }
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(await customize(user))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Error while saving: Empty response from server: layout not confirmed'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument()
  })

  it('while saving, Save says "Saving…" and neither Save nor Cancel can be pressed', async () => {
    const rispondi = holdTheServer()
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(await customize(user))
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled()
    rispondi()
    await waitFor(() => expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument())
  })

  // Review of 23 Sep 2026: with no dashboard there is nothing to customize; it says how to make one.
  it('with no dashboard at all, nothing can be customized and the page offers to create the first one', async () => {
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [] }
    const { user } = renderWithProviders(<DashboardPage />)
    expect(selector()).toHaveTextContent('…')
    expect(await screen.findByText('You have no dashboard yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Customize/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create your first dashboard' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(apolloFinto.chiamate['SaveDashboardLayout']).toBeUndefined()
  })

  it('before the reports have arrived, the side panel says there is no report to add', async () => {
    delete apolloFinto.risposte['GetReportTemplates']
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    expect(screen.getByText('No reports available.')).toBeInTheDocument()
  })
})

// ── Customize: custom widgets ────────────────────────────────────────────────

describe('DashboardPage — custom widgets', () => {
  const sideList = () => screen.getByText(/^Created \(/).parentElement as HTMLElement

  it('"Create widget" opens the dialog; the saved widget joins the dashboard', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Create widget' }))
    const dlg = await widgetDialog('New custom widget')
    await user.type(within(dlg).getByRole('textbox', { name: 'Title *' }), 'Escalations')
    await user.click(within(dlg).getByRole('button', { name: 'Create widget' }))
    expect(apolloFinto.chiamata('CreateCustomWidget')).toEqual({ input: expect.objectContaining({ title: 'Escalations', dashboardId: 'd1' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(sideList()).getByText('Created (2)')).toBeInTheDocument()
    expect(within(sideList()).getByText('Escalations')).toBeInTheDocument()
  })

  it('"Edit" opens the dialog with the widget; the update replaces it in place', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(within(sideList()).getByRole('button', { name: 'Edit' }))
    const dlg = await widgetDialog('Edit widget')
    const title = within(dlg).getByRole('textbox', { name: 'Title *' })
    expect(title).toHaveValue('Critical tickets')
    await user.clear(title)
    await user.type(title, 'Critical and high')
    await user.click(within(dlg).getByRole('button', { name: 'Update widget' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(sideList()).getByText('Created (1)')).toBeInTheDocument()
    expect(within(sideList()).getByText('Critical and high')).toBeInTheDocument()
    expect(within(sideList()).queryByText('Critical tickets')).toBeNull()
  })

  it('the card itself also opens its widget for editing; Cancel closes the dialog without saving', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    const card = (await screen.findByText('7')).closest('div[style*="span"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Edit widget' }))
    await user.click(within(await widgetDialog('Edit widget')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['UpdateCustomWidget']).toBeUndefined()
  })

  it('"Delete" removes the widget at once and says so', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(within(sideList()).getByRole('button', { name: 'Delete' }))
    expect(apolloFinto.chiamata('DeleteCustomWidget')).toEqual({ id: 'cw1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Widget removed'))
    expect(screen.queryByText(/^Created \(/)).toBeNull()
    expect(screen.queryByText('Critical tickets')).toBeNull()
  })

  it('a failed delete says why and keeps the widget', async () => {
    apolloFinto.esiti['DeleteCustomWidget'] = { error: new Error('widget locked') }
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    const card = (await screen.findByText('7')).closest('div[style*="span"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Remove widget' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Widget removal failed: widget locked'))
    expect(within(sideList()).getByText('Critical tickets')).toBeInTheDocument()
  })

  it('the widget dialog stays open when the layout is saved behind it, and still adds its widget', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Create widget' }))
    // Tab no longer reaches the header's Save behind the dialog, which keeps the
    // keyboard inside (see WidgetConfigPanel.test.tsx); pressed anyway, it must
    // leave the dialog and its work alone.
    fireEvent.click(screen.getByRole('button', { name: /✓ Save/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument())
    const dlg = await widgetDialog('New custom widget')
    await user.type(within(dlg).getByRole('textbox', { name: 'Title *' }), 'Escalations')
    await user.click(within(dlg).getByRole('button', { name: 'Create widget' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('Escalations')).toBeInTheDocument()
  })

  it('a widget dialog left open over the dashboard closes with its Cancel', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Create widget' }))
    fireEvent.click(screen.getByRole('button', { name: /✓ Save/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument())
    await user.click(within(await widgetDialog('New custom widget')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ── Defects ──────────────────────────────────────────────────────────────────

describe('DashboardPage — defects found while writing these tests', () => {
  /*
   * Found by this test (tour of 23 Sep 2026), fixed: deleting a custom widget
   * is immediate on the server, but Cancel reset the list from the dashboard
   * as it was LOADED, which still had it: the deleted widget came back on
   * screen until the page was reloaded — and, the other way round, a widget
   * created while customizing disappeared on Cancel, though it was saved.
   */
  it('a custom widget deleted while customizing stays deleted after Cancel', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(within(screen.getByText(/^Created \(/).parentElement as HTMLElement).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Widget removed'))
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(await screen.findByText('Open incidents')).toBeInTheDocument()
    expect(screen.queryByText('Critical tickets')).toBeNull()
  })

  it('a custom widget created while customizing stays after Cancel', async () => {
    const { user } = renderWithProviders(<DashboardPage />)
    await customize(user)
    await user.click(screen.getByRole('button', { name: 'Create widget' }))
    const dlg = await widgetDialog('New custom widget')
    await user.type(within(dlg).getByRole('textbox', { name: 'Title *' }), 'Escalations')
    await user.click(within(dlg).getByRole('button', { name: 'Create widget' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(await screen.findByText('Escalations')).toBeInTheDocument()
    expect(screen.getByText('Critical tickets')).toBeInTheDocument()
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: after deleting the
   * DEFAULT dashboard the page cleared the selection and reloaded the list,
   * but the auto-selection ran on the list it still had — the one with the
   * deleted dashboard, the default — and picked it again. When the new list
   * arrived the selection was not empty any more, so it stayed there: the
   * selector read "…" and the page asked for a dashboard that no longer
   * existed. The page now opens one of the dashboards that remain at once.
   */
  it('after deleting the default dashboard, a dashboard that still exists is opened', async () => {
    let rispondiLista!: () => void
    apolloFinto.refetch.mockImplementation(() => new Promise((resolve) => {
      rispondiLista = () => {
        apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [DESK, ALL] }
        resolve({ data: {} })
      }
    }))
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(screen.getByRole('button', { name: /Settings/ }))
    const dlg = dialog('Dashboard settings')
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }))
    await user.click(within(dlg).getByRole('button', { name: 'Confirm deletion' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The reloaded list arrives after the page has re-rendered, as a network answer does.
    act(() => { rispondiLista() })
    await user.click(selector())
    await waitFor(() => expect(selector()).toHaveTextContent('Service desk'))
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the Create button was
   * disabled while the dashboard was being created, but Enter in the name
   * field was not: pressing Enter again while the first request ran sent a
   * second one, and the person ended up with two dashboards with the same name.
   */
  it('pressing Enter twice while the dashboard is being created creates it once', async () => {
    const rispondi = holdTheServer()
    const { user } = renderWithProviders(<DashboardPage />)
    await user.click(selector())
    await user.click(screen.getByRole('button', { name: /New dashboard/ }))
    const dlg = dialog('New dashboard')
    await user.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Night shift{Enter}')
    await within(dlg).findByRole('button', { name: 'Creating…' })
    await user.keyboard('{Enter}')
    rispondi()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(apolloFinto.chiamate['CreateDashboard']).toHaveLength(1)
  })
})

// Review of 23 Sep 2026: a colleague's shared dashboard offered Customize and
// Settings, and every save came back refused by the API.
describe('DashboardPage — a dashboard someone else owns', () => {
  const SHARED = dashboard('d1', 'Operations', { isDefault: true, visibility: 'all', createdBy: { id: 'u-7', name: 'Grace' } })

  it('is read only: no Customize, no Settings, and it says whose it is', async () => {
    BY_ID['d1'] = SHARED
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [SHARED] }
    try {
      renderWithProviders(<DashboardPage />)
      expect(await screen.findByText('Shared by Grace')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Customize/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Settings/ })).toBeNull()
      expect(screen.getByText('This dashboard is empty. Only its owner adds reports to it.')).toBeInTheDocument()
    } finally {
      BY_ID['d1'] = OPS
    }
  })

  it('dashboard.manageAll customizes it, but its settings stay the owner\'s', async () => {
    BY_ID['d1'] = SHARED
    apolloFinto.risposte['GetMyDashboards'] = { myDashboards: [SHARED] }
    apolloFinto.risposte['GetMe'] = meAs('u-1', ['dashboard.manageAll'])
    try {
      renderWithProviders(<DashboardPage />)
      expect(await screen.findByRole('button', { name: /Customize/ })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Settings/ })).toBeNull()
      expect(screen.queryByText('Shared by Grace')).toBeNull()
    } finally {
      BY_ID['d1'] = OPS
    }
  })
})
