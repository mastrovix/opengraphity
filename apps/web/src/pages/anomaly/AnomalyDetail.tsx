import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { SeverityBadge } from '@/components/SeverityBadge'
import { colors } from '@/lib/tokens'
import { CI_TYPE_KEYS, RULE_LABEL_KEYS } from './AnomalyPage'
import { AnomalyStatusBadge } from './AnomalyPage'
import { ResolutionForm } from './AnomalyModal'

interface Anomaly {
  id:               string
  ruleKey:          string
  title:            string
  severity:         string
  status:           string
  entityId:         string
  entityType:       string
  entitySubtype:    string
  entityName:       string
  description:      string
  detectedAt:       string
  resolvedAt:       string | null
  resolutionStatus: string | null
  resolutionNote:   string | null
  resolvedBy:       string | null
}

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
  onClose,
  onResolve,
  loading,
  resolveError,
}: {
  anomaly: Anomaly
  onClose: () => void
  onResolve: (id: string, resolutionStatus: string, note: string) => void
  loading: boolean
  resolveError: string | null
}) {
  const { t } = useTranslation()
  const [showForm, setShowForm] = useState(false)

  const isOpen = anomaly.status === 'open'

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0,
      width: 420, background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
      zIndex: 100,
      overflowY: 'auto',
      padding: 24,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
            {RULE_LABEL_KEYS[anomaly.ruleKey] ? t(RULE_LABEL_KEYS[anomaly.ruleKey]) : anomaly.ruleKey}
          </div>
          <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, lineHeight: 1.4 }}>
            {anomaly.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, color: colors.slateLight }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <SeverityBadge value={anomaly.severity} />
        <AnomalyStatusBadge value={anomaly.status} />
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
        <Field label={t('pages.anomalies.entity')} value={`${anomaly.entityName} (${CI_TYPE_KEYS[anomaly.entitySubtype] ? t(CI_TYPE_KEYS[anomaly.entitySubtype]) : (anomaly.entitySubtype ?? anomaly.entityType)})`} />
        <Field label={t('common.description')} value={anomaly.description} />
        <Field label={t('pages.anomalies.detectedAtCol')} value={new Date(anomaly.detectedAt).toLocaleString()} />
        {anomaly.resolvedAt && (
          <Field label={t('common.resolvedAt')} value={new Date(anomaly.resolvedAt).toLocaleString()} />
        )}
        {anomaly.resolutionNote && (
          <Field label={t('common.note')} value={anomaly.resolutionNote} />
        )}
        {anomaly.resolvedBy && (
          <Field label={t('common.resolvedBy')} value={anomaly.resolvedBy} />
        )}
      </div>

      {/* Resolution */}
      {isOpen && !showForm && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            width: '100%', padding: '9px 14px', borderRadius: 6, border: 'none',
            background: 'var(--color-brand)', color: '#fff',
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
