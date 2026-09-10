import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Hash, BarChart2, TrendingUp, PieChart, Table, Gauge, Plus, Pencil, Trash2, Radar, Boxes } from 'lucide-react'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'
import type { CustomWidgetData } from './CustomWidgetCard'
const CustomWidgetCard = lazy(() => import('./CustomWidgetCard').then(m => ({ default: m.CustomWidgetCard })))
import { lookupOrError, alpha, colors, palette } from '@/lib/tokens'

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

export interface DashboardEditModeProps {
  pendingWidgets:      PendingWidget[]
  templates:           ReportTemplate[]
  expandedTemplates:   Set<string>
  customWidgets:       CustomWidgetData[]
  onDragEnd:           (event: DragEndEvent) => void
  onRemoveWidget:      (tempId: string) => void
  onUpdateColSpan:     (tempId: string, colSpan: number) => void
  onAddWidget:         (template: ReportTemplate, section: ReportSection) => void
  onToggleTemplate:    (templateId: string) => void
  onAddCustomWidget:   () => void
  onEditCustomWidget:  (widget: CustomWidgetData) => void
  onDeleteCustomWidget:(widgetId: string) => void
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  counter: Hash, chart_bar: BarChart2, chart_line: TrendingUp,
  chart_pie: PieChart, chart_donut: PieChart, table: Table,
  gauge: Gauge, active_alarms: Radar, service_health: Boxes,
}

// ── SortableItem (report widget) ──────────────────────────────────────────────

function SortableItem({
  widget, onRemove, onUpdateColSpan,
}: {
  widget: PendingWidget
  onRemove: (tempId: string) => void
  onUpdateColSpan: (tempId: string, colSpan: number) => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.tempId })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, gridColumn: `span ${widget.colSpan}`, opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
    >
      <div style={{ border: '2px dashed var(--color-brand)', borderRadius: 10, background: colors.white, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span {...listeners} style={{ cursor: 'grab', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', userSelect: 'none' }} title={t('pages.dashboard.drag')}>⠿</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {widget.reportSection?.title ?? t('pages.dashboard.widgetFallback')}
              {widget.isNew && <span style={{ marginLeft: 6, fontSize: 'var(--font-size-label)', color: 'var(--color-brand)' }}>{t('pages.dashboard.newBadge')}</span>}
            </div>
            {widget.reportTemplate?.name && (
              <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{widget.reportTemplate.name}</div>
            )}
          </div>
          <select
            value={widget.colSpan}
            onChange={(e) => onUpdateColSpan(widget.tempId, Number(e.target.value))}
            aria-label={t('pages.dashboard.widthColumns')}
            style={{ fontSize: 'var(--font-size-table)', padding: '2px 4px', borderRadius: 4, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)' }}
          >
            {[2, 3, 4, 6, 12].map((s) => <option key={s} value={s}>{t('pages.dashboard.cols', { count: s })}</option>)}
          </select>
          <button
            type="button"
            onClick={() => onRemove(widget.tempId)}
            aria-label={t('pages.dashboard.removeWidget')}
            title={t('pages.dashboard.removeWidget')}
            style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--color-danger-border-strong)', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
          >×</button>
        </div>
        <div style={{ position: 'relative' }}>
          <ReportChartRenderer chartType={widget.reportSection?.chartType ?? 'bar'} data={widget.data ?? ''} title={widget.reportSection?.title ?? ''} error={null} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: alpha.white40 }} />
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
  customWidgets,
  onDragEnd,
  onRemoveWidget,
  onUpdateColSpan,
  onAddWidget,
  onToggleTemplate,
  onAddCustomWidget,
  onEditCustomWidget,
  onDeleteCustomWidget,
}: DashboardEditModeProps) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const visiblePending = pendingWidgets.filter((w) => !w.isDeleted)
  const hasAny = visiblePending.length > 0 || customWidgets.length > 0

  return (
    <div style={{ display: 'flex', gap: 16, padding: '20px 20px 20px 20px', alignItems: 'flex-start', boxSizing: 'border-box', width: '100%' }}>

      {/* ── Main grid ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!hasAny ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-card-title)', border: '2px dashed var(--color-border)', borderRadius: 12, background: palette.neutral.surface1 }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📊</div>
            <div style={{ fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>{t('pages.dashboard.emptyEditTitle')}</div>
            {t('pages.dashboard.emptyEditHint')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Report widgets (drag-sortable) */}
            {visiblePending.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={visiblePending.map((w) => w.tempId)} strategy={rectSortingStrategy}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16 }}>
                    {visiblePending.map((w) => (
                      <SortableItem key={w.tempId} widget={w} onRemove={onRemoveWidget} onUpdateColSpan={onUpdateColSpan} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Custom widgets */}
            {customWidgets.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16 }}>
                {customWidgets.map((w) => (
                  <Suspense key={w.id} fallback={<div style={{ minHeight: 120 }} />}>
                    <CustomWidgetCard
                      widget={w}
                      editMode={true}
                      onEdit={() => onEditCustomWidget(w)}
                      onRemove={() => onDeleteCustomWidget(w.id)}
                    />
                  </Suspense>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Right sidebar ─────────────────────────────────────────────────── */}
      <div style={{ width: 290, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── SECTION 1: Widget personalizzati ────────────────────────────── */}
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, background: colors.white, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-brand)' }} />
            <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.dashboard.customWidgets')}</span>
          </div>

          <div style={{ padding: 14 }}>
            <button
              type="button"
              onClick={onAddCustomWidget}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: '10px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600,
                border: '2px dashed var(--color-brand)',
                background: palette.info.light, color: 'var(--color-brand)',
              }}
            >
              <Plus size={15} />
              {t('pages.dashboard.createWidget')}
            </button>

            {/* Description */}
            <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.6 }}>
              {t('pages.dashboard.customWidgetsDesc')}
            </p>

            {/* Existing custom widgets */}
            {customWidgets.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate-light)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 2 }}>
                  {t('pages.dashboard.createdCount', { count: customWidgets.length })}
                </div>
                {customWidgets.map((w) => {
                  const Icon = lookupOrError(TYPE_ICONS, w.widgetType, 'TYPE_ICONS', BarChart2)
                  return (
                    <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--color-border-light)', background: palette.neutral.surface1 }}>
                      <Icon size={12} color={w.color} />
                      <span style={{ flex: 1, fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                      <button
                        type="button"
                        onClick={() => onEditCustomWidget(w)}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--color-slate-light)', display: 'flex', alignItems: 'center' }}
                      ><Pencil size={11} /></button>
                      <button
                        type="button"
                        onClick={() => onDeleteCustomWidget(w.id)}
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: palette.danger.borderStrong, display: 'flex', alignItems: 'center' }}
                      ><Trash2 size={11} /></button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── SECTION 2: Aggiungi da report ───────────────────────────────── */}
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, background: colors.white, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: palette.success.base }} />
            <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.dashboard.addFromReport')}</span>
          </div>

          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {templates.length === 0 ? (
              <div style={{ padding: '14px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', textAlign: 'center' }}>{t('pages.dashboard.noReports')}</div>
            ) : (
              templates.map((template) => (
                <div key={template.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                  <button
                    type="button"
                    aria-expanded={expandedTemplates.has(template.id)}
                    onClick={() => onToggleTemplate(template.id)}
                    style={{ width: '100%', padding: '9px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'left' }}
                  >
                    <span>{template.name}</span>
                    <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)' }}>{expandedTemplates.has(template.id) ? '▲' : '▼'}</span>
                  </button>
                  {expandedTemplates.has(template.id) && (
                    <div style={{ background: 'var(--color-slate-bg)', paddingBottom: 4 }}>
                      {(template.sections ?? []).length === 0 && (
                        <div style={{ padding: '6px 14px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.dashboard.noSections')}</div>
                      )}
                      {(template.sections ?? []).map((section) => (
                        <div key={section.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 14px', gap: 8 }}>
                          <span style={{ fontSize: 'var(--font-size-body)', color: palette.neutral.textStrong, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.title}</span>
                          <button
                            type="button"
                            onClick={() => onAddWidget(template, section)}
                            aria-label={t('pages.dashboard.addSection', { name: section.title })}
                            style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-brand)', background: 'var(--color-brand-light)', color: 'var(--color-brand)', fontSize: 'var(--font-size-table)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >+ {t('pages.dashboard.add')}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
