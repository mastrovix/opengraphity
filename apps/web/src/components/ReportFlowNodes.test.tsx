/**
 * The node and edge of the report builder graph.
 *
 * Why these behaviours matter: a report section is BUILT on this node. Each
 * filter row must show the value control its operator needs ("last N days"
 * takes a number, "is one of" a list, "is empty" nothing) — before, a filter
 * written through the API or proposed by the AI could be neither read nor
 * corrected here. Every change must reach the builder with the right filter
 * index and key, or the wrong filter gets edited. Labels of product entities
 * go through i18n, the customer's own labels are shown as they are. The edge
 * label must fall back to the relationship type when the saved label is empty.
 *
 * React Flow's Handle/BaseEdge/EdgeLabelRenderer need a live canvas store; they
 * are stubbed with plain elements because what is under test is this file's
 * content, not React Flow's positioning.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { EdgeProps } from '@xyflow/react'
import { withVocabularyLabels } from '@/test/vocabularies'
import {
  ReportEntityNode, ReportEdgeComponent, navigableLabel, nodeTypes, edgeTypes,
  REPORT_FILTER_OPERATORS, REPORT_OPERATORS_WITHOUT_VALUE,
  type NodeData, type FilterState, type NavigableField,
} from './ReportFlowNodes'

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    Handle: ({ id }: { id: string }) => <span data-testid={`handle-${id}`} />,
    BaseEdge: ({ path }: { path: string }) => <svg><path data-testid="edge-path" d={path} /></svg>,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
})

const FIELDS: NavigableField[] = [
  { name: 'status', label: 'Status', labelKey: 'reportBuilder.field.status', fieldType: 'enum', enumValues: ['open', 'closed'], enumTypeName: 'incident_status' },
  { name: 'severity', label: 'Severity', fieldType: 'enum', enumValues: ['high'], enumTypeName: null },
  { name: 'kind', label: 'Kind', fieldType: 'enum', enumValues: undefined as unknown as string[] },
  { name: 'title', label: 'Customer title', labelKey: null, fieldType: 'string', enumValues: [] },
  { name: 'created_at', label: 'Created', fieldType: 'datetime', enumValues: [] },
]

function nodeData(filters: FilterState[], extra: Partial<NodeData> = {}): NodeData {
  return {
    entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident',
    isResult: false, isRoot: false, filters, selectedFields: [], fields: FIELDS,
    onToggleResult: vi.fn(), onAddFilter: vi.fn(), onRemoveFilter: vi.fn(),
    onFilterChange: vi.fn(), onConnect: vi.fn(), onDelete: vi.fn(),
    ...extra,
  }
}

function renderNode(data: NodeData) {
  return render(withVocabularyLabels(<ReportEntityNode id="n1" data={data} />, { incident_status: { open: 'Open' } }))
}

describe('navigableLabel', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (key === 'known' ? 'Translated' : String(opts?.['defaultValue']))
  it('translates product labels and keeps the customer ones', () => {
    expect(navigableLabel(t, { label: 'Name', labelKey: 'known' })).toBe('Translated')
    // A key the locale does not have falls back to the API label, never the raw key.
    expect(navigableLabel(t, { label: 'Name', labelKey: 'missing' })).toBe('Name')
    expect(navigableLabel(t, { label: 'My field', labelKey: null })).toBe('My field')
    expect(navigableLabel(t, { label: 'My field' })).toBe('My field')
  })
})

describe('operator lists', () => {
  it('every operator the API supports is offered, and the valueless ones are a subset', () => {
    expect(REPORT_FILTER_OPERATORS).toHaveLength(7)
    for (const op of REPORT_OPERATORS_WITHOUT_VALUE) expect(REPORT_FILTER_OPERATORS).toContain(op)
  })
  it('the builder registers the node and edge under the names the saved graph uses', () => {
    expect(nodeTypes.reportEntity).toBe(ReportEntityNode)
    expect(edgeTypes.reportEdge).toBe(ReportEdgeComponent)
  })
})

describe('ReportEntityNode', () => {
  it('a root node is marked, cannot be removed, and toggles in/out of the result', async () => {
    const user = userEvent.setup()
    const data = nodeData([], { isRoot: true, isResult: true })
    renderNode(data)
    expect(screen.getByText('Root')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove «Incident»/ })).toBeNull()
    await user.click(screen.getByTitle('Remove from the result'))
    expect(data.onToggleResult).toHaveBeenCalledTimes(1)
    // Eight invisible handles: the builder connects edges to any side.
    expect(screen.getAllByTestId(/^handle-/)).toHaveLength(8)
  })

  it('a non-root node can be removed, connected and given a filter', async () => {
    const user = userEvent.setup()
    const data = nodeData([])
    renderNode(data)
    expect(screen.getByTitle('Include in the result')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove «Incident» from the query' }))
    expect(data.onDelete).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '+ filter' }))
    expect(data.onAddFilter).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '+ Connect to...' }))
    expect(data.onConnect).toHaveBeenCalledTimes(1)
  })

  it('lists every field (translated when it is a product field) and reports field and operator changes', () => {
    const data = nodeData([{ field: '', operator: 'eq', value: '' }])
    renderNode(data)
    const fieldSelect = screen.getByRole('combobox', { name: 'Filter field' })
    const labels = within(fieldSelect).getAllByRole('option').map((o) => o.textContent)
    // All fields, not only choices and dates: a datetime filter must be listable.
    expect(labels).toEqual(['-- Field --', 'Status', 'Severity', 'Kind', 'Customer title', 'Created'])
    fireEvent.change(fieldSelect, { target: { value: 'created_at' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(0, 'field', 'created_at')
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparison' }), { target: { value: 'last_n_days' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(0, 'operator', 'last_n_days')
  })

  it('each operator gets the value control it needs', () => {
    const data = nodeData([
      { field: 'title', operator: 'is_null', value: '' },
      { field: 'created_at', operator: 'last_n_days', value: 30 },
      { field: 'created_at', operator: 'last_n_days', value: '7' },
      { field: 'status', operator: 'in', value: ['open', 'closed'] },
      { field: 'status', operator: 'in', value: 'open' },
      { field: 'title', operator: 'contains', value: 'db' },
    ])
    renderNode(data)
    const days = screen.getAllByRole('spinbutton', { name: 'last N days' })
    expect(days.map((d) => (d as HTMLInputElement).value)).toEqual(['30', '7'])
    const lists = screen.getAllByRole('textbox', { name: 'is one of' })
    // A saved list is shown comma-separated, so a proposal can be read and fixed.
    expect(lists.map((l) => (l as HTMLInputElement).value)).toEqual(['open, closed', 'open'])
    expect(screen.getByRole('textbox', { name: 'value' })).toHaveValue('db')
    // "is empty" compares nothing: six rows, five value controls.
    expect(screen.getAllByRole('combobox', { name: 'Comparison' })).toHaveLength(6)

    fireEvent.change(days[0]!, { target: { value: '14' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(1, 'value', '14')
    fireEvent.change(lists[0]!, { target: { value: 'open' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(3, 'value', 'open')
    fireEvent.change(screen.getByRole('textbox', { name: 'value' }), { target: { value: 'dbx' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(5, 'value', 'dbx')
  })

  it('an enum field offers its values with the vocabulary labels', () => {
    const data = nodeData([
      { field: 'status', operator: 'eq', value: 'open' },
      { field: 'severity', operator: 'neq', value: '' },
      { field: 'kind', operator: 'eq', value: '' },
    ])
    renderNode(data)
    const [status, severity, kind] = screen.getAllByRole('combobox', { name: 'Filter value' })
    // `closed` has no vocabulary label: the raw value, not an empty option.
    expect(within(status!).getAllByRole('option').map((o) => o.textContent)).toEqual(['-- Value --', 'Open', 'closed'])
    expect(status).toHaveValue('open')
    // No vocabulary name: the values as they are.
    expect(within(severity!).getAllByRole('option').map((o) => o.textContent)).toEqual(['-- Value --', 'high'])
    // Missing enum values: only the placeholder, no crash.
    expect(within(kind!).getAllByRole('option')).toHaveLength(1)
    fireEvent.change(severity!, { target: { value: 'high' } })
    expect(data.onFilterChange).toHaveBeenLastCalledWith(1, 'value', 'high')
  })

  it('pressing any control does not start dragging the node', () => {
    // React Flow starts a node drag on mousedown bubbling up from the node:
    // a control that lets it through turns "pick a value" into "move the box".
    const canvasMouseDown = vi.fn()
    const data = nodeData([
      { field: 'created_at', operator: 'last_n_days', value: 3 },
      { field: 'status', operator: 'in', value: [] },
      { field: 'status', operator: 'eq', value: '' },
      { field: 'title', operator: 'eq', value: '' },
    ])
    render(withVocabularyLabels(
      <div onMouseDown={canvasMouseDown}><ReportEntityNode id="n1" data={data} /></div>,
    ))
    const controls = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('spinbutton'),
    ]
    for (const c of controls) fireEvent.mouseDown(c)
    // The gap between the filter rows (the body wrapper) is not a drag handle either.
    fireEvent.mouseDown(document.querySelector('[role="presentation"]')!)
    expect(controls.length).toBeGreaterThan(10)
    expect(canvasMouseDown).not.toHaveBeenCalled()
  })

  it('removing a filter reports its index', async () => {
    const user = userEvent.setup()
    const data = nodeData([
      { field: 'title', operator: 'is_not_null', value: '' },
      { field: 'title', operator: 'is_null', value: '' },
    ])
    const { container } = renderNode(data)
    // The remove buttons are the icon-only ones inside the filter rows.
    const rows = container.querySelectorAll('select[aria-label="Filter field"]')
    const second = rows[1]!.parentElement!
    await user.click(within(second).getAllByRole('button').at(-1)!)
    expect(data.onRemoveFilter).toHaveBeenCalledWith(1)
  })
})

describe('ReportEdgeComponent', () => {
  const base = {
    id: 'e1', source: 'a', target: 'b', sourceX: 0, sourceY: 0, targetX: 100, targetY: 100,
    sourcePosition: 'bottom', targetPosition: 'top',
  } as unknown as EdgeProps

  it('shows the saved label, or the relationship type when the label is empty', () => {
    const { rerender } = render(<ReportEdgeComponent {...base} data={{ label: 'Assigned team', relationshipType: 'ASSIGNED_TO' }} />)
    expect(screen.getByText('Assigned team')).toBeInTheDocument()
    expect(screen.getByTestId('edge-path').getAttribute('d')).not.toBe('')
    rerender(<ReportEdgeComponent {...base} data={{ label: '', relationshipType: 'ASSIGNED_TO' }} />)
    expect(screen.getByText('ASSIGNED_TO')).toBeInTheDocument()
  })

  it('an edge without data renders an empty label, not a crash', () => {
    const { container } = render(<ReportEdgeComponent {...base} data={undefined as unknown as EdgeProps['data']} />)
    expect(container.querySelector('.nodrag')?.textContent).toBe('')
  })
})
