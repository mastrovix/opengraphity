/**
 * THE REPORT SECTION BUILDER — the four-step wizard that designs one section
 * of a custom report: what to analyse, the graph of linked entities with
 * their filters, how to show it, and the title.
 *
 * What a user relies on, and what these tests pin:
 * - the steps only move forward when the section can work (an entity chosen,
 *   no entity left unconnected, a date to plot a trend on, a title);
 * - «Connect to…» links the new entity in the direction of the relationship
 *   (a link walked backwards is a report that never finds anything);
 * - the preview follows EVERYTHING the section will send, columns included;
 * - what is saved is what the server expects: a table sends no measure, the
 *   period only when grouping by a date, and each filter value in the shape
 *   of its field (a number for a number, a list for «is one of»), otherwise
 *   the report stays silently empty;
 * - a saved section reopens as it was, and one with corrupt filters is not
 *   opened at all (saving it would drop the filters without a word);
 * - an AI proposal lands in the builder exactly like a section built by hand.
 *
 * React Flow needs a layout jsdom does not have. The shims below are the ones
 * React Flow documents for jsdom: a ResizeObserver that reports a size (after
 * the commit, like a browser), `DOMMatrixReadOnly`, and non-zero element sizes.
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ReportSectionInput } from './ReportSectionBuilder'

/** Lazy queries still waiting for the server. */
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione, apolloFinto: fake } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  type Doc = Parameters<typeof base.useQuery>[0]
  return {
    ...base,
    // A lazy query keeps its last answer, like Apollo: nothing until it runs.
    useLazyQuery: (doc: Doc) => {
      const nome = nomeOperazione(doc)
      const [data, setData] = useState<unknown>(undefined)
      const run = async (o: { variables?: Record<string, unknown> } = {}) => {
        ;(fake.chiamate[nome] ??= []).push(o.variables)
        const r = fake.risposte[nome]
        const d = typeof r === 'function' ? (r as (v?: Record<string, unknown>) => unknown)(o.variables) : r
        setData(d)
        return { data: d }
      }
      return [run, { data, loading: inFlight.has(nome), called: data !== undefined }]
    },
  }
})
vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="chart" /> }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ReportSectionBuilder } = await import('./ReportSectionBuilder')

// ── jsdom shims for React Flow ──────────────────────────────────────────────

const originalResizeObserver = globalThis.ResizeObserver
beforeAll(() => {
  class MeasuringResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => {
        this.cb([{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      })
    }
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnlyShim {
    m22: number
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1]
      this.m22 = scale !== undefined ? Number(scale) : 1
    }
  }
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = MeasuringResizeObserver
  ;(window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyShim
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.height) || 1 } },
    offsetWidth: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.width) || 1 } },
  })
})
afterAll(() => {
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = originalResizeObserver
  delete (window as unknown as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
})

// ── Fixtures ────────────────────────────────────────────────────────────────

const fld = (name: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ name, label: name, labelKey: null, fieldType, enumValues: [], ...extra })

const INCIDENT_FIELDS = [
  fld('status', 'enum', { label: 'Status', enumValues: ['new', 'closed'] }),
  fld('priority_score', 'number', { label: 'Priority score' }),
  fld('is_major', 'boolean', { label: 'Major' }),
  fld('created_at', 'datetime', { label: 'Created' }),
  fld('title', 'string', { label: 'Title' }),
  fld('cost', 'number', { label: 'Cost' }),
]

const ENTITIES = [
  { entityType: 'Incident', label: 'Incident', labelKey: null, neo4jLabel: 'Incident', group: 'itsm', fields: INCIDENT_FIELDS, relations: [] },
  { entityType: 'Change', label: 'Change', labelKey: null, neo4jLabel: 'Change', group: 'itsm', fields: [fld('title', 'string', { label: 'Title' })], relations: [] },
  { entityType: 'Team', label: 'Team (api)', labelKey: 'reportBuilder.entity.team', neo4jLabel: 'Team', group: 'organization', fields: [fld('name', 'string', { label: 'Team name' })], relations: [] },
  { entityType: 'Server', label: 'Server', labelKey: null, neo4jLabel: 'Server', group: 'cmdb', fields: [fld('name', 'string', { label: 'Server name' }), fld('os', 'string', { label: 'OS' })], relations: [] },
]

const REACHABLE: Record<string, unknown[]> = {
  Incident: [
    { entityType: 'Team', label: 'Team (api)', labelKey: 'reportBuilder.entity.team', neo4jLabel: 'Team', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', count: 3, fields: [] },
    { entityType: 'Server', label: 'Server', labelKey: null, neo4jLabel: 'Server', relationshipType: 'AFFECTS', direction: 'incoming', count: 7, fields: [] },
  ],
  Team: [],
}

const KPI_PREVIEW = { sectionId: 'preview', title: 'Preview', chartType: 'kpi', data: '{"value": 42}', total: 42, error: null }

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.error.mockReset()
  apolloFinto.risposte['GetNavigableEntities'] = { navigableEntities: ENTITIES }
  apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { reportDesigner: true } } }
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active', 'retired'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production', 'test'] },
  ] } }
  apolloFinto.risposte['GetReachableEntities'] = (v?: Record<string, unknown>) => ({ reachableEntities: REACHABLE[String(v?.['fromNeo4jLabel'])] ?? [] })
  apolloFinto.risposte['PreviewReportSection'] = { previewReportSection: KPI_PREVIEW }
  // Node ids come from the clock: a clock that always moves keeps them distinct.
  let now = Date.UTC(2026, 8, 23, 10, 0, 0)
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
  // A connected entity is placed at a random offset: keep it in the middle.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function mount(initialValues?: ReportSectionInput | null) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  const r = renderWithProviders(<ReportSectionBuilder onSave={onSave} onCancel={onCancel} initialValues={initialValues} />)
  return { ...r, onSave, onCancel }
}
type User = ReturnType<typeof mount>['user']

const nextButton = () => screen.getByRole('button', { name: 'Next' })
const backButton = () => screen.getByRole('button', { name: 'Back' })
const saveButton = () => screen.getByRole('button', { name: 'Save section' })
const stepButton = (name: string) => screen.getByRole('button', { name })

/** The graph node whose header reads `label` (React Flow draws it once measured). */
function graphNode(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node'))
    .find((n) => n.querySelector('.node-drag-handle span')?.textContent === label)
  if (!found) throw new Error(`No graph node «${label}»`)
  return found
}
const nodeLabels = () => Array.from(document.querySelectorAll('.react-flow__node .node-drag-handle > span:first-child')).map((s) => s.textContent)
const nodeReady = (label: string) => waitFor(() => expect(within(graphNode(label)).getByRole('button', { name: '+ filter' })).toBeInTheDocument())

async function chooseRoot(user: User, name: string) {
  await user.click(screen.getByRole('button', { name }))
  await waitFor(() => expect(nextButton()).toBeEnabled())
}

/** Step 1 → 2 with `root` as the entity analysed. */
async function toGraph(user: User, root = 'Incident') {
  await chooseRoot(user, root)
  await user.click(nextButton())
  await nodeReady(root)
}

async function connect(user: User, from: string, to: string) {
  await user.click(within(graphNode(from)).getByRole('button', { name: '+ Connect to...' }))
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${to}`) }))
  await nodeReady(to)
}

async function toDisplay(user: User) {
  await user.click(nextButton())
  await screen.findByText('How do you want to see the data?')
}

async function toTitle(user: User) {
  await user.click(nextButton())
  await screen.findByText('Name the section')
}

/**
 * The star sits in the node's drag handle, where React Flow's drag (d3-drag)
 * listens to the native mousedown and reads `event.view`, which user-event's
 * mouse events do not carry in jsdom. The star reacts to the click alone.
 */
function clickStar(label: string, name: 'Include in the result' | 'Remove from the result') {
  fireEvent.click(within(graphNode(label)).getByRole('button', { name }))
}

const chartTypeButton = (name: RegExp) => screen.getByRole('button', { name })
/**
 * The preview runs 500 ms after the last change. On a loaded CI runner that
 * can take longer than the default second of `waitFor`: waits on the preview
 * get more room (they still end as soon as it runs).
 */
const PREVIEW = { timeout: 10_000 }
const lastPreview = () => apolloFinto.chiamata('PreviewReportSection') as { input: ReportSectionInput; language: string } | undefined
const saved = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls.at(-1)![0] as ReportSectionInput

/** A section as the server stores it: root Incident linked to Team. */
function savedSection(over: Partial<ReportSectionInput> = {}): ReportSectionInput {
  return {
    title: 'Incidents per team', chartType: 'bar', groupByNodeId: 'n2', groupByField: 'name', groupByGranularity: null,
    metric: 'count', metricField: null, limit: 15, sortDir: 'ASC',
    nodes: [
      { id: 'n1', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 300, positionY: 80, filters: null, selectedFields: [] },
      { id: 'n2', entityType: 'Team', neo4jLabel: 'Team', label: 'Team', isResult: true, isRoot: false, positionX: 300, positionY: 280, filters: null, selectedFields: [] },
    ],
    edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' }],
    ...over,
  }
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

describe('step 1 — what to analyse', () => {
  it('Next waits for an entity; the chosen one is shown pressed; the later steps are not reachable yet', async () => {
    const { user } = mount()
    expect(stepButton('What to analyse')).toHaveAttribute('aria-current', 'step')
    expect(stepButton('Graph and filters')).toBeDisabled()
    expect(stepButton('Title and save')).toBeDisabled()
    expect(nextButton()).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    await chooseRoot(user, 'Incident')
    expect(screen.getByRole('button', { name: 'Incident' })).toHaveAttribute('aria-pressed', 'true')
    // A product entity reads in the user's language, not with the API label.
    expect(screen.getByRole('button', { name: 'Team' })).toBeInTheDocument()
  })

  it('offers the AI designer only when it is switched on for the organization', () => {
    const { unmount } = mount()
    expect(screen.getByText('Describe the report and I will design it')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Design it with AI' })).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { reportDesigner: false } } }
    const off = mount()
    expect(screen.queryByRole('button', { name: 'Design it with AI' })).not.toBeInTheDocument()
    off.unmount()
    // Not known yet: neither the button nor a warning, rather than a guess.
    apolloFinto.risposte['GetAISettings'] = undefined
    mount()
    expect(screen.queryByRole('button', { name: 'Design it with AI' })).not.toBeInTheDocument()
  })

  it('choosing another entity starts the graph over from it', async () => {
    const { user } = mount()
    await toGraph(user, 'Incident')
    await connect(user, 'Incident', 'Team')
    await user.click(stepButton('What to analyse'))
    await chooseRoot(user, 'Change')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toHaveAttribute('aria-pressed', 'true'))
    await user.click(nextButton())
    await nodeReady('Change')
    expect(nodeLabels()).toEqual(['Change'])
  })
})

// ── Step 2 ──────────────────────────────────────────────────────────────────

describe('step 2 — the graph and its filters', () => {
  it('the root node is marked, part of the result and cannot be removed; the hint explains how to go on', async () => {
    const { user } = mount()
    await toGraph(user)
    const root = graphNode('Incident')
    expect(within(root).getByText('Root')).toBeInTheDocument()
    expect(within(root).getByRole('button', { name: 'Remove from the result' })).toBeInTheDocument()
    expect(within(root).queryByRole('button', { name: /Remove «Incident»/ })).not.toBeInTheDocument()
    expect(screen.getByText(/on a node to add the linked entities/)).toBeInTheDocument()
    expect(stepButton('What to analyse')).toBeEnabled()
    expect(nextButton()).toBeEnabled()
  })

  it('«Connect to…» lists what can be reached, with the direction and how many there are', async () => {
    const { user } = mount()
    await toGraph(user)
    await user.click(within(graphNode('Incident')).getByRole('button', { name: '+ Connect to...' }))
    expect(apolloFinto.chiamata('GetReachableEntities')).toEqual({ fromNeo4jLabel: 'Incident' })
    const team = await screen.findByRole('button', { name: /^Team/ })
    expect(team).toHaveTextContent('Team→ ASSIGNED_TO_TEAM3')
    expect(screen.getByRole('button', { name: /^Server/ })).toHaveTextContent('Server← AFFECTS7')
    // The row lights up under the pointer.
    await user.hover(team)
    expect(team).toHaveStyle({ background: 'var(--color-brand-light)' })
    await user.unhover(team)
    expect(team).not.toHaveStyle({ background: 'var(--color-brand-light)' })
  })

  it('an outgoing relationship links the entity it was added from to the new one; an incoming one the other way round', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    await connect(user, 'Incident', 'Server')
    expect(nodeLabels()).toEqual(['Incident', 'Team', 'Server'])
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    const { nodes, edges } = saved(onSave)
    const id = (label: string) => nodes.find((n) => n.label === label)!.id
    expect(edges).toEqual([
      { id: expect.stringMatching(/^edge_/), sourceNodeId: id('Incident'), targetNodeId: id('Team'), relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' },
      { id: expect.stringMatching(/^edge_/), sourceNodeId: id('Server'), targetNodeId: id('Incident'), relationshipType: 'AFFECTS', direction: 'outgoing', label: '← AFFECTS' },
    ])
    // The new entities are placed below the one they were added from, and are not in the result.
    expect(nodes.find((n) => n.label === 'Team')).toMatchObject({ positionX: 300, positionY: 280, isRoot: false, isResult: false, entityType: 'Team' })
  })

  it('an entity with nothing to reach says so, and the panel closes with its ×', async () => {
    const { user } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    await user.click(within(graphNode('Team')).getByRole('button', { name: '+ Connect to...' }))
    expect(await screen.findByText('No connection found')).toBeInTheDocument()
    const panel = screen.getByText('No connection found').parentElement as HTMLElement
    await user.click(within(panel).getAllByRole('button')[0]!)
    expect(screen.queryByText('No connection found')).not.toBeInTheDocument()
  })

  it('Back on the graph returns to the first step, where the entity stays chosen', async () => {
    const { user } = mount()
    await toGraph(user)
    await user.click(backButton())
    expect(stepButton('What to analyse')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: 'Incident' })).toHaveAttribute('aria-pressed', 'true')
    expect(nextButton()).toBeEnabled()
  })

  it('no answer about the reachable entities reads as «no connection», not as an error', async () => {
    apolloFinto.risposte['GetReachableEntities'] = () => undefined
    const { user } = mount()
    await toGraph(user)
    await user.click(within(graphNode('Incident')).getByRole('button', { name: '+ Connect to...' }))
    expect(await screen.findByText('No connection found')).toBeInTheDocument()
  })

  it('while the reachable entities load, the panel says it is loading', async () => {
    inFlight.add('GetReachableEntities')
    const { user } = mount()
    await toGraph(user)
    await user.click(within(graphNode('Incident')).getByRole('button', { name: '+ Connect to...' }))
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
  })

  it('the star puts an entity in the result and takes it out again', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    clickStar('Team', 'Include in the result')
    expect(within(graphNode('Team')).getByRole('button', { name: 'Remove from the result' })).toBeInTheDocument()
    await toDisplay(user)
    // In the result, the entity can be grouped by.
    expect(within(screen.getByRole('combobox', { name: 'Group by: node' })).getByRole('option', { name: 'Team' })).toBeInTheDocument()
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave).nodes.find((n) => n.label === 'Team')!.isResult).toBe(true)
    // …and out again: no longer offered for grouping, saved out of the result.
    await user.click(stepButton('Graph and filters'))
    await nodeReady('Team')
    clickStar('Team', 'Remove from the result')
    expect(within(graphNode('Team')).getByRole('button', { name: 'Include in the result' })).toBeInTheDocument()
    await toDisplay(user)
    expect(within(screen.getByRole('combobox', { name: 'Group by: node' })).queryByRole('option', { name: 'Team' })).not.toBeInTheDocument()
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave).nodes.find((n) => n.label === 'Team')!.isResult).toBe(false)
  })

  it('removing an entity removes its links, and a grouping on it is cleared', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    clickStar('Team', 'Include in the result')
    await toDisplay(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: node' }), 'Team')
    await user.click(backButton())
    await nodeReady('Team')
    await user.click(within(graphNode('Team')).getByRole('button', { name: 'Remove «Team» from the query' }))
    await waitFor(() => expect(nodeLabels()).toEqual(['Incident']))
    await toDisplay(user)
    const nodeSelect = screen.getByRole('combobox', { name: 'Group by: node' })
    expect(nodeSelect).toHaveValue('')
    expect(within(nodeSelect).queryByRole('option', { name: 'Team' })).not.toBeInTheDocument()
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({ groupByNodeId: null, edges: [] })
    expect(saved(onSave).nodes).toHaveLength(1)
  })

  it('removing an entity that is not the grouping keeps the grouping', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    await toDisplay(user)
    const groupNode = screen.getByRole('combobox', { name: 'Group by: node' })
    await user.selectOptions(groupNode, within(groupNode).getByRole('option', { name: 'Incident' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: field' }), 'status')
    await user.click(backButton())
    await nodeReady('Team')
    await user.click(within(graphNode('Team')).getByRole('button', { name: 'Remove «Team» from the query' }))
    await waitFor(() => expect(nodeLabels()).toEqual(['Incident']))
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    const input = saved(onSave)
    expect(input.groupByNodeId).toBe(input.nodes[0]!.id)
    expect(input.groupByField).toBe('status')
  })

  it('filters: added on a node, edited field by field, and removed', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    const node = () => graphNode('Incident')
    await user.click(within(node()).getByRole('button', { name: '+ filter' }))
    await user.click(within(node()).getByRole('button', { name: '+ filter' }))
    const fields = () => within(node()).getAllByRole('combobox', { name: 'Filter field' })
    expect(fields()).toHaveLength(2)
    // A choice field compares with its values.
    await user.selectOptions(fields()[0]!, 'status')
    await user.selectOptions(within(node()).getByRole('combobox', { name: 'Filter value' }), 'closed')
    // The second one is removed: only the first is saved.
    const secondRow = fields()[1]!.parentElement as HTMLElement
    await user.click(within(secondRow).getAllByRole('button').at(-1)!)
    expect(fields()).toHaveLength(1)
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(JSON.parse(saved(onSave).nodes[0]!.filters!)).toEqual([{ field: 'status', operator: 'eq', value: 'closed' }])
  })

  it('each filter value is saved in the shape of its field and operator', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    const node = () => graphNode('Incident')
    const row = (i: number) => within(node()).getAllByRole('combobox', { name: 'Filter field' })[i]!.parentElement as HTMLElement
    const addFilter = async (field: string, operator: string, value?: string) => {
      await user.click(within(node()).getByRole('button', { name: '+ filter' }))
      const i = within(node()).getAllByRole('combobox', { name: 'Filter field' }).length - 1
      await user.selectOptions(within(row(i)).getByRole('combobox', { name: 'Filter field' }), field)
      await user.selectOptions(within(row(i)).getByRole('combobox', { name: 'Comparison' }), operator)
      if (value !== undefined) await user.type(within(row(i)).getByRole(operator === 'last_n_days' ? 'spinbutton' : 'textbox'), value)
    }
    await addFilter('priority_score', 'eq', '3')
    await addFilter('priority_score', 'neq', 'high')
    await addFilter('is_major', 'eq', 'TRUE')
    await addFilter('created_at', 'last_n_days', '30')
    await addFilter('status', 'in', 'new, closed,')
    await addFilter('title', 'is_null')
    await addFilter('title', 'contains', 'VPN')
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(JSON.parse(saved(onSave).nodes[0]!.filters!)).toEqual([
      { field: 'priority_score', operator: 'eq', value: 3 },
      // Not a number: sent as typed, rather than a silent 0.
      { field: 'priority_score', operator: 'neq', value: 'high' },
      { field: 'is_major', operator: 'eq', value: true },
      { field: 'created_at', operator: 'last_n_days', value: 30 },
      { field: 'status', operator: 'in', value: ['new', 'closed'] },
      { field: 'title', operator: 'is_null', value: null },
      { field: 'title', operator: 'contains', value: 'VPN' },
    ])
  })

  it('a CI entity offers the base CI fields too, with the statuses of the metamodel, and no field twice', async () => {
    const { user } = mount()
    await toGraph(user, 'Server')
    await user.click(within(graphNode('Server')).getByRole('button', { name: '+ filter' }))
    const field = within(graphNode('Server')).getByRole('combobox', { name: 'Filter field' })
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toEqual(['-- Field --', 'Name', 'Status', 'Environment', 'Description', 'OS'])
    await user.selectOptions(field, 'status')
    const value = within(graphNode('Server')).getByRole('combobox', { name: 'Filter value' })
    expect(within(value).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'active', 'retired'])
  })
})

// ── Step 3 ──────────────────────────────────────────────────────────────────

describe('step 3 — how to show it', () => {
  it('previews the section as it would be saved, in the user\'s language, and again at every change', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await waitFor(() => expect(lastPreview()).toBeDefined(), PREVIEW)
    expect(lastPreview()!.language).toBe('en')
    expect(lastPreview()!.input).toMatchObject({ chartType: 'bar', metric: 'count', limit: 20, sortDir: 'DESC' })
    expect(await screen.findByText('42', {}, PREVIEW)).toBeInTheDocument()
    await user.click(chartTypeButton(/^Pie/))
    await waitFor(() => expect(lastPreview()!.input.chartType).toBe('pie'), PREVIEW)
  })

  it('ticking a column of a table refreshes the preview (the columns are part of what is sent)', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await user.click(chartTypeButton(/^Table/))
    await waitFor(() => expect(lastPreview()!.input.chartType).toBe('table'), PREVIEW)
    await user.click(screen.getByRole('checkbox', { name: 'Title' }))
    await waitFor(() => expect(lastPreview()!.input.nodes[0]!.selectedFields).toEqual(['title']), PREVIEW)
  })

  it('while the preview is computed, it says so', async () => {
    inFlight.add('PreviewReportSection')
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    expect(screen.getByText('Loading the preview...')).toBeInTheDocument()
  })

  it('a trend needs a date to plot on: without one Next is blocked', async () => {
    const { user } = mount()
    await toGraph(user, 'Change')
    await toDisplay(user)
    await user.click(chartTypeButton(/^Line/))
    expect(nextButton()).toBeDisabled()
    await user.click(chartTypeButton(/^Vertical bars/))
    expect(nextButton()).toBeEnabled()
  })

  it('a trend on an entity with a date field can go on', async () => {
    const { user } = mount()
    await toGraph(user, 'Incident')
    await toDisplay(user)
    await user.click(chartTypeButton(/^Area/))
    expect(nextButton()).toBeEnabled()
  })

  it('going on without a title proposes one from the entity and the chart', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await toTitle(user)
    expect(screen.getByLabelText('Section title')).toHaveValue('Incident - Vertical bars')
  })
})

// ── Step 4 ──────────────────────────────────────────────────────────────────

describe('step 4 — title and save', () => {
  it('sums the section up: the entity analysed, how many entities, the chart and the top N', async () => {
    const { user } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    await toDisplay(user)
    await toTitle(user)
    const row = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement as HTMLElement
    expect(row('Analysis')).toHaveTextContent('Incident')
    expect(row('Nodes')).toHaveTextContent('2')
    expect(row('Chart')).toHaveTextContent('Vertical bars')
    expect(row('Top')).toHaveTextContent('20')
    expect(screen.getByText('Final preview')).toBeInTheDocument()
  })

  it('a total number has no top N', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await user.click(chartTypeButton(/^Total number/))
    await toTitle(user)
    expect(screen.queryByText('Top', { selector: 'span' })).not.toBeInTheDocument()
  })

  it('the suggested title comes back with one click after the author changed it', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await toTitle(user)
    expect(screen.queryByRole('button', { name: /^Use:/ })).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText('Section title'))
    expect(saveButton()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Use: "Incident - Vertical bars"' }))
    expect(screen.getByLabelText('Section title')).toHaveValue('Incident - Vertical bars')
    expect(saveButton()).toBeEnabled()
  })

  it('a title already written is kept when going to the last step', async () => {
    const { user } = mount()
    await toGraph(user)
    await toDisplay(user)
    await toTitle(user)
    await user.clear(screen.getByLabelText('Section title'))
    await user.type(screen.getByLabelText('Section title'), 'Open work by team')
    await user.click(backButton())
    await toTitle(user)
    expect(screen.getByLabelText('Section title')).toHaveValue('Open work by team')
  })

  it('saves the section as built; the step buttons go back to a completed step', async () => {
    const { user, onSave, onCancel } = mount()
    await toGraph(user)
    await connect(user, 'Incident', 'Team')
    clickStar('Team', 'Include in the result')
    await toDisplay(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: node' }), 'Team')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: field' }), 'name')
    await user.clear(screen.getByLabelText('Show the top N'))
    await user.type(screen.getByLabelText('Show the top N'), '5')
    await user.selectOptions(screen.getByLabelText('Order'), 'ASC')
    await toTitle(user)
    // The step bar goes back to the graph, and forward again with Next.
    await user.click(stepButton('Graph and filters'))
    await nodeReady('Team')
    expect(stepButton('Title and save')).toBeDisabled()
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(onCancel).not.toHaveBeenCalled()
    const input = saved(onSave)
    const teamId = input.nodes.find((n) => n.label === 'Team')!.id
    expect(input).toEqual({
      title: 'Incident - Vertical bars', chartType: 'bar',
      metric: 'count', metricField: null,
      groupByNodeId: teamId, groupByField: 'name', groupByGranularity: null,
      limit: 5, sortDir: 'ASC',
      nodes: [
        { id: expect.stringMatching(/^node_/), entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 300, positionY: 80, filters: null, selectedFields: [] },
        { id: teamId, entityType: 'Team', neo4jLabel: 'Team', label: 'Team', isResult: true, isRoot: false, positionX: 300, positionY: 280, filters: null, selectedFields: [] },
      ],
      edges: [expect.objectContaining({ relationshipType: 'ASSIGNED_TO_TEAM', label: '→ ASSIGNED_TO_TEAM' })],
    })
  })

  it('Cancel on the last step leaves without saving', async () => {
    const { user, onSave, onCancel } = mount()
    await toGraph(user)
    await toDisplay(user)
    await toTitle(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a table sends a plain count: the measure chosen for a chart before does not travel with it', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await toDisplay(user)
    await user.selectOptions(screen.getByLabelText('Metric'), 'avg')
    await user.selectOptions(screen.getByLabelText('Field'), 'cost')
    await user.click(chartTypeButton(/^Table/))
    await user.click(screen.getByRole('checkbox', { name: 'Title' }))
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({ chartType: 'table', metric: 'count', metricField: null })
    expect(saved(onSave).nodes[0]!.selectedFields).toEqual(['title'])
  })

  it('a chart sends its measure and the field it is computed on', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await toDisplay(user)
    await user.selectOptions(screen.getByLabelText('Metric'), 'sum')
    await user.selectOptions(screen.getByLabelText('Field'), 'cost')
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({ metric: 'sum', metricField: 'cost' })
  })

  it('the period is sent only when grouping by a date', async () => {
    const { user, onSave } = mount()
    await toGraph(user)
    await toDisplay(user)
    const groupNode = screen.getByRole('combobox', { name: 'Group by: node' })
    await user.selectOptions(groupNode, within(groupNode).getByRole('option', { name: 'Incident' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: field' }), 'status')
    expect(screen.queryByLabelText('Period')).not.toBeInTheDocument()
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave).groupByGranularity).toBeNull()
    await user.click(backButton())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group by: field' }), 'created_at')
    await user.selectOptions(screen.getByLabelText('Period'), 'month')
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({ groupByField: 'created_at', groupByGranularity: 'month' })
  })
})

// ── Reopening a saved section ───────────────────────────────────────────────

describe('reopening a saved section', () => {
  it('rebuilds the graph and opens on it; saving again gives the same section back', async () => {
    const section = savedSection({
      nodes: [
        { ...savedSection().nodes[0]!, filters: JSON.stringify([{ field: 'status', operator: 'eq', value: 'new' }]) },
        savedSection().nodes[1]!,
      ],
    })
    const { user, onSave } = mount(section)
    await nodeReady('Team')
    expect(stepButton('Graph and filters')).toHaveAttribute('aria-current', 'step')
    expect(nodeLabels()).toEqual(['Incident', 'Team'])
    expect(within(graphNode('Incident')).getByRole('combobox', { name: 'Filter field' })).toHaveValue('status')
    await toDisplay(user)
    expect(chartTypeButton(/^Vertical bars/)).toHaveAttribute('aria-pressed', 'true')
    await toTitle(user)
    expect(screen.getByLabelText('Section title')).toHaveValue('Incidents per team')
    await user.click(saveButton())
    expect(saved(onSave)).toEqual(section)
  })

  it('values saved in another shape keep their meaning when saved again', async () => {
    const section = savedSection({
      nodes: [
        { ...savedSection().nodes[0]!, filters: JSON.stringify([
          { field: 'status', operator: 'in', value: ['new', 'closed'] },
          { field: 'created_at', operator: 'last_n_days', value: [7] },
          { field: 'created_at', operator: 'last_n_days', value: 'soon' },
          { field: 'title', operator: 'eq', value: [] },
          { field: 'title', operator: 'eq', value: ['VPN', 'mail'] },
        ]) },
        savedSection().nodes[1]!,
      ],
    })
    const { user, onSave } = mount(section)
    await nodeReady('Team')
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(JSON.parse(saved(onSave).nodes[0]!.filters!)).toEqual([
      { field: 'status', operator: 'in', value: ['new', 'closed'] },
      { field: 'created_at', operator: 'last_n_days', value: 7 },
      // Not a number of days: 0, never a string the query would choke on.
      { field: 'created_at', operator: 'last_n_days', value: 0 },
      { field: 'title', operator: 'eq', value: '' },
      { field: 'title', operator: 'eq', value: 'VPN' },
    ])
  })

  it('a section saved without grouping, limit, order or columns reopens with the defaults', async () => {
    const section = savedSection({
      groupByNodeId: null, groupByField: null, limit: null, sortDir: null,
      nodes: [{ ...savedSection().nodes[0]!, selectedFields: null as unknown as string[] }, savedSection().nodes[1]!],
    })
    const { user, onSave } = mount(section)
    await nodeReady('Team')
    await toDisplay(user)
    expect(screen.getByLabelText('Show the top N')).toHaveValue(20)
    expect(screen.getByLabelText('Order')).toHaveValue('DESC')
    expect(screen.getByRole('combobox', { name: 'Group by: node' })).toHaveValue('')
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({ groupByNodeId: null, groupByField: null, limit: 20, sortDir: 'DESC' })
    expect(saved(onSave).nodes[0]!.selectedFields).toEqual([])
  })

  it('an entity that is no longer offered reopens as saved, with no field to filter on', async () => {
    const legacy = { id: 'n2', entityType: 'Legacy', neo4jLabel: 'Legacy', label: 'Legacy system', isResult: false, isRoot: false, positionX: 300, positionY: 280, filters: null, selectedFields: [] }
    const section = savedSection({ groupByNodeId: null, groupByField: null, nodes: [savedSection().nodes[0]!, legacy] })
    const { user, onSave } = mount(section)
    await nodeReady('Legacy system')
    await user.click(within(graphNode('Legacy system')).getByRole('button', { name: '+ filter' }))
    const field = within(graphNode('Legacy system')).getByRole('combobox', { name: 'Filter field' })
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toEqual(['-- Field --'])
    await user.click(within(field.parentElement as HTMLElement).getAllByRole('button').at(-1)!)
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave).nodes[1]).toEqual(legacy)
  })

  it('a link saved without a label is saved back with its relationship as the label', async () => {
    const section = savedSection({ edges: [{ ...savedSection().edges[0]!, label: '' }] })
    const { user, onSave } = mount(section)
    await nodeReady('Team')
    await toDisplay(user)
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave).edges[0]!.label).toBe('ASSIGNED_TO_TEAM')
  })

  it('waits for the entities before rebuilding: until then the builder stays on the first step', async () => {
    apolloFinto.risposte['GetNavigableEntities'] = undefined
    const section = savedSection()
    const { rerender } = mount(section)
    expect(stepButton('What to analyse')).toHaveAttribute('aria-current', 'step')
    apolloFinto.risposte['GetNavigableEntities'] = { navigableEntities: ENTITIES }
    rerender(<ReportSectionBuilder onSave={vi.fn()} onCancel={vi.fn()} initialValues={section} />)
    await nodeReady('Team')
    expect(stepButton('Graph and filters')).toHaveAttribute('aria-current', 'step')
  })

  it('a section with corrupt filters is not opened: saving it would lose them, so the error names the node', async () => {
    const section = savedSection({ nodes: [{ ...savedSection().nodes[0]!, filters: '{not json' }, savedSection().nodes[1]!] })
    mount(section)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0]![0]).toMatch(/^Corrupt section filters \(node "Incident"\): .+\. Fix the saved data before editing the section\.$/)
    expect(stepButton('What to analyse')).toHaveAttribute('aria-current', 'step')
    expect(nextButton()).toBeDisabled()
  })

  it('an entity left unconnected blocks Next with a warning, until it is removed', async () => {
    const section = savedSection({ edges: [] })
    const { user } = mount(section)
    await nodeReady('Team')
    expect(screen.getByText(/Some nodes are not connected/)).toBeInTheDocument()
    expect(nextButton()).toBeDisabled()
    await user.click(within(graphNode('Team')).getByRole('button', { name: 'Remove «Team» from the query' }))
    await waitFor(() => expect(nextButton()).toBeEnabled())
    expect(screen.queryByText(/Some nodes are not connected/)).not.toBeInTheDocument()
  })

  it('a section without a main entity: nothing is flagged, no title is proposed, and a chart unknown here is named as saved', async () => {
    const section = savedSection({
      title: '', chartType: 'heatmap', edges: [],
      nodes: savedSection().nodes.map((n) => ({ ...n, isRoot: false })),
    })
    const { user } = mount(section)
    await nodeReady('Team')
    expect(screen.queryByText(/Some nodes are not connected/)).not.toBeInTheDocument()
    await toDisplay(user)
    await toTitle(user)
    expect(screen.getByLabelText('Section title')).toHaveValue('')
    expect(screen.queryByRole('button', { name: /^Use:/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Analysis', { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.getByText('Chart', { selector: 'span' }).parentElement).toHaveTextContent('heatmap')
    expect(saveButton()).toBeDisabled()
  })

  it('a chart unknown here still gets a proposed title, with its saved name', async () => {
    const { user } = mount(savedSection({ title: '', chartType: 'heatmap' }))
    await nodeReady('Team')
    await toDisplay(user)
    await toTitle(user)
    expect(screen.getByLabelText('Section title')).toHaveValue('Incident - heatmap')
  })
})

// ── The AI designer ─────────────────────────────────────────────────────────

describe('the AI designer', () => {
  const PROPOSAL = {
    prompt: 'Incidents per team as a pie', title: 'Incidents per team', chartType: 'pie', metric: 'count', metricField: null,
    groupByNodeId: 'p2', groupByField: 'name', groupByGranularity: null, limit: 10, sortDir: 'DESC', why: '',
    nodes: [
      { id: 'p1', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isRoot: true, isResult: true, selectedFields: [], filters: null, positionX: 300, positionY: 80, why: '' },
      { id: 'p2', entityType: 'Team', neo4jLabel: 'Team', label: 'Team', isRoot: false, isResult: true, selectedFields: [], filters: null, positionX: 300, positionY: 280, why: '' },
    ],
    edges: [{ id: 'pe1', sourceNodeId: 'p1', targetNodeId: 'p2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team' }],
    discarded: [], notes: [],
  }

  it('a proposal enters the builder like a section built by hand, on the step with the preview', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: PROPOSAL } }
    const { user, onSave } = mount()
    await user.click(screen.getByRole('button', { name: 'Design it with AI' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), PROPOSAL.prompt)
    await user.click(within(dialog).getByRole('button', { name: 'Design' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Put it in the builder' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(stepButton('How to show it')).toHaveAttribute('aria-current', 'step')
    expect(chartTypeButton(/^Pie/)).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(lastPreview()!.input).toMatchObject({ chartType: 'pie', groupByNodeId: 'p2', groupByField: 'name' }), PREVIEW)
    await toTitle(user)
    await user.click(saveButton())
    expect(saved(onSave)).toMatchObject({
      title: 'Incidents per team', chartType: 'pie', limit: 10, sortDir: 'DESC',
      edges: [{ id: 'pe1', sourceNodeId: 'p1', targetNodeId: 'p2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team' }],
    })
  })

  it('reopening the AI starts from the last description; closing it changes nothing', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: PROPOSAL } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Design it with AI' }))
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'something else')
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(stepButton('What to analyse')).toHaveAttribute('aria-current', 'step')
    await user.click(screen.getByRole('button', { name: 'Design it with AI' }))
    expect(within(screen.getByRole('dialog')).getByRole('textbox')).toHaveValue('')
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), PROPOSAL.prompt)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Design' }))
    await user.click(await screen.findByRole('button', { name: 'Put it in the builder' }))
    await user.click(stepButton('What to analyse'))
    await user.click(screen.getByRole('button', { name: 'Design it with AI' }))
    expect(within(screen.getByRole('dialog')).getByRole('textbox')).toHaveValue(PROPOSAL.prompt)
  })
})
