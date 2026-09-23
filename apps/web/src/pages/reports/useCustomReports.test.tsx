/**
 * useCustomReports — the state and the actions behind the Report Builder.
 *
 * The page offers an action only when there is something to act on, but the
 * hook is the last line: an export, a run, a save or a new section with no
 * report selected (or an update with no section being edited) must send
 * nothing, rather than a request with a null id that the API would refuse
 * with an obscure error. And a run asks for the values in the READER's
 * language (V-20): the grouped values come back labelled in it.
 *
 * The flows through the page are in `CustomReportsPage.test.tsx`; here are the
 * cases the page can never reach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import i18n from '@/i18n/i18n'
import { Providers } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ReportSectionInput } from '@/components/ReportSectionBuilder'
import type { ReportTemplate } from './useCustomReports'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { useCustomReports } = await import('./useCustomReports')

const REPORT: ReportTemplate = {
  id: 'r1', name: 'Weekly incidents', description: null, icon: null, visibility: 'private',
  scheduleEnabled: false, scheduleCron: null, scheduleRecipients: [], scheduleFormat: null, lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: null, sharedWith: [], sections: [],
}

const INPUT: ReportSectionInput = {
  title: 'Changes by risk', chartType: 'pie', groupByNodeId: null, groupByField: null,
  metric: 'count', metricField: null, limit: null, sortDir: null, nodes: [], edges: [],
}

const wrapper = ({ children }: { children: ReactNode }) => <Providers>{children}</Providers>

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetReportTemplates'] = { reportTemplates: [REPORT] }
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('useCustomReports — with nothing selected', () => {
  it('no export, run, save, new section or section update is sent', async () => {
    const { result } = renderHook(() => useCustomReports(), { wrapper })
    expect(result.current.selected).toBeNull()
    expect(result.current.editSection).toBeNull()
    await act(async () => {
      await result.current.handleExportPDF()
      await result.current.handleExportExcel()
      await result.current.handleSaveSettings()
      result.current.handleAddSection(INPUT)
      result.current.handleUpdateSection(INPUT)
      result.current.handleExecuteSelected()
    })
    for (const operation of ['ExportReportPDF', 'ExportReportExcel', 'UpdateReportTemplate', 'UpdateReportSchedule', 'AddReportSection', 'UpdateReportSection', 'ExecuteReport']) {
      expect(apolloFinto.chiamate[operation], operation).toBeUndefined()
    }
    expect(result.current.view).toBe('list')
  })
})

describe('useCustomReports — running a report', () => {
  it('asks for the values in the reader\'s language, from the list and from the report', async () => {
    await i18n.changeLanguage('it')
    const { result } = renderHook(() => useCustomReports(), { wrapper })
    act(() => result.current.handleExecuteAndGoToDetail(REPORT))
    expect(apolloFinto.chiamata('ExecuteReport')).toEqual({ templateId: 'r1', language: 'it' })
    expect(result.current.view).toBe('detail')
    expect(result.current.selected?.id).toBe('r1')
    act(() => result.current.handleExecuteSelected())
    expect(apolloFinto.chiamate['ExecuteReport']).toEqual([
      { templateId: 'r1', language: 'it' },
      { templateId: 'r1', language: 'it' },
    ])
  })

  it('a run that comes back without a list of sections shows no result, and the report stays open', () => {
    const empty = { executeReport: { sections: null } }
    let ran = false
    apolloFinto.risposte['ExecuteReport'] = (variables?: Record<string, unknown>) => {
      if (variables) ran = true
      return ran ? empty : undefined
    }
    const { result } = renderHook(() => useCustomReports(), { wrapper })
    act(() => result.current.handleExecuteAndGoToDetail(REPORT))
    expect(apolloFinto.chiamata('ExecuteReport')).toEqual({ templateId: 'r1', language: 'en' })
    expect(result.current.sectionResults).toEqual({})
    expect(result.current.view).toBe('detail')
    expect(result.current.selected?.id).toBe('r1')
  })
})
