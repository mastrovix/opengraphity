import { useTranslation } from 'react-i18next'

import { ReportChartRenderer } from '@/components/ReportChartRenderer'
import { CHART_TYPES } from '@/components/ReportChartConfig'
import { ReportSectionBuilder, type ReportSectionInput } from '@/components/ReportSectionBuilder'
import {
  type ReportTemplate, type ReportSection, type SectionResult, type View,
  btnPrimary, btnGhost,
} from './useCustomReports'

import { getReportIcon } from './reportIcons'
import { colors } from '@/lib/tokens'
import { useFieldValueLabel } from '@/hooks/useFieldValueLabel'

/** Il tipo di grafico col suo nome (giro UI del 15 set 2026: si leggeva «bar»). */
function chartTypeLabel(t: (key: string) => string, chartType: string): string {
  const def = CHART_TYPES.find((c) => c.value === chartType)
  return def ? t(def.labelKey) : chartType
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
  openSettings: (tpl: ReportTemplate) => void
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
  // `t` NON si rinomina: `scripts/check-i18n.mjs` cerca `t('…')`, e con
  // l'alias `tr` le sue chiavi erano invisibili al controllo. Cinque chiavi
  // `pages.reportBuilder.*` mancavano da entrambe le lingue e la pagina
  // mostrava i nomi delle chiavi — trovato girando nel browser, non dai test.
  const { t } = useTranslation()
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
        <div style={{ padding: '12px 32px', borderBottom: '1px solid var(--color-border)', background: colors.white, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button type="button" onClick={() => setView('detail')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)' }}>&larr; {t('common.back')}</button>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{t('pages.reports.addSectionTo', { report: selected.name })}</span>
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
        <div style={{ padding: '12px 32px', borderBottom: '1px solid var(--color-border)', background: colors.white, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <button type="button" onClick={cancelEditSection} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)' }}>&larr; {t('common.back')}</button>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{t('pages.reports.editSectionOf', { section: editSection.title })}</span>
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
      <div style={{ padding: '12px 32px', borderBottom: '1px solid var(--color-border)', background: colors.white, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button type="button" onClick={() => setView('list')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', gap: 6 }}>
          &larr; {t('pages.reports.allReports')}
        </button>
        <span style={{ display: 'flex', alignItems: 'center' }}>{getReportIcon(selected)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section-title)', color: 'var(--color-slate-dark)' }}>{selected.name}</div>
          {selected.description && <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{selected.description}</div>}
        </div>
        <button type="button" onClick={() => openSettings(selected)} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>&#x2699; {t('citypeDesigner.tab.settings')}</button>
        <button
          type="button"
          onClick={handleExecuteSelected}
          disabled={execLoading}
          style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}
        >{execLoading ? t('common.loading') : `\u25B6 ${t('pages.reportBuilder.execute')}`}</button>
        <button type="button" onClick={() => void handleExportPDF()} disabled={exportingPDF} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>
          {exportingPDF ? '\u2026' : '\u2193 PDF'}
        </button>
        <button type="button" onClick={() => void handleExportExcel()} disabled={exportingExcel} style={{ ...btnGhost, fontSize: 'var(--font-size-body)' }}>
          {exportingExcel ? '\u2026' : '\u2193 Excel'}
        </button>
        <button type="button" onClick={() => setView('add-section')} style={btnPrimary}>{t('pages.reports.addSection')}</button>
      </div>

      {/* Sections */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {selected.sections.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-card-title)', paddingTop: 60 }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>&#x1F4CB;</div>
            {t('pages.reports.noSections')}
          </div>
        )}
        {[...selected.sections].sort((a, b) => a.order - b.order).map(sec => {
          const result = sectionResults[sec.id]
          return (
            <div key={sec.id} style={{ border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden', background: colors.white }}>
              <div style={{ padding: '10px 16px', background: 'var(--color-slate-bg)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{sec.title}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: colors.border, padding: '2px 6px', borderRadius: 4 }}>{chartTypeLabel(t, sec.chartType)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => startEditSection(sec)}
                    style={{ ...btnGhost, padding: '4px 10px', fontSize: 'var(--font-size-body)' }}>&#x270F; {t('pages.reports.editSection')}</button>
                  <button type="button" onClick={() => handleRemoveSection(selected.id, sec.id)}
                    style={{ ...btnGhost, padding: '4px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>&#x1F5D1;</button>
                </div>
              </div>
              <div style={{ padding: 16 }}>
                {result ? (
                  <SectionChart section={sec} result={result} />
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-card-title)', padding: 24 }}>
                    {t('pages.reports.clickRunToLoad')}
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

/**
 * Il grafico di una sezione, coi valori raggruppati come li chiama il cliente.
 * Il tipo del nodo di raggruppamento viene dall'etichetta Neo4j dei ticket
 * («ServiceRequest» → `service_request`) o dal nome del tipo CI.
 */
function SectionChart({ section, result }: { section: ReportSection; result: SectionResult }) {
  const node = section.nodes.find((n) => n.id === section.groupByNodeId) ?? null
  const entity = node ? node.entityType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : null
  const valueLabel = useFieldValueLabel(entity, section.groupByField)
  /*
   * `errorKey` ANCHE QUI (20 set 2026). Il renderer sa tradurre l'errore di
   * una sezione da quando l'ANTEPRIMA mostrava «a table section needs at
   * least one selected field on a result node (isResult = true)» in
   * italiano — ma la pagina che ESEGUE il report, cioè quella che l'errore
   * lo fa vedere davvero, la chiave non la passava: ogni errore di sezione
   * arrivava in inglese e con l'id interno della sezione dentro. La
   * correzione di allora era finita su un cammino solo.
   */
  return <ReportChartRenderer chartType={result.chartType} data={result.data} title={result.title} error={result.error} errorKey={result.errorKey} valueLabel={valueLabel} granularita={section.groupByGranularity} />
}

