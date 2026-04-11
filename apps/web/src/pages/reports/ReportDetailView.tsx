import { useTranslation } from 'react-i18next'
import { Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp, Table as TableIcon } from 'lucide-react'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'
import { ReportSectionBuilder, type ReportSectionInput } from '@/components/ReportSectionBuilder'
import {
  type ReportTemplate, type ReportSection, type SectionResult, type View,
  btnPrimary, btnGhost,
} from './useCustomReports'

// ── Chart icon helper ────────────────────────────────────────────────────────

const CHART_ICON_MAP: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  kpi: Hash, pie: PieChart, donut: CircleDot,
  bar: BarChart2, bar_horizontal: BarChart,
  line: LineChart, area: TrendingUp, table: TableIcon,
}

function getReportIcon(template: ReportTemplate) {
  const chartType = template.sections?.[0]?.chartType ?? 'bar'
  const Icon = CHART_ICON_MAP[chartType] ?? BarChart2
  return <Icon size={20} color="var(--color-brand)" />
}

// ── Props ────────────────────────────────────────────────────────────────────

interface ReportDetailViewProps {
  view: View
  selected: ReportTemplate
  editSection: ReportSection | null
  sectionResults: Record<string, SectionResult>
  execLoading: boolean
  exportingPDF: boolean
  exportingExcel: boolean
  // Navigation
  setView: (v: View) => void
  openSettings: (t: ReportTemplate) => void
  // Section handlers
  handleAddSection: (input: ReportSectionInput) => void
  handleUpdateSection: (input: ReportSectionInput) => void
  handleRemoveSection: (templateId: string, sectionId: string) => void
  startEditSection: (sec: ReportSection) => void
  cancelEditSection: () => void
  sectionToInput: (s: ReportSection) => ReportSectionInput
  // Execute/export
  handleExecuteSelected: () => void
  handleExportPDF: () => void
  handleExportExcel: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReportDetailView(props: ReportDetailViewProps) {
  const { t: tr } = useTranslation()
  const {
    view, selected, editSection, sectionResults,
    execLoading, exportingPDF, exportingExcel,
    setView, openSettings,
    handleAddSection, handleUpdateSection, handleRemoveSection, startEditSection, cancelEditSection, sectionToInput,
    handleExecuteSelected, handleExportPDF, handleExportExcel,
  } = props

  // ── ADD SECTION ──
  if (view === 'add-section') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button onClick={() => setView('detail')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)' }}>&larr; Indietro</button>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Aggiungi sezione &mdash; {selected.name}</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ReportSectionBuilder onSave={handleAddSection} onCancel={() => setView('detail')} />
        </div>
      </div>
    )
  }

  // ── EDIT SECTION ──
  if (view === 'edit-section' && editSection) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button onClick={cancelEditSection} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)' }}>&larr; Indietro</button>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Modifica sezione: {editSection.title}</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ReportSectionBuilder
            initialValues={sectionToInput(editSection)}
            onSave={handleUpdateSection}
            onCancel={cancelEditSection}
          />
        </div>
      </div>
    )
  }

  // ── DETAIL ──
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => setView('list')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', gap: 6 }}>
          &larr; Tutti i report
        </button>
        <span style={{ display: 'flex', alignItems: 'center' }}>{getReportIcon(selected)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section-title)', color: 'var(--color-slate-dark)' }}>{selected.name}</div>
          {selected.description && <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{selected.description}</div>}
        </div>
        <button onClick={() => openSettings(selected)} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>&#x2699; Impostazioni</button>
        <button
          onClick={handleExecuteSelected}
          disabled={execLoading}
          style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}
        >{execLoading ? tr('common.loading') : `\u25B6 ${tr('pages.reportBuilder.execute')}`}</button>
        <button onClick={() => void handleExportPDF()} disabled={exportingPDF} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>
          {exportingPDF ? '\u2026' : '\u2193 PDF'}
        </button>
        <button onClick={() => void handleExportExcel()} disabled={exportingExcel} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>
          {exportingExcel ? '\u2026' : '\u2193 Excel'}
        </button>
        <button onClick={() => setView('add-section')} style={btnPrimary}>+ Sezione</button>
      </div>

      {/* Sections */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {selected.sections.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-card-title)', paddingTop: 60 }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>&#x1F4CB;</div>
            Nessuna sezione. Clicca "+ Sezione" per iniziare.
          </div>
        )}
        {[...selected.sections].sort((a, b) => a.order - b.order).map(sec => {
          const result = sectionResults[sec.id]
          return (
            <div key={sec.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
              <div style={{ padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{sec.title}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: '#e5e7eb', padding: '2px 6px', borderRadius: 4 }}>{sec.chartType}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => startEditSection(sec)}
                    style={{ ...btnGhost, padding: '4px 10px', fontSize: 'var(--font-size-body)' }}>&#x270F; Modifica sezione</button>
                  <button onClick={() => handleRemoveSection(selected.id, sec.id)}
                    style={{ ...btnGhost, padding: '4px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>&#x1F5D1;</button>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                {result ? (
                  <ReportChartRenderer chartType={result.chartType} data={result.data} title={result.title} error={result.error} />
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-card-title)', padding: 24 }}>
                    Clicca &quot;&#x25B6; Esegui&quot; per caricare i dati
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
