/**
 * ReportListView — the cards of the reports and the «new report» dialog.
 *
 * The flows (create, duplicate, delete, open) are tested through the page in
 * `CustomReportsPage.test.tsx`. Here are the two things this view decides on
 * its own and the page cannot show: while a report is being created, the
 * button says so and cannot be pressed again (a double click must not create
 * two reports); and a visibility the web does not know is shown by its name
 * and reported to the developer, instead of being painted as «Private».
 */
import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { ReportListView } from './ReportListView'
import type { ReportTemplate } from './useCustomReports'

type Props = Parameters<typeof ReportListView>[0]

const template = (over: Partial<ReportTemplate> = {}): ReportTemplate => ({
  id: 'r1', name: 'Weekly incidents', description: null, icon: null, visibility: 'private',
  scheduleEnabled: false, scheduleCron: null, scheduleRecipients: [], scheduleFormat: null, lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: null, sharedWith: [], sections: [],
  ...over,
})

const props = (over: Partial<Props> = {}): Props => ({
  templates: [template()], teams: [], menuRef: createRef<HTMLDivElement>(), menuOpenId: null, setMenuOpenId: vi.fn(),
  showNewDialog: false, setShowNewDialog: vi.fn(),
  newName: '', setNewName: vi.fn(), newDesc: '', setNewDesc: vi.fn(), newVis: 'private', setNewVis: vi.fn(),
  newTeamIds: [], setNewTeamIds: vi.fn(), creating: false,
  goToDetail: vi.fn(), handleExecuteAndGoToDetail: vi.fn(), openSettings: vi.fn(), duplicateTemplate: vi.fn(),
  handleDeleteTemplate: vi.fn(), handleCreateTemplate: vi.fn(), resetNew: vi.fn(),
  ...over,
})

describe('ReportListView — the new report dialog', () => {
  it('while the report is being created, the button says so and cannot be pressed again', () => {
    renderWithProviders(<ReportListView {...props({ showNewDialog: true, newName: 'Change backlog', creating: true })} />)
    const dialog = screen.getByRole('dialog', { name: 'New report' })
    expect(within(dialog).getByRole('button', { name: 'Creating...' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Create report' })).toBeNull()
  })

  it('once the report has a name and nothing is under way, Create sends it', async () => {
    const p = props({ showNewDialog: true, newName: 'Change backlog' })
    const { user } = renderWithProviders(<ReportListView {...p} />)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create report' }))
    expect(p.handleCreateTemplate).toHaveBeenCalledTimes(1)
  })
})

describe('ReportListView — a card', () => {
  it('a visibility the web does not know is shown by its name and reported to the developer', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<ReportListView {...props({ templates: [template({ visibility: 'partners' })] })} />)
    expect(screen.getByText('partners')).toBeInTheDocument()
    expect(screen.queryByText('Private')).toBeNull()
    expect(logged).toHaveBeenCalledWith('[VIS_COLORS] unknown value: "partners"')
    expect(logged).toHaveBeenCalledWith('[VIS_LABEL_KEYS] unknown value: "partners"')
  })
})
