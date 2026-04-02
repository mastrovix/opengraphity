import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'

// ── Panel styles ──────────────────────────────────────────────────────────────

export const panelStyle: React.CSSProperties = {
  width:           300,
  backgroundColor: '#ffffff',
  border:          '1px solid #e2e6f0',
  borderRadius:    10,
  padding:         20,
  boxShadow:       '0 4px 24px rgba(0,0,0,0.1)',
  display:         'flex',
  flexDirection:   'column',
  gap:             14,
}

export const panelInputStyle: React.CSSProperties = {
  width:           '100%',
  padding:         '7px 10px',
  border:          '1px solid #e2e6f0',
  borderRadius:    6,
  fontSize:        13,
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: '#fafafa',
  boxSizing:       'border-box',
}

export function saveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 0',
    backgroundColor: disabled ? '#e2e6f0' : colors.brand,
    color:           disabled ? colors.slateLight : colors.white,
    border:          'none',
    borderRadius:    6,
    fontSize:        13,
    fontWeight:      600,
    cursor:          disabled ? 'not-allowed' : 'pointer',
    width:           '100%',
  }
}

export function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-slate-dark)' }}>{title}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0 }}>
        <X size={16} />
      </button>
    </div>
  )
}

export function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

// ── Action descriptions ───────────────────────────────────────────────────────

const ACTION_DESCRIPTIONS: Record<string, string> = {
  sla_start:    'Avvia timer SLA',
  sla_stop:     'Ferma timer SLA',
  schedule_job: 'Pianifica job automatico',
  cancel_job:   'Annulla job pianificato',
  notify_rule:  'Regola notifica',
}
void ACTION_DESCRIPTIONS // used as fallback reference; i18n is primary

export function actionLabel(t: (key: string) => string, type: string, params?: Record<string, unknown>): string {
  const base = t(`workflow.actions.${type}`)

  if (type === 'sla_start' || type === 'sla_stop') {
    const slaType = params?.['sla_type'] as string | undefined
    if (slaType === 'response') return `${base} ${t('workflow.actions.sla_response')}`
    if (slaType === 'resolve')  return `${base} ${t('workflow.actions.sla_resolve')}`
    return base
  }

  if (type === 'schedule_job') {
    const job   = params?.['job']         as string | undefined
    const hours = params?.['delay_hours'] as number | string | undefined
    if (job) {
      const raw      = t(`workflow.actions.${job}`)
      const display  = raw !== `workflow.actions.${job}` ? raw : job
      const verb     = base.split(' ')[0]
      return hours
        ? `${verb} ${display} ${t('workflow.actions.after')} ${hours}h`
        : `${verb} ${display}`
    }
    return base
  }

  if (type === 'cancel_job') {
    const job = params?.['job'] as string | undefined
    if (job) {
      const raw     = t(`workflow.actions.${job}`)
      const display = raw !== `workflow.actions.${job}` ? raw : job
      return `${base.split(' ')[0]} ${display}`
    }
    return base
  }

  if (type === 'create_entity') {
    const et = params?.['entity_type'] as string | undefined
    return et ? `${base}: ${et}` : base
  }

  if (type === 'assign_to') {
    const tt  = params?.['target_type'] as string | undefined
    const tid = (params?.['target_id'] ?? params?.['target_name']) as string | undefined
    return tid ? `${base} → ${tt ?? ''} ${tid.slice(0, 8)}` : base
  }

  if (type === 'update_field') {
    const f = params?.['field'] as string | undefined
    const v = params?.['value'] as string | undefined
    return f ? `${base}: ${f}=${v ?? '?'}` : base
  }

  if (type === 'call_webhook') {
    const url = params?.['url'] as string | undefined
    if (url) {
      try { return `${base}: ${new URL(url).hostname}` } catch { return base }
    }
    return base
  }

  return base
}

export function paramsToRaw(type: string, params?: Record<string, unknown>): Record<string, string> {
  if (!params) return {}
  if (type === 'sla_start' || type === 'sla_stop') return { sla_type: String(params['sla_type'] ?? 'response') }
  if (type === 'schedule_job') return { job: String(params['job'] ?? ''), delay_hours: String(params['delay_hours'] ?? '') }
  if (type === 'cancel_job')   return { job: String(params['job'] ?? '') }
  if (type === 'create_entity') return {
    entity_type:     String(params['entity_type']     ?? 'incident'),
    title_template:  String(params['title_template']  ?? ''),
    link_to_current: String(params['link_to_current'] ?? 'true'),
    copy_fields:     Array.isArray(params['copy_fields']) ? (params['copy_fields'] as string[]).join(',') : String(params['copy_fields'] ?? ''),
  }
  if (type === 'assign_to') return {
    target_type: String(params['target_type'] ?? 'team'),
    target_id:   String(params['target_id']   ?? ''),
    target_name: String(params['target_name'] ?? ''),
  }
  if (type === 'update_field') return {
    field: String(params['field'] ?? 'severity'),
    value: String(params['value'] ?? ''),
  }
  if (type === 'call_webhook') return {
    url:              String(params['url']              ?? ''),
    method:           String(params['method']           ?? 'POST'),
    payload_template: String(params['payload_template'] ?? ''),
  }
  return {}
}

export function buildActionParams(type: string, raw: Record<string, string>): Record<string, unknown> {
  if (type === 'sla_start' || type === 'sla_stop') {
    return { sla_type: raw['sla_type'] ?? 'response' }
  }
  if (type === 'schedule_job') {
    return { job: raw['job'] ?? '', delay_hours: raw['delay_hours'] ? Number(raw['delay_hours']) : 0 }
  }
  if (type === 'cancel_job') {
    return { job: raw['job'] ?? '' }
  }
  if (type === 'create_entity') {
    const copyFields = raw['copy_fields'] ? raw['copy_fields'].split(',').map((s) => s.trim()).filter(Boolean) : []
    return {
      entity_type:     raw['entity_type']    ?? 'incident',
      title_template:  raw['title_template'] ?? '',
      link_to_current: raw['link_to_current'] !== 'false',
      ...(copyFields.length > 0 ? { copy_fields: copyFields } : {}),
    }
  }
  if (type === 'assign_to') {
    return {
      target_type: raw['target_type'] ?? 'team',
      ...(raw['target_id']   ? { target_id:   raw['target_id']   } : {}),
      ...(raw['target_name'] ? { target_name: raw['target_name'] } : {}),
    }
  }
  if (type === 'update_field') {
    return { field: raw['field'] ?? 'severity', value: raw['value'] ?? '' }
  }
  if (type === 'call_webhook') {
    return {
      url:              raw['url']              ?? '',
      method:           raw['method']           ?? 'POST',
      payload_template: raw['payload_template'] ?? '',
    }
  }
  return {}
}

export function ActionBadge({ type, params }: { type: string; params?: Record<string, unknown> }) {
  const { t } = useTranslation()
  return (
    <span
      title={type}
      style={{
        fontSize:        10,
        padding:         '2px 6px',
        borderRadius:    4,
        backgroundColor: colors.brandLight,
        color:           colors.brand,
        fontWeight:      500,
        cursor:          'default',
      }}
    >
      {actionLabel(t, type, params)}
    </span>
  )
}
