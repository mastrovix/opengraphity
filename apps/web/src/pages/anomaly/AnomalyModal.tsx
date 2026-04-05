import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { RULE_SUGGESTION_KEYS } from './AnomalyPage'

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

export function ResolutionForm({
  anomaly,
  onConfirm,
  onCancel,
  loading,
  error,
}: {
  anomaly: Anomaly
  onConfirm: (resolutionStatus: string, note: string) => void
  onCancel: () => void
  loading: boolean
  error?: string | null
}) {
  const { t } = useTranslation()
  const [resolutionStatus, setResolutionStatus] = useState('')
  const [note, setNote]                         = useState('')

  const suggestionKey = RULE_SUGGESTION_KEYS[anomaly.ruleKey]
  const suggestion    = suggestionKey ? t(suggestionKey) : null
  const isValid       = resolutionStatus !== '' && note.trim().length >= 10

  const resolutionOptions = [
    { value: 'resolved',       label: t('pages.anomalies.resolutionResolved') },
    { value: 'false_positive', label: t('pages.anomalies.resolutionFalsePositive') },
    { value: 'accepted_risk',  label: t('pages.anomalies.resolutionAcceptedRisk') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Suggestion box */}
      {suggestion && (
        <div style={{
          background: 'var(--color-brand-light, #eff6ff)',
          borderLeft: `3px solid var(--color-brand)`,
          borderRadius: '0 6px 6px 0',
          padding: '10px 14px',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <Lightbulb size={15} color="var(--color-brand)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 13, color: colors.slateDark, lineHeight: 1.6 }}>
            {suggestion}
          </span>
        </div>
      )}

      {/* Resolution status dropdown */}
      <div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
          {t('pages.anomalies.actionLabel')}
        </label>
        <select
          value={resolutionStatus}
          onChange={(e) => setResolutionStatus(e.target.value)}
          style={{
            width: '100%', height: 36, fontSize: 13,
            border: `1px solid ${colors.border}`, borderRadius: 6,
            padding: '0 10px', background: 'var(--surface)',
            color: resolutionStatus ? colors.slateDark : colors.slateLight,
            cursor: 'pointer', appearance: 'auto',
          }}
        >
          <option value="" disabled>{t('pages.anomalies.actionPlaceholder')}</option>
          {resolutionOptions.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Note textarea */}
      <div>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
          {t('pages.anomalies.noteLabel')}
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('pages.anomalies.notePlaceholder')}
          rows={4}
          style={{
            width: '100%', fontSize: 13, lineHeight: 1.6,
            border: `1px solid ${colors.border}`, borderRadius: 6,
            padding: '8px 10px', resize: 'vertical',
            background: 'var(--surface)', color: colors.slateDark,
            boxSizing: 'border-box',
          }}
        />
        <div style={{ fontSize: 11, color: note.trim().length < 10 ? colors.slateLight : colors.success, marginTop: 4 }}>
          {t('pages.anomalies.minChars', { count: note.trim().length })}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: colors.danger, padding: '8px 12px', background: '#fff5f5', border: `1px solid ${colors.danger}`, borderRadius: 6 }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={!isValid || loading}
          onClick={() => onConfirm(resolutionStatus, note.trim())}
          style={{
            flex: 1, padding: '9px 14px', borderRadius: 6, border: 'none',
            background: isValid && !loading ? 'var(--color-brand)' : '#c4c9d4',
            color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: isValid && !loading ? 'pointer' : 'not-allowed',
            transition: 'background 150ms',
          }}
        >
          {loading ? t('pages.anomalies.saving') : t('pages.anomalies.confirmResolution')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          style={{
            padding: '9px 14px', borderRadius: 6,
            border: `1px solid ${colors.border}`, background: 'transparent',
            color: colors.slate, fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
