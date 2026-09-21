import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
// G-ANO-6: la severità delle anomalie è una scala del prodotto, non il vocabolario del cliente.
import { AnomalySeverityBadge } from '@/components/ui/badges'
import { colors, alpha } from '@/lib/tokens'
import { formatDateTime } from '@/lib/datetime'
import { RULE_LABEL_KEYS, AnomalyStatusBadge, anomalyEntityTypeLabel, anomalyTitle, anomalyDescription } from './AnomalyPage'
import { ResolutionForm } from './AnomalyModal'
import { useCILabels } from '@/hooks/useCILabels'
import type { Anomaly } from '@/types/anomaly'

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.6 }}>{value}</div>
    </div>
  )
}

export function DetailPanel({
  anomaly,
  stale = false,
  onClose,
  onResolve,
  loading,
  resolveError,
}: {
  anomaly: Anomaly
  /**
   * L'anomalia non è più nell'elenco caricato (revisione totale · G-ANO-10):
   * lo scan l'ha chiusa, o un filtro l'ha esclusa. Il pannello mostra i dati
   * dell'ultima lettura e non offre più «Risolvi», che sovrascriverebbe una
   * chiusura automatica.
   */
  stale?: boolean
  onClose: () => void
  onResolve: (id: string, resolutionStatus: string, note: string) => void
  loading: boolean
  resolveError: string | null
}) {
  const { t } = useTranslation()
  const { typeLabel: etichettaDelTipo } = useCILabels()
  const [showForm, setShowForm] = useState(false)
  /**
   * G-ANO-13: il pannello è un dialogo — si annuncia, prende il fuoco e si
   * chiude con Escape. Prima era un `div` fisso: da tastiera non veniva
   * annunciato e non si poteva chiudere senza mouse. E sotto i 700px occupava
   * quasi tutta la pagina: ora la larghezza si adatta.
   */
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isOpen = anomaly.status === 'open' && !stale

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={anomalyTitle(t, anomaly)}
      tabIndex={-1}
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(420px, 100vw)', background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: `-4px 0 24px ${alpha.black08}`,
        zIndex: 100,
        overflowY: 'auto',
        padding: 24,
      }}>
      {stale && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-table)', color: 'var(--color-warning-text)' }}>
          {t('pages.anomalies.detailStale')}
        </p>
      )}
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {RULE_LABEL_KEYS[anomaly.ruleKey] ? t(RULE_LABEL_KEYS[anomaly.ruleKey]) : anomaly.ruleKey}
          </div>
          <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, lineHeight: 1.4 }}>
            {anomalyTitle(t, anomaly)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, color: colors.slateLight }}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <AnomalySeverityBadge value={anomaly.severity} />
        <AnomalyStatusBadge value={anomaly.status} />
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
        <Field label={t('pages.anomalies.entity')} value={`${anomaly.entityName} (${anomalyEntityTypeLabel(etichettaDelTipo, anomaly)})`} />
        <Field label={t('common.description')} value={anomalyDescription(t, anomaly)} />
        <Field label={t('pages.anomalies.detectedAtCol')} value={formatDateTime(anomaly.detectedAt)} />
        {anomaly.resolvedReason === 'rule_disabled' && (
          <Field label={t('pages.anomalies.resolvedReason')} value={t('pages.anomalies.resolvedByRuleDisabled')} />
        )}
        {anomaly.resolvedAt && (
          <Field label={t('common.resolvedAt')} value={formatDateTime(anomaly.resolvedAt)} />
        )}
        {anomaly.resolutionNote && (
          <Field label={t('common.note')} value={anomaly.resolutionNote} />
        )}
        {/* G-ANO-8: il nome, non l'UUID. Se chi l'ha risolta non è più un
            utente del tenant la riga non compare affatto. */}
        {anomaly.resolvedByName && (
          <Field label={t('common.resolvedBy')} value={anomaly.resolvedByName} />
        )}
      </div>

      {/* Resolution */}
      {isOpen && !showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            width: '100%', padding: '9px 14px', borderRadius: 6, border: 'none',
            background: 'var(--color-brand)', color: colors.white,
            fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('pages.anomalies.resolveAnomaly')}
        </button>
      )}

      {isOpen && showForm && (
        <>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.slateDark, marginBottom: 12 }}>
            {t('pages.anomalies.resolution')}
          </div>
          <ResolutionForm
            anomaly={anomaly}
            loading={loading}
            error={resolveError}
            onCancel={() => setShowForm(false)}
            onConfirm={(resolutionStatus, note) => onResolve(anomaly.id, resolutionStatus, note)}
          />
        </>
      )}
    </div>
  )
}
