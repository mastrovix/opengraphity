/**
 * ReportScheduleSettings — a report's name, visibility and schedule.
 *
 * The editing flows (recipients, frequency, what is saved) are tested through
 * the page in `CustomReportsPage.test.tsx`, where the hook holds the state.
 * Here are the states the page cannot produce on its own: while saving, the
 * button says so and cannot be pressed again (two saves in a row would send
 * the schedule twice); and a scheduled report that has already run says when,
 * in the reader's format and time zone — the one way to tell that the
 * schedule is actually working.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { ReportScheduleSettings } from './ReportScheduleSettings'
import type { ReportTemplate } from './useCustomReports'

type Props = Parameters<typeof ReportScheduleSettings>[0]

const template = (over: Partial<ReportTemplate> = {}): ReportTemplate => ({
  id: 'r1', name: 'Weekly incidents', description: null, icon: null, visibility: 'private',
  scheduleEnabled: true, scheduleCron: '0 9 * * 1', scheduleRecipients: [], scheduleFormat: 'pdf', lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: null, sharedWith: [], sections: [],
  ...over,
})

const props = (over: Partial<Props> = {}): Props => ({
  selected: template(), teams: [], channels: [], updating: false, canSchedule: true,
  settingsName: 'Weekly incidents', setSettingsName: vi.fn(),
  settingsDesc: '', setSettingsDesc: vi.fn(),
  settingsVis: 'private', setSettingsVis: vi.fn(),
  settingsTeamIds: [], setSettingsTeamIds: vi.fn(),
  settingsSched: true, setSettingsSched: vi.fn(),
  settingsSchedCron: '0 9 * * 1', setSettingsSchedCron: vi.fn(),
  settingsChanId: '', setSettingsChanId: vi.fn(),
  settingsRecipients: [], setSettingsRecipients: vi.fn(),
  recipientInput: '', setRecipientInput: vi.fn(),
  settingsFormat: 'pdf', setSettingsFormat: vi.fn(),
  schedulePreset: '0 9 * * 1', setSchedulePreset: vi.fn(),
  customCron: '', setCustomCron: vi.fn(),
  handleSaveSettings: vi.fn(), setView: vi.fn(),
  ...over,
})

describe('ReportScheduleSettings', () => {
  it('while saving, the save button says so and cannot be pressed again', () => {
    renderWithProviders(<ReportScheduleSettings {...props({ updating: true })} />)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull()
  })

  it('a scheduled report that has already run says when, in the reader\'s time', () => {
    renderWithProviders(<ReportScheduleSettings {...props({ selected: template({ lastScheduledRun: '2026-09-21T07:00:00Z' }) })} />)
    expect(screen.getByText('Last run: 21 Sept 2026, 09:00')).toBeInTheDocument()
  })

  it('a report that has never run says nothing about a last run', () => {
    renderWithProviders(<ReportScheduleSettings {...props()} />)
    expect(screen.queryByText(/^Last run/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })
})
