/**
 * REPORT BUILDER: the reports a person builds, runs, exports and schedules.
 *
 * One page, three views driven by `useCustomReports`: the list of reports
 * (create, duplicate, delete), a report (run it, export it, add, edit and
 * remove its sections) and its settings (name, who sees it, and the schedule
 * that mails it). What breaks for a user if it regresses: a report created or
 * saved with the wrong teams or schedule, a delete without asking, an export
 * that downloads nothing or without the token, a settings form that closes
 * although half of it was not saved (G-23), or a run whose results do not
 * reach their sections.
 *
 * The section builder (a wizard with its own tests) and the chart (ECharts)
 * are stand-ins here: what is tested is what the page hands to them and does
 * with what they give back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { InMemoryCache } from '@apollo/client'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { GET_REPORT_TEMPLATES } from '@/graphql/queries'
import type { ReportSectionInput } from '@/components/ReportSectionBuilder'
import type { ReportSection, ReportTemplate } from './useCustomReports'

/**
 * Two things the shared fake does not do, added for this page:
 * - a lazy query that fails (running a report can);
 * - a mutation with its own `onError` that also REJECTS, as Apollo 4 does
 *   (`react/hooks/useMutation.js`: `onError(error)` then `throw error`). The
 *   fake only calls `onError`; the operations named in `rejectsLikeApollo` get
 *   the real behaviour, for the tests about what the page does after a refusal.
 */
const runErrors = vi.hoisted(() => ({} as Record<string, Error | undefined>))
const rejectsLikeApollo = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useLazyQuery: (doc: Parameters<typeof base.useLazyQuery>[0]) => {
      const [run, result] = base.useLazyQuery(doc)
      return [run, { ...result, error: runErrors[nomeOperazione(doc)] }]
    },
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [mutate, state] = base.useMutation(...args) as [(options?: unknown) => Promise<{ errors?: Error[] }>, unknown]
      if (!rejectsLikeApollo.has(nomeOperazione(args[0]))) return [mutate, state]
      const rejecting = (options?: unknown) => {
        const promise = mutate(options).then((res) => {
          if (res?.errors) throw res.errors[0]
          return res
        })
        promise.catch(() => {})  // Apollo's preventUnhandledRejection
        return promise
      }
      return [rejecting, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const download = vi.hoisted(() => ({ file: vi.fn() }))
vi.mock('@/lib/downloadPdf', () => ({ downloadFile: download.file }))

vi.mock('@/components/ReportChartRenderer', () => ({
  ReportChartRenderer: ({ title, chartType, data, error }: { title: string; chartType: string; data: string; error?: string | null }) => (
    <figure aria-label={title}>{error ?? `${chartType}: ${data}`}</figure>
  ),
}))

/** The section the stand-in builder hands back when a new one is saved. */
const BUILT: ReportSectionInput = vi.hoisted(() => ({
  title: 'Changes by risk', chartType: 'pie', groupByNodeId: 'n9', groupByField: 'risk', groupByGranularity: null,
  metric: 'count', metricField: null, limit: null, sortDir: null,
  nodes: [{ id: 'n9', entityType: 'change', neo4jLabel: 'Change', label: 'Change', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: null, selectedFields: [] }],
  edges: [],
}))
vi.mock('@/components/ReportSectionBuilder', () => ({
  ReportSectionBuilder: ({ initialValues, onSave, onCancel }: { initialValues?: ReportSectionInput | null; onSave: (input: ReportSectionInput) => void; onCancel: () => void }) => (
    <section aria-label="Section builder">
      <output aria-label="Section being edited">{JSON.stringify(initialValues ?? null)}</output>
      <button type="button" onClick={() => onSave(initialValues ? { ...initialValues, title: `${initialValues.title} (edited)` } : BUILT)}>Save the section</button>
      <button type="button" onClick={onCancel}>Leave the builder</button>
    </section>
  ),
}))

const { CustomReportsPage } = await import('./CustomReportsPage')

// ── Data ─────────────────────────────────────────────────────────────────────

const section = (over: Partial<ReportSection> = {}): ReportSection => ({
  id: 's1', order: 1, title: 'Incidents by priority', chartType: 'bar',
  groupByNodeId: 'n1', groupByField: 'priority', groupByGranularity: null,
  metric: 'count', metricField: null, limit: 10, sortDir: 'desc',
  nodes: [{ id: 'n1', entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 10, positionY: 20, filters: null, selectedFields: ['priority'] }],
  edges: [],
  ...over,
})

const template = (over: Partial<ReportTemplate> = {}): ReportTemplate => ({
  id: 'r1', name: 'Weekly incidents', description: 'What was opened this week', icon: null, visibility: 'private',
  scheduleEnabled: false, scheduleCron: null, scheduleRecipients: [], scheduleFormat: null, lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: { id: 'u1', name: 'Ada Admin' }, sharedWith: [],
  sections: [section(), section({ id: 's2', order: 2, title: 'Incidents per team', chartType: 'pie' })],
  ...over,
})

const TEAMS = [{ id: 't1', name: 'Network' }, { id: 't2', name: 'Service Desk' }]

const RESULT = {
  executeReport: {
    sections: [
      { sectionId: 's1', title: 'Incidents by priority', chartType: 'bar', data: '[{"label":"high","value":4}]', total: 4, error: null, errorKey: null },
      { sectionId: 's2', title: 'Incidents per team', chartType: 'pie', data: '[{"label":"Network","value":3}]', total: 3, error: null, errorKey: null },
    ],
  },
}

/** The report list answer; a stable object, as Apollo gives one. */
const listOf = (...templates: ReportTemplate[]) => ({ reportTemplates: templates })

/** `ExecuteReport` answers once it has been run (the fake gives a lazy query its data at every render). */
function answerTheRun(result: unknown = RESULT) {
  let ran = false
  apolloFinto.risposte['ExecuteReport'] = (variables?: Record<string, unknown>) => {
    if (variables) ran = true
    return ran ? result : undefined
  }
}

// ── Page helpers ─────────────────────────────────────────────────────────────

/** A report's card in the list: the nearest block around its name that has a Run button. */
function card(name: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(name)
  while (el && !within(el).queryByRole('button', { name: /Run/ })) el = el.parentElement
  return el!
}

const openMenu = async (user: ReturnType<typeof renderWithProviders>['user'], name = 'Weekly incidents') =>
  user.click(within(card(name)).getByRole('button', { name: '⋮' }))

const openReport = async (user: ReturnType<typeof renderWithProviders>['user'], name = 'Weekly incidents') =>
  user.click(within(card(name)).getByRole('button', { name: '✏ Edit' }))

const openSettings = async (user: ReturnType<typeof renderWithProviders>['user']) => {
  await openReport(user)
  await user.click(screen.getByRole('button', { name: '⚙ Settings' }))
}

/** The signed-in user, with these permissions. */
const meWith = (permissions: string[]) => ({ me: {
  id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'operator', roleName: null, permissions,
  slackId: null, emailNotifications: null, language: null, teams: [],
} })

/** The open dialog: the new report form, or a confirmation. */
const dialog = () => screen.getByRole('dialog')

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  download.file.mockReset()
  download.file.mockResolvedValue(undefined)
  for (const k of Object.keys(runErrors)) delete runErrors[k]
  rejectsLikeApollo.clear()
  apolloFinto.risposte['GetReportTemplates'] = listOf(template())
  apolloFinto.risposte['GetTeamsSlim'] = { teams: TEAMS }
  // The API gives only what the scheduler delivers to: the active Slack channels.
  apolloFinto.risposte['GetReportDeliveryChannels'] = { reportDeliveryChannels: [{ id: 'ch1', name: '#ops' }] }
  apolloFinto.risposte['GetMe'] = meWith(['report.read', 'report.write', 'report.schedule'])
})

// ── The list ─────────────────────────────────────────────────────────────────

describe('Report Builder — the list', () => {
  it('lists the reports, each with who can see it and who made it', () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(
      template(),
      template({ id: 'r2', name: 'SLA monthly', visibility: 'all', createdBy: null }),
      template({ id: 'r3', name: 'Team backlog', visibility: 'groups', createdBy: { id: 'u2', name: 'Bob Builder' } }),
    )
    renderWithProviders(<CustomReportsPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Report Builder' })).toBeInTheDocument()
    expect(screen.getByText('3 reports')).toBeInTheDocument()
    expect(within(card('Weekly incidents')).getByText('Private')).toBeInTheDocument()
    expect(within(card('Weekly incidents')).getByText('· Ada Admin')).toBeInTheDocument()
    expect(within(card('SLA monthly')).getByText('Everyone')).toBeInTheDocument()
    expect(within(card('SLA monthly')).queryByText(/^·/)).toBeNull()
    expect(within(card('Team backlog')).getByText('Groups')).toBeInTheDocument()
    expect(within(card('Team backlog')).getByText('· Bob Builder')).toBeInTheDocument()
    expect(screen.queryByText('No reports yet')).toBeNull()
  })

  it.each([
    ['with no report yet', listOf()],
    ['while the reports are still loading', undefined],
  ])('%s, it invites to create the first one', (_case, answer) => {
    apolloFinto.risposte['GetReportTemplates'] = answer
    renderWithProviders(<CustomReportsPage />)
    expect(screen.getByText('0 reports')).toBeInTheDocument()
    expect(screen.getByText('No reports yet')).toBeInTheDocument()
    expect(screen.getByText('Create your first custom report')).toBeInTheDocument()
  })

  it('a new report is created with its name, description and the teams it is shared with, then opened', async () => {
    const created = template({ id: 'r9', name: 'Change backlog', description: 'Changes waiting for CAB', sections: [] })
    const before = listOf(template())
    const after = listOf(template(), created)
    let done = false
    apolloFinto.risposte['GetReportTemplates'] = () => (done ? after : before)
    apolloFinto.esiti['CreateReportTemplate'] = { data: { createReportTemplate: { id: 'r9' } } }
    apolloFinto.refetch.mockImplementationOnce(async () => { done = true; return { data: {} } })
    const { user } = renderWithProviders(<CustomReportsPage />)

    await user.click(screen.getByRole('button', { name: 'New report' }))
    const create = within(dialog()).getByRole('button', { name: 'Create report' })
    expect(create).toBeDisabled()
    await user.type(within(dialog()).getByLabelText('Name *'), 'Change backlog')
    await user.type(within(dialog()).getByLabelText('Description'), 'Changes waiting for CAB')
    // The teams are offered only when the report is shared with groups.
    expect(within(dialog()).queryByRole('checkbox')).toBeNull()
    await user.selectOptions(within(dialog()).getByLabelText('Visibility'), 'groups')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Network' }))
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Service Desk' }))
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Network' }))
    await user.click(create)

    expect(apolloFinto.chiamata('CreateReportTemplate')).toEqual({ input: {
      name: 'Change backlog', description: 'Changes waiting for CAB', visibility: 'groups', sharedWithTeamIds: ['t2'],
    } })
    // Opened on the new report, once the list knows it.
    expect(await screen.findByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(screen.getByText('Change backlog')).toBeInTheDocument()
    expect(screen.getByText('No section. Click "+ Section" to start.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Tour of 23 Sep 2026: the list was reloaded before the dialog closed, and a
  // reload that failed kept the dialog open on a report already created — a
  // second click made a duplicate.
  it('a created report closes the dialog even when the list cannot be reloaded', async () => {
    apolloFinto.esiti['CreateReportTemplate'] = { data: { createReportTemplate: { id: 'r9' } } }
    apolloFinto.refetch.mockRejectedValueOnce(new Error('network down'))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(screen.getByRole('button', { name: 'New report' }))
    await user.type(within(dialog()).getByLabelText('Name *'), 'Everything')
    await user.click(within(dialog()).getByRole('button', { name: 'Create report' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.error).toHaveBeenCalledWith('network down')
    expect(apolloFinto.chiamate['CreateReportTemplate']).toHaveLength(1)
  })

  it('an empty description is sent as none, and a report not shared with groups is shared with no team', async () => {
    apolloFinto.esiti['CreateReportTemplate'] = { data: { createReportTemplate: { id: 'r9' } } }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(screen.getByRole('button', { name: 'New report' }))
    await user.type(within(dialog()).getByLabelText('Name *'), 'Everything')
    await user.selectOptions(within(dialog()).getByLabelText('Visibility'), 'groups')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'Network' }))
    await user.selectOptions(within(dialog()).getByLabelText('Visibility'), 'all')
    expect(within(dialog()).queryByRole('checkbox')).toBeNull()
    await user.click(within(dialog()).getByRole('button', { name: 'Create report' }))
    expect(apolloFinto.chiamata('CreateReportTemplate')).toEqual({ input: {
      name: 'Everything', description: null, visibility: 'all', sharedWithTeamIds: [],
    } })
  })

  it.each([
    ['there is no team', { teams: [] }],
    ['the teams are still loading', undefined],
  ])('shared with groups when %s: no team list to choose from', async (_case, answer) => {
    apolloFinto.risposte['GetTeamsSlim'] = answer
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(screen.getByRole('button', { name: 'New report' }))
    await user.selectOptions(within(dialog()).getByLabelText('Visibility'), 'groups')
    expect(within(dialog()).queryByText('Teams')).toBeNull()
    expect(within(dialog()).queryByRole('checkbox')).toBeNull()
  })

  it('a refused creation keeps the dialog open with what was typed', async () => {
    rejectsLikeApollo.add('CreateReportTemplate')
    apolloFinto.esiti['CreateReportTemplate'] = { error: new Error('A report with this name exists') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(screen.getByRole('button', { name: 'New report' }))
    await user.type(within(dialog()).getByLabelText('Name *'), 'Weekly incidents')
    await user.click(within(dialog()).getByRole('button', { name: 'Create report' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A report with this name exists'))
    expect(within(dialog()).getByLabelText('Name *')).toHaveValue('Weekly incidents')
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it.each([
    ['Cancel', () => within(dialog()).getByRole('button', { name: 'Cancel' })],
    ['the close button', () => within(dialog()).getByRole('button', { name: 'Close' })],
  ])('%s closes the dialog and forgets what was typed', async (_how, closer) => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(screen.getByRole('button', { name: 'New report' }))
    await user.type(within(dialog()).getByLabelText('Name *'), 'Draft')
    await user.selectOptions(within(dialog()).getByLabelText('Visibility'), 'all')
    await user.click(closer())
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'New report' }))
    expect(within(dialog()).getByLabelText('Name *')).toHaveValue('')
    expect(within(dialog()).getByLabelText('Visibility')).toHaveValue('private')
    expect(apolloFinto.chiamata('CreateReportTemplate')).toBeUndefined()
  })
})

// ── A report's menu ──────────────────────────────────────────────────────────

describe('Report Builder — a report\'s menu', () => {
  it('the ⋮ menu opens and closes, and a click elsewhere on the page closes it', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    const toggle = within(card('Weekly incidents')).getByRole('button', { name: '⋮' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '⚙ Edit settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '⧉ Duplicate' })).toBeInTheDocument()
    // A press inside the menu keeps it open.
    fireEvent.mouseDown(screen.getByRole('button', { name: '⧉ Duplicate' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(screen.queryByRole('button', { name: '⧉ Duplicate' })).toBeNull()
    await user.click(toggle)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: '⧉ Duplicate' })).toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('Duplicate copies the report on the server and says how many sections came along', async () => {
    apolloFinto.esiti['DuplicateReportTemplate'] = { data: { duplicateReportTemplate: { id: 'r2', name: 'Weekly incidents (copy)', sections: [{ id: 'x1' }, { id: 'x2' }] } } }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '⧉ Duplicate' }))
    expect(apolloFinto.chiamata('DuplicateReportTemplate')).toEqual({ id: 'r1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Report duplicated: "Weekly incidents (copy)" (2 sections)'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '⧉ Duplicate' })).toBeNull()
  })

  it('a refused duplicate is reported once, and nothing is reloaded', async () => {
    rejectsLikeApollo.add('DuplicateReportTemplate')
    apolloFinto.esiti['DuplicateReportTemplate'] = { error: new Error('Quota exceeded') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '⧉ Duplicate' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Quota exceeded'))
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('Delete asks first, and only a yes deletes', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '🗑 Delete' }))
    expect(within(dialog()).getByText('Delete the report?')).toBeInTheDocument()
    expect(within(dialog()).getByText('This action cannot be undone.')).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('DeleteReportTemplate')).toBeUndefined()

    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '🗑 Delete' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteReportTemplate')).toEqual({ id: 'r1' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused delete is reported and nothing is reloaded', async () => {
    apolloFinto.esiti['DeleteReportTemplate'] = { error: new Error('Not your report') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '🗑 Delete' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not your report'))
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    expect(screen.getByText('Weekly incidents')).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: «Edit settings» in a
  // card's menu did not select the report, so from a fresh list the page went
  // blank.
  it('Edit settings from the list opens the settings of that report', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openMenu(user)
    await user.click(screen.getByRole('button', { name: '⚙ Edit settings' }))
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: with another report
  // opened before, the settings showed under that report's name and «Save
  // settings» wrote them into it.
  it('Edit settings from the list saves into the report it was opened for', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(template(), template({ id: 'r2', name: 'SLA monthly' }))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user, 'SLA monthly')
    await user.click(screen.getByRole('button', { name: '← All reports' }))
    await openMenu(user, 'Weekly incidents')
    await user.click(screen.getByRole('button', { name: '⚙ Edit settings' }))
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ id: 'r1', input: { name: 'Weekly incidents' } })
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toMatchObject({ templateId: 'r1' }))
  })
})

// ── A report ─────────────────────────────────────────────────────────────────

describe('Report Builder — a report', () => {
  it('Edit opens the report without running it', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    expect(screen.getByText('Weekly incidents')).toBeInTheDocument()
    expect(screen.getByText('What was opened this week')).toBeInTheDocument()
    expect(screen.getAllByText('Click "▶ Run" to load the data')).toHaveLength(2)
    expect(apolloFinto.chiamate['ExecuteReport']).toBeUndefined()
  })

  it('Run in the list runs the report in the reader\'s language and opens it with the results', async () => {
    answerTheRun()
    const { user } = renderWithProviders(<CustomReportsPage />)
    await user.click(within(card('Weekly incidents')).getByRole('button', { name: '▶ Run' }))
    expect(apolloFinto.chiamata('ExecuteReport')).toEqual({ templateId: 'r1', language: 'en' })
    expect(await screen.findByRole('figure', { name: 'Incidents by priority' })).toHaveTextContent('bar: [{"label":"high","value":4}]')
    expect(screen.getByRole('figure', { name: 'Incidents per team' })).toHaveTextContent('pie: [{"label":"Network","value":3}]')
    expect(screen.queryByText('Click "▶ Run" to load the data')).toBeNull()
  })

  it('Run in the report runs it; a result that names no section is drawn nowhere', async () => {
    answerTheRun({ executeReport: { sections: [RESULT.executeReport.sections[0], { ...RESULT.executeReport.sections[1], sectionId: '' }] } })
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '▶ Run' }))
    expect(apolloFinto.chiamata('ExecuteReport')).toEqual({ templateId: 'r1', language: 'en' })
    expect(await screen.findByRole('figure', { name: 'Incidents by priority' })).toBeInTheDocument()
    expect(screen.queryByRole('figure', { name: 'Incidents per team' })).toBeNull()
    expect(screen.getAllByText('Click "▶ Run" to load the data')).toHaveLength(1)
  })

  it('a run that fails is reported, and no result is shown', async () => {
    apolloFinto.risposte['ExecuteReport'] = (variables?: Record<string, unknown>) => {
      if (variables) runErrors['ExecuteReport'] = new Error('The query timed out')
      return undefined
    }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '▶ Run' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The query timed out'))
    expect(screen.getAllByText('Click "▶ Run" to load the data')).toHaveLength(2)
  })

  it.each([
    ['↓ PDF', 'ExportReportPDF', 'exportReportPDF', '/api/reports/files/r1.pdf', 'report.pdf'],
    ['↓ Excel', 'ExportReportExcel', 'exportReportExcel', '/api/reports/files/r1.xlsx', 'report.xlsx'],
  ])('%s generates the file and downloads it through the authenticated download', async (button, mutation, field, path, fallbackName) => {
    apolloFinto.esiti[mutation] = { data: { [field]: path } }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: button }))
    expect(apolloFinto.chiamata(mutation)).toEqual({ templateId: 'r1' })
    await waitFor(() => expect(download.file).toHaveBeenCalledWith(path, fallbackName))
  })

  it.each([
    ['↓ PDF', 'ExportReportPDF'],
    ['↓ Excel', 'ExportReportExcel'],
  ])('%s: an export that produced no file downloads nothing', async (button, mutation) => {
    apolloFinto.esiti[mutation] = { data: {} }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(apolloFinto.chiamata(mutation)).toEqual({ templateId: 'r1' }))
    expect(download.file).not.toHaveBeenCalled()
  })

  it.each([
    ['↓ PDF', 'ExportReportPDF'],
    ['↓ Excel', 'ExportReportExcel'],
  ])('%s: a refused export is reported, and nothing is downloaded', async (button, mutation) => {
    apolloFinto.esiti[mutation] = { error: new Error('Export queue is full') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Export queue is full'))
    expect(download.file).not.toHaveBeenCalled()
  })

  // Found in the tour of 23 Sep 2026, fixed: Apollo 4 also REJECTS a refused
  // export once `onError` has said why, and the page left that rejection
  // unhandled.
  it.each([
    ['↓ PDF', 'ExportReportPDF'],
    ['↓ Excel', 'ExportReportExcel'],
  ])('%s: a refused export, rejected as Apollo 4 does, is said once and leaves no unhandled rejection', async (button, mutation) => {
    rejectsLikeApollo.add(mutation)
    apolloFinto.esiti[mutation] = { error: new Error('Export queue is full') }
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try {
      const { user } = renderWithProviders(<CustomReportsPage />)
      await openReport(user)
      await user.click(screen.getByRole('button', { name: button }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Export queue is full'))
      // A rejection nobody handles is reported once the running tasks are over.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(unhandled).toEqual([])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(download.file).not.toHaveBeenCalled()
  })

  it.each([
    ['an error', new Error('403 Forbidden'), 'The report could not be downloaded: 403 Forbidden'],
    ['anything else', 'offline', 'The report could not be downloaded: offline'],
  ])('a download that fails with %s says why', async (_case, failure, message) => {
    apolloFinto.esiti['ExportReportExcel'] = { data: { exportReportExcel: '/api/reports/files/r1.xlsx' } }
    download.file.mockRejectedValue(failure)
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '↓ Excel' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
  })

  it('"All reports" goes back to the list', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '← All reports' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Report Builder' })).toBeInTheDocument()
  })

  it('a new section is added to this report from the builder, which then closes', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '+ Section' }))
    expect(screen.getByText('Add a section — Weekly incidents')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Section being edited' })).toHaveTextContent('null')
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    expect(apolloFinto.chiamata('AddReportSection')).toEqual({ templateId: 'r1', input: BUILT })
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: '← All reports' })).toBeInTheDocument()
  })

  it('a refused new section keeps the builder open', async () => {
    apolloFinto.esiti['AddReportSection'] = { error: new Error('Too many sections') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '+ Section' }))
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many sections'))
    expect(screen.getByText('Add a section — Weekly incidents')).toBeInTheDocument()
  })

  it.each([
    ['Back', '← Back'],
    ['the builder\'s own cancel', 'Leave the builder'],
  ])('leaving the new section with %s adds nothing', async (_how, button) => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '+ Section' }))
    await user.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('AddReportSection')).toBeUndefined()
  })

  it('a section is edited from what is saved, and the builder closes when the update is saved', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(template({ sections: [section({
      groupByGranularity: 'month', metric: 'avg', metricField: 'resolution_minutes',
      nodes: [
        { id: 'n1', entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 10, positionY: 20, filters: '{"status":"open"}', selectedFields: ['priority'] },
        { id: 'n2', entityType: 'team', neo4jLabel: 'Team', label: 'Team', isResult: false, isRoot: false, positionX: 200, positionY: 20, filters: null, selectedFields: null as unknown as string[] },
      ],
      edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO', direction: 'out', label: 'assigned to' }],
    })] }))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getByRole('button', { name: '✏ Edit section' }))
    expect(screen.getByText('Edit section: Incidents by priority')).toBeInTheDocument()
    const saved = {
      title: 'Incidents by priority', chartType: 'bar',
      groupByNodeId: 'n1', groupByField: 'priority', groupByGranularity: 'month',
      metric: 'avg', metricField: 'resolution_minutes', limit: 10, sortDir: 'desc',
      nodes: [
        { id: 'n1', entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 10, positionY: 20, filters: '{"status":"open"}', selectedFields: ['priority'] },
        // A node saved without selected fields opens with none, not with `null`.
        { id: 'n2', entityType: 'team', neo4jLabel: 'Team', label: 'Team', isResult: false, isRoot: false, positionX: 200, positionY: 20, filters: null, selectedFields: [] },
      ],
      edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO', direction: 'out', label: 'assigned to' }],
    }
    expect(JSON.parse(screen.getByRole('status', { name: 'Section being edited' }).textContent!)).toEqual(saved)
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    expect(apolloFinto.chiamata('UpdateReportSection')).toEqual({ sectionId: 's1', input: { ...saved, title: 'Incidents by priority (edited)' } })
    expect(await screen.findByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused section update keeps the editor open on that section', async () => {
    apolloFinto.esiti['UpdateReportSection'] = { error: new Error('Invalid filter') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getAllByRole('button', { name: '✏ Edit section' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid filter'))
    expect(screen.getByText('Edit section: Incidents by priority')).toBeInTheDocument()
  })

  it.each([
    ['Back', '← Back'],
    ['the builder\'s own cancel', 'Leave the builder'],
  ])('leaving the section editor with %s saves nothing', async (_how, button) => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getAllByRole('button', { name: '✏ Edit section' })[1]!)
    expect(screen.getByText('Edit section: Incidents per team')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('UpdateReportSection')).toBeUndefined()
  })

  it('removing a section asks first, and only a yes removes it', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    expect(within(dialog()).getByText('Remove the section?')).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('RemoveReportSection')).toBeUndefined()

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('RemoveReportSection')).toEqual({ templateId: 'r1', sectionId: 's2' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused removal is reported and the section stays', async () => {
    apolloFinto.esiti['RemoveReportSection'] = { error: new Error('Section is locked') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openReport(user)
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Section is locked'))
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    expect(screen.getByText('Incidents by priority')).toBeInTheDocument()
  })
})

// ── Settings ─────────────────────────────────────────────────────────────────

describe('Report Builder — settings', () => {
  const scheduled = () => template({
    visibility: 'groups', sharedWith: [{ id: 't1', name: 'Network' }],
    scheduleEnabled: true, scheduleCron: '0 9 * * *', scheduleChannelId: 'ch1',
    scheduleRecipients: ['ops@example.com'], scheduleFormat: 'excel',
  })

  // The form maps every saved field; that the list query fetches all of them
  // is the last test of this block.
  it('open filled in with the report as it is saved, offering the channels it can be delivered to', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(scheduled())
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Weekly incidents')
    expect(screen.getByLabelText('Description')).toHaveValue('What was opened this week')
    expect(screen.getByLabelText('Visibility')).toHaveValue('groups')
    expect(screen.getByRole('checkbox', { name: 'Network' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Service Desk' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Enable scheduling' })).toBeChecked()
    expect(screen.getByLabelText('Frequency')).toHaveValue('0 9 * * *')
    const channel = screen.getByLabelText('Slack channel')
    expect(channel).toHaveValue('ch1')
    expect(within(channel).getAllByRole('option').map((o) => o.textContent)).toEqual(['No channel', '#ops'])
    expect(screen.getByRole('button', { name: 'Remove ops@example.com' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '📊 Excel' })).toBeChecked()
  })

  it('a report saved with nothing to schedule opens with the defaults', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(template({
      description: null, scheduleRecipients: undefined as unknown as string[], scheduleFormat: null,
    }))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.getByLabelText('Description')).toHaveValue('')
    expect(screen.getByLabelText('Visibility')).toHaveValue('private')
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(screen.getByLabelText('Frequency')).toHaveValue('0 9 * * *')
    expect(screen.getByLabelText('Slack channel')).toHaveValue('')
    expect(screen.getByLabelText('Email recipients')).toHaveAttribute('placeholder', 'email@example.com, Enter')
    expect(screen.getByRole('radio', { name: '📄 PDF' })).toBeChecked()
  })

  it('saving sends the report and then its schedule, and returns to the report', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Weekly incidents (EU)')
    await user.clear(screen.getByLabelText('Description'))
    await user.selectOptions(screen.getByLabelText('Visibility'), 'groups')
    await user.click(screen.getByRole('checkbox', { name: 'Service Desk' }))
    await user.click(screen.getByRole('checkbox', { name: 'Network' }))
    await user.click(screen.getByRole('checkbox', { name: 'Network' }))
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.selectOptions(screen.getByLabelText('Frequency'), '0 9 * * 1')
    await user.selectOptions(screen.getByLabelText('Slack channel'), 'ch1')

    // Recipients: Enter or a comma adds one, a repeat is not added twice,
    // × removes one, Backspace in the empty box removes the last.
    const recipients = screen.getByLabelText('Email recipients')
    await user.type(recipients, 'a@example.com{Enter}')
    await user.type(recipients, 'b@example.com,')
    await user.type(recipients, 'a@example.com{Enter}')
    await user.type(recipients, 'c@example.com{Enter}')
    expect(screen.getAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label')))
      .toEqual(['Remove a@example.com', 'Remove b@example.com', 'Remove c@example.com'])
    expect(recipients).toHaveValue('')
    expect(recipients).toHaveAttribute('placeholder', '')
    await user.click(screen.getByRole('button', { name: 'Remove b@example.com' }))
    await user.click(recipients)
    await user.keyboard('{Backspace}')
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
    // Enter on an empty box adds nothing.
    await user.keyboard('{Enter}')
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)

    await user.click(screen.getByRole('radio', { name: '📊 Excel' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toEqual({
      templateId: 'r1', enabled: true, cron: '0 9 * * 1', recipients: ['a@example.com'], format: 'excel',
    }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toEqual({ id: 'r1', input: {
      name: 'Weekly incidents (EU)', description: null, visibility: 'groups', sharedWithTeamIds: ['t2'],
      scheduleEnabled: true, scheduleCron: '0 9 * * 1', scheduleChannelId: 'ch1',
    } })
    expect(await screen.findByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a custom frequency is saved as it is typed', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Frequency'), '__custom__')
    const cron = screen.getByLabelText('Cron expression')
    expect(cron).toHaveAttribute('placeholder', '0 9 * * *')
    await user.type(cron, '30 18 * * 5')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toMatchObject({ cron: '30 18 * * 5' }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ input: { scheduleCron: '30 18 * * 5' } })
  })

  it('going back from a custom frequency to a preset saves the preset', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.selectOptions(screen.getByLabelText('Frequency'), '__custom__')
    await user.type(screen.getByLabelText('Cron expression'), '30 18 * * 5')
    await user.selectOptions(screen.getByLabelText('Frequency'), '0 9 1 * *')
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toMatchObject({ cron: '0 9 1 * *' }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ input: { scheduleCron: '0 9 1 * *' } })
  })

  it('without scheduling, no cron, channel or recipients are sent', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(scheduled())
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(screen.queryByLabelText('Frequency')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toEqual({
      templateId: 'r1', enabled: false, cron: null, recipients: [], format: 'excel',
    }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ input: {
      visibility: 'groups', sharedWithTeamIds: ['t1'], scheduleEnabled: false, scheduleCron: null, scheduleChannelId: null,
    } })
  })

  it('a scheduled report with no channel chosen sends no channel', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ input: {
      scheduleEnabled: true, scheduleCron: '0 9 * * *', scheduleChannelId: null, sharedWithTeamIds: [],
    } }))
  })

  it.each([
    ['an error', new Error('Invalid cron expression'), 'Invalid cron expression'],
    ['anything else', 'boom', 'Error while saving'],
  ])('if the schedule cannot be saved (%s), the settings stay open and say why', async (_case, failure, message) => {
    apolloFinto.esiti['UpdateReportSchedule'] = { error: failure as Error }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
    // G-23: the name was saved, the schedule was not — the form must not close as if all went well.
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
  })

  it('if the report itself cannot be saved, the settings stay open, say why, and the schedule is not sent', async () => {
    rejectsLikeApollo.add('UpdateReportTemplate')
    apolloFinto.esiti['UpdateReportTemplate'] = { error: new Error('A report with this name exists') }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A report with this name exists'))
    expect(apolloFinto.chiamata('UpdateReportSchedule')).toBeUndefined()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
  })

  it.each([
    ['Back', '← Back'],
    ['Cancel', 'Cancel'],
  ])('%s leaves the settings without saving', async (_how, button) => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.type(screen.getByLabelText('Name'), ' draft')
    await user.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toBeUndefined()
    expect(apolloFinto.chiamata('UpdateReportSchedule')).toBeUndefined()
  })

  it('with no Slack channel configured, no channel is offered, and the form says why', async () => {
    apolloFinto.risposte['GetReportDeliveryChannels'] = { reportDeliveryChannels: [] }
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(screen.queryByLabelText('Slack channel')).toBeNull()
    expect(screen.getByText(/No Slack channel to send it to/)).toBeInTheDocument()
    expect(screen.getByLabelText('Email recipients')).toBeInTheDocument()
  })

  it('while the channels are still loading, no channel is offered', async () => {
    apolloFinto.risposte['GetReportDeliveryChannels'] = undefined
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(screen.queryByLabelText('Slack channel')).toBeNull()
  })

  it('Custom with no cron typed saves nothing and says why', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.selectOptions(screen.getByLabelText('Frequency'), '__custom__')
    await user.type(screen.getByLabelText('Cron expression'), '   ')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(toast.error).toHaveBeenCalledWith('Custom frequency: type the cron expression, or choose one of the frequencies in the list.')
    expect(apolloFinto.chiamata('UpdateReportTemplate')).toBeUndefined()
    expect(apolloFinto.chiamata('UpdateReportSchedule')).toBeUndefined()
    expect(screen.getByRole('heading', { name: 'Settings — Weekly incidents' })).toBeInTheDocument()
    // Without scheduling the cron is not needed, and the rest is saved; the
    // schedule, as saved (off), is not sent again.
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportTemplate')).toMatchObject({ id: 'r1' }))
    expect(apolloFinto.chiamata('UpdateReportTemplate')!['input']).not.toHaveProperty('scheduleEnabled')
    expect(apolloFinto.chiamata('UpdateReportSchedule')).toBeUndefined()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the settings showed
  // «Every day at 9:00» whatever the saved schedule, and the frequency and the
  // custom cron carried over from the report opened before.
  it('the frequency shows the schedule the report is saved with', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(template({ scheduleEnabled: true, scheduleCron: '0 9 * * 1' }))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.getByLabelText('Frequency')).toHaveValue('0 9 * * 1')
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
  })

  it('a schedule that is none of the presets opens as Custom with its cron, and does not carry over to the next report', async () => {
    apolloFinto.risposte['GetReportTemplates'] = listOf(
      template({ scheduleEnabled: true, scheduleCron: '30 18 * * 5' }),
      template({ id: 'r2', name: 'SLA monthly', scheduleEnabled: true, scheduleCron: '0 9 1 * *' }),
    )
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.getByLabelText('Frequency')).toHaveValue('__custom__')
    expect(screen.getByLabelText('Cron expression')).toHaveValue('30 18 * * 5')
    await user.click(screen.getByRole('button', { name: '← Back' }))
    await user.click(screen.getByRole('button', { name: '← All reports' }))
    await openMenu(user, 'SLA monthly')
    await user.click(screen.getByRole('button', { name: '⚙ Edit settings' }))
    expect(screen.getByLabelText('Frequency')).toHaveValue('0 9 1 * *')
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
    await user.click(screen.getByRole('radio', { name: '📊 Excel' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateReportSchedule')).toMatchObject({ templateId: 'r2', cron: '0 9 1 * *' }))
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the list query did not
  // ask for the schedule's channel, recipients and format, so the settings
  // opened without them and saving wiped them.
  it('the settings open with the recipients and the format the report is scheduled with', async () => {
    const cache = new InMemoryCache()
    cache.writeQuery({ query: GET_REPORT_TEMPLATES, data: listOf(scheduled()) })
    // What `useQuery(GET_REPORT_TEMPLATES)` gives the page for that answer of the server.
    apolloFinto.risposte['GetReportTemplates'] = cache.readQuery({ query: GET_REPORT_TEMPLATES })
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.getByRole('button', { name: 'Remove ops@example.com' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '📊 Excel' })).toBeChecked()
    expect(screen.getByLabelText('Slack channel')).toHaveValue('ch1')
  })

  // The list now carries the recipients and the format: a reload sent between
  // the two saves could answer with the old ones after the schedule's own
  // answer, and the next save would write them back.
  it('the list is reloaded once the schedule is saved, not between the two saves', async () => {
    const sentAtReload: string[] = []
    apolloFinto.refetch.mockImplementationOnce(async () => {
      sentAtReload.push(...['UpdateReportTemplate', 'UpdateReportSchedule'].filter((name) => apolloFinto.chiamata(name)))
      return { data: {} }
    })
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByRole('button', { name: '← All reports' })
    expect(sentAtReload).toEqual(['UpdateReportTemplate', 'UpdateReportSchedule'])
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })
})

// ── What the reader may do ───────────────────────────────────────────────────
// Review of 23 Sep 2026: every control was offered to whoever could read the
// reports, and the settings always sent the schedule — the factory operator
// (report.write, no report.schedule) saw every save fail after the name was saved.

describe('Report Builder — what the reader may do', () => {
  it('who only reads reports runs them and opens them, and is offered nothing that writes', async () => {
    apolloFinto.risposte['GetMe'] = meWith(['report.read'])
    const { user } = renderWithProviders(<CustomReportsPage />)
    expect(await screen.findByText('Weekly incidents')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New report' })).toBeNull()
    expect(within(card('Weekly incidents')).queryByRole('button', { name: '⋮' })).toBeNull()
    await user.click(within(card('Weekly incidents')).getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: '← All reports' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▶ Run' })).toBeInTheDocument()
    for (const name of ['⚙ Settings', '↓ PDF', '↓ Excel', 'Add section', /Edit section/, '🗑']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    // Nor are the channels asked for: they need report.schedule.
    expect(apolloFinto.chiamate['GetReportDeliveryChannels']).toBeUndefined()
  })

  it('who edits reports but does not schedule them saves the report alone, and is told why the schedule is not here', async () => {
    apolloFinto.risposte['GetMe'] = meWith(['report.read', 'report.write'])
    apolloFinto.risposte['GetReportTemplates'] = listOf(template({ scheduleEnabled: true, scheduleCron: '0 9 * * 1' }))
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    expect(screen.queryByRole('checkbox', { name: 'Enable scheduling' })).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent('Only who can schedule reports changes it.')
    await user.type(screen.getByLabelText('Name'), ' (EU)')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('button', { name: '← All reports' })).toBeInTheDocument()
    const input = apolloFinto.chiamata('UpdateReportTemplate')!['input'] as Record<string, unknown>
    expect(input).toMatchObject({ name: 'Weekly incidents (EU)' })
    expect(input).not.toHaveProperty('scheduleEnabled')
    expect(input).not.toHaveProperty('scheduleCron')
    expect(input).not.toHaveProperty('scheduleChannelId')
    expect(apolloFinto.chiamata('UpdateReportSchedule')).toBeUndefined()
    expect(apolloFinto.chiamate['GetReportDeliveryChannels']).toBeUndefined()
  })

  it('who schedules gets the channels the scheduler delivers to', async () => {
    const { user } = renderWithProviders(<CustomReportsPage />)
    await openSettings(user)
    await user.click(screen.getByRole('checkbox', { name: 'Enable scheduling' }))
    expect(apolloFinto.chiamate['GetReportDeliveryChannels']).toBeDefined()
    expect(within(screen.getByLabelText('Slack channel')).getAllByRole('option').map((o) => o.textContent)).toEqual(['No channel', '#ops'])
  })
})
