import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { Star, X } from 'lucide-react'
import { fontFamily, colors, palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'

// ── Shared types ──────────────────────────────────────────────────────────────

export interface NavigableField    { name: string; label: string; labelKey?: string | null; fieldType: string; enumValues: string[]; enumTypeName?: string | null }
export interface NavigableRelation { relationshipType: string; direction: string; label: string; labelKey?: string | null; targetEntityType: string; targetLabel: string; targetLabelKey?: string | null; targetNeo4jLabel: string }
export interface NavigableEntity   { entityType: string; label: string; labelKey?: string | null; neo4jLabel: string; group?: 'itsm' | 'organization' | 'cmdb'; icon?: string; color?: string; fields: NavigableField[]; relations: NavigableRelation[] }
export interface ReachableEntity   { entityType: string; label: string; labelKey?: string | null; neo4jLabel: string; relationshipType: string; direction: string; count: number; fields: NavigableField[] }

/**
 * L'etichetta di un'entità/campo/relazione del costruttore di report.
 *
 * Revisione totale · C-18: le etichette del PRODOTTO («Name», «Assigned
 * team», «Member») erano letterali inglesi nell'API e arrivavano così anche a
 * chi usa OpenGrafo in italiano. Ora l'API manda anche la chiave i18n quando
 * l'etichetta è sua; dove il nome è del CLIENTE (un tipo o un campo che ha
 * creato lui) la chiave non c'è e vale la sua etichetta, che è già giusta.
 */
export function navigableLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  item: { label: string; labelKey?: string | null },
): string {
  return item.labelKey ? t(item.labelKey, { defaultValue: item.label }) : item.label
}

/**
 * Un filtro nel costruttore.
 *
 * `value` non è solo testo (19 set 2026): «ultimi N giorni» porta un numero e
 * «fra questi» una lista. Prima era dichiarato `string` e conteneva altro —
 * funzionava per caso, e il costruttore non sapeva mostrare né l'uno né
 * l'altra.
 */
export interface FilterState { field: string; operator: string; value: string | number | string[] }

/**
 * GLI OPERATORI CHE IL COSTRUTTORE SA MOSTRARE (19 set 2026).
 *
 * Erano sette nell'API e UNO nell'interfaccia: `addFilter` scriveva `eq` e non
 * c'era modo di cambiarlo, quindi «gli incident degli ultimi 30 giorni» non si
 * poteva costruire — e una sezione che lo usava (scritta via API, o proposta
 * dall'AI) non si poteva né leggere né correggere. Adesso si scelgono, e ogni
 * operatore ha il controllo di valore che gli serve.
 */
export const REPORT_FILTER_OPERATORS = ['eq', 'neq', 'contains', 'in', 'last_n_days', 'is_null', 'is_not_null'] as const

/** Gli operatori che non guardano nessun valore. */
export const REPORT_OPERATORS_WITHOUT_VALUE: readonly string[] = ['is_null', 'is_not_null']

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

// memo (F-26): ReportSectionBuilder ricostruisce `data` solo per i nodi la cui
// entry è cambiata (callback stabili per nodo), quindi gli altri non
// rirenderizzano a ogni keystroke nei filtri.
export const ReportEntityNode = memo(function ReportEntityNode({ data }: { id: string; data: NodeData }) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const d = data

  return (
    <div style={{
      width: 'fit-content', minWidth: 200, maxWidth: 320,
      background: d.isResult || d.isRoot ? colors.white : palette.purple.bg,
      border: d.isRoot ? `2px solid ${colors.brand}` : d.isResult ? `1.5px solid ${colors.brand}` : `1.5px dashed ${palette.purple.border}`,
      borderRadius: 10,
      fontSize: 'var(--font-size-body)',
      fontFamily,
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

      <div className="node-drag-handle" style={{ padding: '8px 10px', borderBottom: `1px solid ${palette.neutral.borderLight}`, display: 'flex', alignItems: 'center', gap: 4, cursor: 'grab' }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate-dark)', flex: 1, whiteSpace: 'nowrap' }}>{d.label}</span>
        {d.isRoot && (
          <span style={{ fontSize: 'var(--font-size-label)', background: palette.purple.tint, color: palette.purple.base, borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>
            {t('reportBuilder.root')}
          </span>
        )}
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onToggleResult}
          title={t(d.isResult ? 'reportBuilder.removeFromResult' : 'reportBuilder.includeInResult')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, color: d.isResult ? 'var(--color-brand)' : palette.neutral.borderStrong }}
        >
          <Star size={12} fill={d.isResult ? 'var(--color-brand)' : 'none'} />
        </button>
        {!d.isRoot && (
          <button
            type="button"
            className="nodrag nopan"
            // F-36: il pulsante «×» non aveva nome accessibile.
            aria-label={t('reportBuilder.removeNode', { node: d.label })}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); d.onDelete() }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', lineHeight: 1, padding: '0 2px', marginLeft: 2 }}
          ><span aria-hidden="true">×</span></button>
        )}
      </div>

      {/* role=presentation: il wrapper intercetta solo mousedown per non far partire il drag del nodo React Flow; i controlli interattivi sono i figli */}
      <div role="presentation" className="nodrag nopan" onMouseDown={e => e.stopPropagation()} style={{ padding: '6px 12px' }}>
        {d.filters.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {d.filters.map((f: FilterState, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <select
                  aria-label={t('a11y.reportFilterField')}
                  className="nodrag nopan"
                  onMouseDown={e => e.stopPropagation()}
                  value={f.field}
                  onChange={e => d.onFilterChange(i, 'field', e.target.value)}
                  style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 4, flex: 1 }}
                >
                  <option value="">{t('automation.params.selectFieldOption')}</option>
                  {/* TUTTI i campi, non solo scelte e date: con gli operatori
                      scegliibili un «contiene» su un testo e un «ultimi N
                      giorni» su una data-e-ora hanno senso, e un filtro
                      proposto su `created_at` (che è `datetime`) prima non
                      compariva nemmeno nell'elenco. */}
                  {(d.fields as NavigableField[]).map(fld => (
                    <option key={fld.name} value={fld.name}>{navigableLabel(t, fld)}</option>
                  ))}
                </select>
                <select
                  className="nodrag nopan"
                  aria-label={t('reportBuilder.filterOperator')}
                  onMouseDown={e => e.stopPropagation()}
                  value={f.operator}
                  onChange={e => d.onFilterChange(i, 'operator', e.target.value)}
                  style={{ fontSize: 'var(--font-size-body)', padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 4 }}
                >
                  {REPORT_FILTER_OPERATORS.map(op => (
                    <option key={op} value={op}>{t(`reportBuilder.op.${op}`)}</option>
                  ))}
                </select>
                {(() => {
                  const fld = (d.fields as NavigableField[]).find(x => x.name === f.field)
                  const stile = { fontSize: 'var(--font-size-body)', padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 4, flex: 1, minWidth: 60 }
                  // Niente valore da mostrare: «è vuoto» non confronta niente.
                  if (REPORT_OPERATORS_WITHOUT_VALUE.includes(f.operator)) return null
                  if (f.operator === 'last_n_days') {
                    return (
                      <input
                        className="nodrag nopan" type="number" min={1}
                        aria-label={t('reportBuilder.op.last_n_days')}
                        onMouseDown={e => e.stopPropagation()}
                        value={typeof f.value === 'number' ? f.value : String(f.value)}
                        onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                        style={{ ...stile, width: 70, flex: '0 0 auto' }}
                      />
                    )
                  }
                  if (f.operator === 'in') {
                    // I valori separati da virgola: si leggono e si correggono,
                    // che è quello che serve a chi rivede una proposta.
                    return (
                      <input
                        className="nodrag nopan"
                        aria-label={t('reportBuilder.op.in')}
                        onMouseDown={e => e.stopPropagation()}
                        value={Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}
                        onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                        placeholder={t('reportBuilder.valuesPlaceholder')}
                        style={stile}
                      />
                    )
                  }
                  if (fld?.fieldType === 'enum') {
                    return (
                      <select
                        aria-label={t('a11y.reportFilterValue')}
                        className="nodrag nopan"
                        onMouseDown={e => e.stopPropagation()}
                        value={String(f.value)}
                        onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                        style={stile}
                      >
                        <option value="">{t('automation.params.selectValue')}</option>
                        {(fld.enumValues ?? []).map(v => (
                          <option key={v} value={v}>{(fld.enumTypeName ? labelOf(fld.enumTypeName, v) : null) ?? v}</option>
                        ))}
                      </select>
                    )
                  }
                  return (
                    <input aria-label={t('reportBuilder.valuePlaceholder')}
                      className="nodrag nopan"
                      onMouseDown={e => e.stopPropagation()}
                      value={String(f.value)}
                      onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                      placeholder={t('reportBuilder.valuePlaceholder')}
                      style={stile}
                    />
                  )
                })()}
                <button
                  type="button"
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
          type="button"
          className="nodrag nopan"
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onAddFilter}
          style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', background: 'none', border: `1px dashed ${palette.neutral.borderStrong}`, borderRadius: 6, padding: '4px 8px', cursor: 'pointer', width: '100%', marginBottom: 4 }}
        >
          {t('reportBuilder.addFilter')}
        </button>
        <button
          type="button"
          className="nodrag nopan"
          onMouseDown={e => e.stopPropagation()}
          onClick={d.onConnect}
          style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-brand)', background: 'none', border: `1px solid ${palette.purple.border}`, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', width: '100%' }}
        >
          + {t('reportBuilder.connectTo')}
        </button>
      </div>
    </div>
  )
})

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
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ ...style, stroke: palette.purple.border, strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            background: palette.purple.tint,
            border: `1px solid ${palette.purple.border}`,
            borderRadius: 20,
            padding: '2px 10px',
            fontSize: 'var(--font-size-label)',
            fontWeight: 700,
            color: palette.purple.base,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            cursor: 'default',
          }}
        >
          {/* `||` not `??`: an empty saved label must still fall back to the relationship type */}
          {(data as { label?: string; relationshipType?: string } | undefined)?.label
            || (data as { label?: string; relationshipType?: string } | undefined)?.relationshipType}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { reportEdge: ReportEdgeComponent }
