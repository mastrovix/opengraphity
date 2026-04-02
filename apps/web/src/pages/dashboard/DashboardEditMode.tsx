import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingWidget {
  tempId: string
  serverId?: string
  reportTemplateId: string
  reportSectionId: string
  colSpan: number
  order: number
  reportSection: { id: string; title: string; chartType: string } | null
  reportTemplate: { id: string; name: string } | null
  data: string | null
  isNew: boolean
  isDeleted: boolean
}

interface ReportSection {
  id: string
  title: string
  chartType: string
  order: number
}

interface ReportTemplate {
  id: string
  name: string
  sections: ReportSection[]
}

interface DashboardEditModeProps {
  pendingWidgets: PendingWidget[]
  templates: ReportTemplate[]
  expandedTemplates: Set<string>
  onDragEnd: (event: DragEndEvent) => void
  onRemoveWidget: (tempId: string) => void
  onUpdateColSpan: (tempId: string, colSpan: number) => void
  onAddWidget: (template: ReportTemplate, section: ReportSection) => void
  onToggleTemplate: (templateId: string) => void
}

// ── SortableItem ──────────────────────────────────────────────────────────────

interface SortableItemProps {
  widget: PendingWidget
  onRemove: (tempId: string) => void
  onUpdateColSpan: (tempId: string, colSpan: number) => void
}

function SortableItem({ widget, onRemove, onUpdateColSpan }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.tempId })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    gridColumn: `span ${widget.colSpan}`,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div style={{
        border: '2px dashed #0284c7',
        borderRadius: 10,
        background: '#fff',
        overflow: 'hidden',
        position: 'relative',
      }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            {...listeners}
            style={{ cursor: 'grab', fontSize: 14, color: 'var(--color-slate-light)', userSelect: 'none', lineHeight: 1 }}
            title="Trascina per riordinare"
          >
            ⠿
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {widget.reportSection?.title ?? 'Widget'}
              {widget.isNew && (
                <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-brand)', fontWeight: 400 }}>nuovo</span>
              )}
            </div>
            {widget.reportTemplate?.name && (
              <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 1 }}>{widget.reportTemplate.name}</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              value={widget.colSpan}
              onChange={(e) => onUpdateColSpan(widget.tempId, Number(e.target.value))}
              style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', cursor: 'pointer' }}
            >
              {[2, 3, 4, 6, 12].map((s) => (
                <option key={s} value={s}>{s} col</option>
              ))}
            </select>
            <button
              onClick={() => onRemove(widget.tempId)}
              style={{
                width: 20, height: 20, borderRadius: 4, border: '1px solid #fca5a5',
                background: '#fef2f2', color: 'var(--color-danger)', fontSize: 12, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <ReportChartRenderer
            chartType={widget.reportSection?.chartType ?? 'bar'}
            data={widget.data ?? ''}
            title={widget.reportSection?.title ?? ''}
            error={null}
          />
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', background: 'rgba(255,255,255,0.4)' }} />
        </div>
      </div>
    </div>
  )
}

// ── DashboardEditMode ─────────────────────────────────────────────────────────

export function DashboardEditMode({
  pendingWidgets,
  templates,
  expandedTemplates,
  onDragEnd,
  onRemoveWidget,
  onUpdateColSpan,
  onAddWidget,
  onToggleTemplate,
}: DashboardEditModeProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const visiblePending = pendingWidgets.filter((w) => !w.isDeleted)

  return (
    <div style={{ display: 'flex', gap: 16, padding: 24, alignItems: 'flex-start' }}>
      {/* Draggable grid */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {visiblePending.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 14, border: '2px dashed #e5e7eb', borderRadius: 10 }}>
            Nessun widget. Aggiungi un report dal pannello a destra.
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visiblePending.map((w) => w.tempId)} strategy={rectSortingStrategy}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16 }}>
                {visiblePending.map((widget) => (
                  <SortableItem
                    key={widget.tempId}
                    widget={widget}
                    onRemove={onRemoveWidget}
                    onUpdateColSpan={onUpdateColSpan}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add widget sidebar */}
      <div style={{ width: 280, flexShrink: 0, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 14, fontWeight: 600, color: 'var(--color-slate)' }}>
          Aggiungi widget
        </div>
        <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
          {templates.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--color-slate-light)' }}>Nessun template disponibile.</div>
          )}
          {templates.map((template) => (
            <div key={template.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <button
                onClick={() => onToggleTemplate(template.id)}
                style={{
                  width: '100%', padding: '10px 14px', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', background: 'none', border: 'none',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', textAlign: 'left',
                }}
              >
                <span>{template.name}</span>
                <span style={{ color: 'var(--color-slate-light)', fontSize: 10 }}>{expandedTemplates.has(template.id) ? '▲' : '▼'}</span>
              </button>
              {expandedTemplates.has(template.id) && (
                <div style={{ background: '#f9fafb', paddingBottom: 4 }}>
                  {(template.sections ?? []).length === 0 && (
                    <div style={{ padding: '6px 14px', fontSize: 12, color: 'var(--color-slate-light)' }}>Nessuna sezione</div>
                  )}
                  {(template.sections ?? []).map((section) => (
                    <div key={section.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#4b5563', flex: 1, minWidth: 0 }}>{section.title}</span>
                      <button
                        onClick={() => onAddWidget(template, section)}
                        style={{
                          padding: '3px 8px', borderRadius: 4, border: '1px solid #0284c7',
                          background: 'var(--color-brand-light)', color: 'var(--color-brand)', fontSize: 12, fontWeight: 600,
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        + Aggiungi
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
