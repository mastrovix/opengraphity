/**
 * Prompt modal for the admin "reopen task" flow. Asks for a reason
 * (min 10 chars) before invoking the parent-provided callback.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { inputStyle } from './shared'

export function ReopenModal({ onConfirm, onCancel }: {
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('pages.tasks.reopen.title')}
      width={440}
      footer={
        <>
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
        </>
      }
    >
      <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('pages.tasks.reopen.prompt')}</p>
      <textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        rows={3}
        style={{ ...inputStyle, resize: 'vertical' }}
        placeholder={t('pages.tasks.reopen.placeholder')}
        autoFocus
      />
    </Modal>
  )
}
