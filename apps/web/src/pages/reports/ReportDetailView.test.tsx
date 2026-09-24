/**
 * ReportDetailView — one report: its sections, and the way into the section builder.
 *
 * What this view decides on its own: the order of the sections (the saved
 * `order`, not the order the API lists them in), the NAME of each chart type
 * (a person reads «Vertical bars», not «bar»), which sections have a result
 * to draw and which invite to run, and how the grouped values of a drawn
 * section are labelled — as the customer names them (the workflow's step
 * labels for a ticket status, the Dictionary for a vocabulary field), looked
 * up on the type of the node the section groups by. It also shows when a run
 * or an export is under way, so they are not started twice.
 *
 * The chart is a stand-in (ECharts draws on a canvas): it shows what the view
 * hands to it — the result's title and type, the section's period, and each
 * value through the label function.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { ReportSectionInput } from '@/components/ReportSectionBuilder'
import type { ReportSection, ReportTemplate, SectionResult } from './useCustomReports'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

vi.mock('@/components/ReportChartRenderer', () => ({
  ReportChartRenderer: ({ title, chartType, data, error, errorKey, valueLabel, granularita }: {
    title: string; chartType: string; data: string; error?: string | null; errorKey?: string | null
    valueLabel?: (value: string) => string; granularita?: string | null
  }) => (
    <figure aria-label={title}>
      <figcaption>{`${chartType} · ${granularita ?? 'no period'}`}</figcaption>
      {error
        ? <p role="alert">{`${errorKey ?? 'no key'} · ${error}`}</p>
        : <ul>{(JSON.parse(data) as Array<{ label: string; value: number }>).map((p) => (
          <li key={p.label}>{`${valueLabel ? valueLabel(p.label) : p.label}: ${p.value}`}</li>
        ))}</ul>}
    </figure>
  ),
}))

const BUILT: ReportSectionInput = vi.hoisted(() => ({
  title: 'Changes by risk', chartType: 'pie', groupByNodeId: null, groupByField: null,
  metric: 'count', metricField: null, limit: null, sortDir: null, nodes: [], edges: [],
}))
vi.mock('@/components/ReportSectionBuilder', () => ({
  ReportSectionBuilder: ({ initialValues, onSave, onCancel }: { initialValues?: ReportSectionInput | null; onSave: (input: ReportSectionInput) => void; onCancel: () => void }) => (
    <section aria-label="Section builder">
      <output aria-label="Section being edited">{initialValues?.title ?? 'a new section'}</output>
      <button type="button" onClick={() => onSave(BUILT)}>Save the section</button>
      <button type="button" onClick={onCancel}>Leave the builder</button>
    </section>
  ),
}))

const { ReportDetailView } = await import('./ReportDetailView')

type Props = Parameters<typeof ReportDetailView>[0]

// ── Data ─────────────────────────────────────────────────────────────────────

const section = (over: Partial<ReportSection> = {}): ReportSection => ({
  id: 's1', order: 1, title: 'Alpha', chartType: 'bar',
  groupByNodeId: 'n1', groupByField: 'priority', groupByGranularity: null,
  metric: 'count', metricField: null, limit: null, sortDir: null,
  nodes: [{ id: 'n1', entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: null, selectedFields: [] }],
  edges: [],
  ...over,
})

const template = (over: Partial<ReportTemplate> = {}): ReportTemplate => ({
  id: 'r1', name: 'Weekly incidents', description: 'What was opened this week', icon: null, visibility: 'private',
  scheduleEnabled: false, scheduleCron: null, scheduleRecipients: [], scheduleFormat: null, lastScheduledRun: null,
  createdAt: '2026-09-01T08:00:00Z', createdBy: null, sharedWith: [], sections: [section()],
  ...over,
})

const result = (over: Partial<SectionResult> = {}): SectionResult => ({
  sectionId: 's1', title: 'Alpha (run)', chartType: 'bar', data: '[{"label":"high","value":4}]', total: 4, error: null, errorKey: null,
  ...over,
})

const props = (over: Partial<Props> = {}): Props => ({
  view: 'detail', selected: template(), editSection: null, sectionResults: {},
  execLoading: false, exportingPDF: false, exportingExcel: false, canWrite: true,
  setView: vi.fn(), openSettings: vi.fn(),
  handleAddSection: vi.fn(), handleUpdateSection: vi.fn(), handleRemoveSection: vi.fn(),
  startEditSection: vi.fn(), cancelEditSection: vi.fn(),
  sectionToInput: vi.fn((s: ReportSection) => ({ ...BUILT, title: `${s.title} as saved` })),
  handleExecuteSelected: vi.fn(), handleExportPDF: vi.fn(), handleExportExcel: vi.fn(),
  ...over,
})

/** A section's block: its header (the nearest element around the title with the edit button) and the body below it. */
function sectionBlock(title: string): HTMLElement {
  let header: HTMLElement | null = screen.getByText(title)
  while (header && !within(header).queryByRole('button', { name: '✏ Edit section' })) header = header.parentElement
  return header!.parentElement!
}

beforeEach(() => {
  apolloFinto.reset()
})

// ── The report ───────────────────────────────────────────────────────────────

describe('ReportDetailView — the report', () => {
  it('names the report and its description, and each button reaches its action', async () => {
    const p = props()
    const { user } = renderWithProviders(<ReportDetailView {...p} />)
    expect(screen.getByText('Weekly incidents')).toBeInTheDocument()
    expect(screen.getByText('What was opened this week')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '⚙ Settings' }))
    expect(p.openSettings).toHaveBeenCalledWith(p.selected)
    await user.click(screen.getByRole('button', { name: '▶ Run' }))
    expect(p.handleExecuteSelected).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '↓ PDF' }))
    expect(p.handleExportPDF).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '↓ Excel' }))
    expect(p.handleExportExcel).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '+ Section' }))
    expect(p.setView).toHaveBeenLastCalledWith('add-section')
    await user.click(screen.getByRole('button', { name: '← All reports' }))
    expect(p.setView).toHaveBeenLastCalledWith('list')
  })

  it('a report without a description shows its name alone', () => {
    renderWithProviders(<ReportDetailView {...props({ selected: template({ description: null }) })} />)
    expect(screen.getByText('Weekly incidents')).toBeInTheDocument()
    expect(screen.queryByText('What was opened this week')).toBeNull()
  })

  it('while a run or an export is under way, its button says so and cannot be pressed again', () => {
    renderWithProviders(<ReportDetailView {...props({ execLoading: true, exportingPDF: true, exportingExcel: true })} />)
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '▶ Run' })).toBeNull()
    const waiting = screen.getAllByRole('button', { name: '…' })
    expect(waiting).toHaveLength(2)
    for (const button of waiting) expect(button).toBeDisabled()
  })

  it('when nothing is under way, run and exports can be pressed', () => {
    renderWithProviders(<ReportDetailView {...props()} />)
    expect(screen.getByRole('button', { name: '▶ Run' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '↓ PDF' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '↓ Excel' })).toBeEnabled()
  })

  it('with no section, it says how to add the first one', () => {
    renderWithProviders(<ReportDetailView {...props({ selected: template({ sections: [] }) })} />)
    expect(screen.getByText('No section. Click "+ Section" to start.')).toBeInTheDocument()
  })
})

// ── The sections ─────────────────────────────────────────────────────────────

describe('ReportDetailView — the sections', () => {
  const three = () => template({ sections: [
    section({ id: 'c', order: 3, title: 'Gamma', chartType: 'top_n' }),
    section({ id: 'a', order: 1, title: 'Alpha', chartType: 'bar' }),
    section({ id: 'b', order: 2, title: 'Beta', chartType: 'sankey' }),
  ] })

  it('are listed in their saved order, each with the name of its chart type', () => {
    renderWithProviders(<ReportDetailView {...props({ selected: three() })} />)
    expect(screen.getAllByText(/^(Alpha|Beta|Gamma)$/).map((e) => e.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(within(sectionBlock('Alpha')).getByText('Vertical bars')).toBeInTheDocument()
    expect(within(sectionBlock('Gamma')).getByText('Top N')).toBeInTheDocument()
    // A chart type the web does not know is shown by its name, not hidden.
    expect(within(sectionBlock('Beta')).getByText('sankey')).toBeInTheDocument()
  })

  it('each can be edited or removed, and says which', async () => {
    const p = props({ selected: three() })
    const { user } = renderWithProviders(<ReportDetailView {...p} />)
    await user.click(within(sectionBlock('Beta')).getByRole('button', { name: '✏ Edit section' }))
    expect(p.startEditSection).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', title: 'Beta' }))
    await user.click(within(sectionBlock('Gamma')).getByRole('button', { name: '🗑' }))
    expect(p.handleRemoveSection).toHaveBeenCalledWith('r1', 'c')
  })

  it('a section with a result is drawn with the result and the period of the section; one without invites to run', () => {
    const selected = template({ sections: [
      section({ id: 'a', title: 'Alpha', groupByGranularity: 'month' }),
      section({ id: 'b', order: 2, title: 'Beta' }),
    ] })
    renderWithProviders(<ReportDetailView {...props({ selected, sectionResults: { a: result({ sectionId: 'a', title: 'Alpha this month', chartType: 'line' }) } })} />)
    const chart = within(sectionBlock('Alpha')).getByRole('figure', { name: 'Alpha this month' })
    expect(within(chart).getByText('line · month')).toBeInTheDocument()
    expect(within(chart).getByText('high: 4')).toBeInTheDocument()
    expect(within(sectionBlock('Beta')).getByText('Click "▶ Run" to load the data')).toBeInTheDocument()
    expect(within(sectionBlock('Beta')).queryByRole('figure')).toBeNull()
  })

  it('a section that failed hands its error and its translation key to the chart', () => {
    renderWithProviders(<ReportDetailView {...props({ sectionResults: { s1: result({ error: 'Neo4j timed out', errorKey: 'reportErrors.timeout' }) } })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('reportErrors.timeout · Neo4j timed out')
  })
})

// ── How the values are labelled ──────────────────────────────────────────────

describe('ReportDetailView — the grouped values', () => {
  const step = (name: string, label: string) => ({
    id: name, name, label, labels: [], type: 'standard', isInitial: false, isTerminal: false, isOpen: true,
    category: null, purpose: null, order: 1,
  })

  it('a ticket status reads as the workflow names its steps (the type comes from the node\'s Neo4j label)', () => {
    const workflow = { workflowDefinition: { steps: [step('in_progress', 'Being worked on')], transitions: [] } }
    apolloFinto.risposte['GetWorkflowDefinition'] = (v?: Record<string, unknown>) => (v?.['entityType'] === 'service_request' ? workflow : undefined)
    const selected = template({ sections: [section({
      groupByNodeId: 'n1', groupByField: 'status',
      nodes: [{ id: 'n1', entityType: 'ServiceRequest', neo4jLabel: 'ServiceRequest', label: 'Service request', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: null, selectedFields: [] }],
    })] })
    renderWithProviders(<ReportDetailView {...props({ selected, sectionResults: { s1: result({ data: '[{"label":"in_progress","value":3},{"label":"parked","value":1}]' }) } })} />)
    expect(screen.getByText('Being worked on: 3')).toBeInTheDocument()
    // A value the workflow does not know stays as it is: it is the real data.
    expect(screen.getByText('parked: 1')).toBeInTheDocument()
  })

  it('a CI field with a vocabulary reads as the Dictionary names its values', () => {
    apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [{ name: 'environment', enumTypeName: 'environment' }] }] }
    const vocabularies: DomainVocabularies = {
      valuesOf: () => null, colorOf: () => null, entriesOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
      labelOf: (name, value) => (name === 'environment' && value === 'production' ? 'Production' : null),
    }
    const selected = template({ sections: [section({
      groupByNodeId: 'n1', groupByField: 'environment',
      nodes: [{ id: 'n1', entityType: 'server', neo4jLabel: 'Server', label: 'Server', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: null, selectedFields: [] }],
    })] })
    const withVocabularies = (children: ReactNode) => <DomainVocabularyContext.Provider value={vocabularies}>{children}</DomainVocabularyContext.Provider>
    renderWithProviders(withVocabularies(<ReportDetailView {...props({ selected, sectionResults: { s1: result({ data: '[{"label":"production","value":5},{"label":"lab","value":2}]' }) } })} />))
    expect(screen.getByText('Production: 5')).toBeInTheDocument()
    expect(screen.getByText('lab: 2')).toBeInTheDocument()
  })

  it.each([
    ['groups by no node', null],
    ['groups by a node that is not among its nodes', 'n-gone'],
  ])('a section that %s shows the values as they are', (_case, groupByNodeId) => {
    const selected = template({ sections: [section({ groupByNodeId, groupByField: 'status' })] })
    renderWithProviders(<ReportDetailView {...props({ selected, sectionResults: { s1: result({ data: '[{"label":"in_progress","value":2}]' }) } })} />)
    expect(screen.getByText('in_progress: 2')).toBeInTheDocument()
    // No type to look up: no workflow is asked for.
    expect(apolloFinto.chiamate['GetWorkflowDefinition']).toBeUndefined()
  })
})

// ── The section builder ──────────────────────────────────────────────────────

describe('ReportDetailView — the section builder', () => {
  it('a new section: the builder starts empty and saves into this report; Back and its cancel return to the report', async () => {
    const p = props({ view: 'add-section' })
    const { user } = renderWithProviders(<ReportDetailView {...p} />)
    expect(screen.getByText('Add a section — Weekly incidents')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Section being edited' })).toHaveTextContent('a new section')
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    expect(p.handleAddSection).toHaveBeenCalledWith(BUILT)
    await user.click(screen.getByRole('button', { name: '← Back' }))
    await user.click(screen.getByRole('button', { name: 'Leave the builder' }))
    expect(p.setView).toHaveBeenCalledTimes(2)
    expect(p.setView).toHaveBeenNthCalledWith(1, 'detail')
    expect(p.setView).toHaveBeenNthCalledWith(2, 'detail')
  })

  it('a section being edited: the builder starts from the section as saved and saves through the update', async () => {
    const editing = section({ id: 's1', title: 'Alpha' })
    const p = props({ view: 'edit-section', editSection: editing })
    const { user } = renderWithProviders(<ReportDetailView {...p} />)
    expect(screen.getByText('Edit section: Alpha')).toBeInTheDocument()
    expect(p.sectionToInput).toHaveBeenCalledWith(editing)
    expect(screen.getByRole('status', { name: 'Section being edited' })).toHaveTextContent('Alpha as saved')
    await user.click(screen.getByRole('button', { name: 'Save the section' }))
    expect(p.handleUpdateSection).toHaveBeenCalledWith(BUILT)
    await user.click(screen.getByRole('button', { name: '← Back' }))
    await user.click(screen.getByRole('button', { name: 'Leave the builder' }))
    expect(p.cancelEditSection).toHaveBeenCalledTimes(2)
    expect(p.handleAddSection).not.toHaveBeenCalled()
  })

  it('an edit with no section to edit shows the report instead of an empty builder', () => {
    renderWithProviders(<ReportDetailView {...props({ view: 'edit-section', editSection: null })} />)
    expect(screen.queryByRole('region', { name: 'Section builder' })).toBeNull()
    expect(screen.getByRole('button', { name: '← All reports' })).toBeInTheDocument()
  })
})
