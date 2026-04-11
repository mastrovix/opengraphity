import { Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { Star, X } from 'lucide-react'

// ── Shared types ──────────────────────────────────────────────────────────────

export interface NavigableField    { name: string; label: string; fieldType: string; enumValues: string[] }
export interface NavigableRelation { relationshipType: string; direction: string; label: string; targetEntityType: string; targetLabel: string; targetNeo4jLabel: string }
export interface NavigableEntity   { entityType: string; label: string; neo4jLabel: string; icon?: string; color?: string; fields: NavigableField[]; relations: NavigableRelation[] }
export interface ReachableEntity   { entityType: string; label: string; neo4jLabel: string; relationshipType: string; direction: string; count: number; fields: NavigableField[] }

export interface FilterState { field: string; operator: string; value: string }

export interface NodeData {
  entityType:      string
  neo4jLabel:      string
  label:           string
  isResult:        boolean
  isRoot:          boolean
  filters:         FilterState[]
  selectedFields:  string[]
  fields:          NavigableField[]
  onToggleResult:  () => void
  onAddFilter:     () => void
  onRemoveFilter:  (i: number) => void
  onFilterChange:  (i: number, key: keyof FilterState, val: string) => void
  onConnect:       () => void
  onDelete:        () => void
  [key: string]:   unknown
}

// ── Custom Node ───────────────────────────────────────────────────────────────

export function ReportEntityNode({ data }: { id: string; data: NodeData }) {
  const d = data

  return (
    <div style={{
      width: 'fit-content', minWidth: 200, maxWidth: 320,
      background: d.isResult || d.isRoot ? '#fff' : '#faf5ff',
      border: d.isRoot ? '2px solid #0284c7' : d.isResult ? '1.5px solid #0284c7' : '1.5px dashed #c4b5fd',
      borderRadius: 10,
      fontSize: 'var(--font-size-body)',
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      overflow: 'hidden',
    }}>
      <Handle type="source" position={Position.Top}    id="top-source"    style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Top}    id="top-target"    style={{ opacity: 0, width: 8, height: 8, left: '40%' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-source" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={{ opacity: 0, width: 8, height: 8, left: '40%' }} />
      <Handle type="source" position={Position.Left}   id="left-source"   style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Left}   id="left-target"   style={{ opacity: 0, width: 8, height: 8, top: '40%' }} />
      <Handle type="source" position={Position.Right}  id="right-source"  style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Right}  id="right-target"  style={{ opacity: 0, width: 8, height: 8, top: '40%' }} />

      <div className="node-drag-handle" style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab' }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate-dark)', flex: 1, whiteSpace: 'nowrap' }}>{d.label}</span>
        {d.isRoot && (
          <span style={{ fontSize: 'var(--font-size-label)', background: '#ede9fe', color: '#7c3aed', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>
            Radice
          </span>
        )}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onToggleResult}
          title={d.isResult ? 'Rimuovi dal risultato' : 'Includi nel risultato'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, color: d.isResult ? 'var(--color-brand)' : '#d1d5db' }}
        >
          <Star size={12} fill={d.isResult ? 'var(--color-brand)' : 'none'} />
        </button>
        {!d.isRoot && (
          <button
            className="nodrag nopan"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); d.onDelete() }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', lineHeight: 1, padding: '0 2px', marginLeft: 2 }}
          >×</button>
        )}
      </div>

      <div className="nodrag nopan" onMouseDown={e => e.stopPropagation()} style={{ padding: '6px 12px' }}>
        {d.filters.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {d.filters.map((f: FilterState, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <select
                  className="nodrag nopan"
                  onMouseDown={e => e.stopPropagation()}
                  value={f.field}
                  onChange={e => d.onFilterChange(i, 'field', e.target.value)}
                  style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
                >
                  <option value="">-- campo --</option>
                  {(d.fields as NavigableField[]).filter(fld => fld.fieldType === 'enum' || fld.fieldType === 'date').map(fld => (
                    <option key={fld.name} value={fld.name}>{fld.label}</option>
                  ))}
                </select>
                {(d.fields as NavigableField[]).find(fld => fld.name === f.field)?.fieldType === 'enum' ? (
                  <select
                    className="nodrag nopan"
                    onMouseDown={e => e.stopPropagation()}
                    value={f.value}
                    onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                    style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
                  >
                    <option value="">-- valore --</option>
                    {((d.fields as NavigableField[]).find(fld => fld.name === f.field)?.enumValues ?? []).map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="nodrag nopan"
                    onMouseDown={e => e.stopPropagation()}
                    value={f.value}
                    onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                    placeholder="valore"
                    style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 4, width: 60 }}
                  />
                )}
                <button
                  className="nodrag nopan"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => d.onRemoveFilter(i)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0 }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          className="nodrag nopan"
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onAddFilter}
          style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', background: 'none', border: '1px dashed #d1d5db', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', width: '100%', marginBottom: 4 }}
        >
          + filtro
        </button>
        <button
          className="nodrag nopan"
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onConnect}
          style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', background: 'none', border: '1px solid #c4b5fd', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', width: '100%' }}
        >
          + Connetti a...
        </button>
      </div>
    </div>
  )
}

export const nodeTypes = { reportEntity: ReportEntityNode }

// ── Custom Edge ───────────────────────────────────────────────────────────────

export function ReportEdgeComponent({
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, markerEnd, style,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ ...style, stroke: '#c4b5fd', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            background: '#ede9fe',
            border: '1px solid #c4b5fd',
            borderRadius: 20,
            padding: '2px 10px',
            fontSize: 'var(--font-size-label)',
            fontWeight: 700,
            color: '#7c3aed',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            cursor: 'default',
          }}
        >
          {(data as { label?: string; relationshipType?: string } | undefined)?.label
            ?? (data as { label?: string; relationshipType?: string } | undefined)?.relationshipType}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { reportEdge: ReportEdgeComponent }
