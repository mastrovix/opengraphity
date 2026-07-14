/**
 * Prompt modal for the admin "reopen task" flow. Asks for a reason
 * (min 10 chars) before invoking the parent-provided callback.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { inputStyle } from './shared'

export function ReopenModal({ onConfirm, onCancel }: {
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{t('pages.tasks.reopen.title')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.tasks.reopen.prompt')}</p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', marginBottom: 16 }}
          placeholder={t('pages.tasks.reopen.placeholder')}
          autoFocus
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            disabled={reason.trim().length < 10}
            onClick={() => onConfirm(reason.trim())}
            style={{
              backgroundColor: '#eab308', fontWeight: 600,
              opacity: reason.trim().length >= 10 ? 1 : 0.5,
              fontSize: 'var(--font-size-body)',
            }}
          >
            {t('pages.tasks.reopen.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
