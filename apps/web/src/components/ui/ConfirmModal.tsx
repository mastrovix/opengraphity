/**
 * Confirmation dialog on top of `Modal` (E-10 / E-14). Replaces `window.confirm`:
 * translatable, styled, keyboard-accessible (Escape = cancel, the safe
 * "cancel" button receives the initial focus, Tab cycles inside the dialog).
 *
 * Usually driven by `useConfirm()`; can also be rendered directly.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'

export interface ConfirmModalProps {
  open:          boolean
  title:         string
  body?:         ReactNode
  confirmLabel?: string
  cancelLabel?:  string
  /** Destructive action: red confirm button + trash icon. */
  danger?:       boolean
  /** Disables both buttons while the confirmed action is running. */
  loading?:      boolean
  onConfirm:     () => void
  onCancel:      () => void
  zIndex?:       number
}

export function ConfirmModal({
  open, title, body, confirmLabel, cancelLabel, danger = false, loading = false, onConfirm, onCancel, zIndex = 9500,
}: ConfirmModalProps) {
  const { t } = useTranslation()
  const Icon = danger ? Trash2 : AlertTriangle
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={420}
      zIndex={zIndex}
      footerStyle={{ justifyContent: 'flex-end', gap: 10 }}
      footer={
        <>
          <Button
            variant="secondary"
            size="xs"
            onClick={onCancel}
            disabled={loading}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- dialogo di conferma aperto dall'utente: il focus iniziale va sull'azione sicura (Annulla), non sulla X dell'header
            autoFocus
          >
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            size="xs"
            onClick={onConfirm}
            disabled={loading}
            style={danger ? { backgroundColor: 'var(--color-danger)' } : undefined}
          >
            {confirmLabel ?? (danger ? t('common.delete') : t('common.confirm'))}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Icon size={22} color={danger ? 'var(--color-danger)' : 'var(--color-warning)'} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', lineHeight: 1.5 }}>
          {body ?? t('confirm.irreversible')}
        </div>
      </div>
    </Modal>
  )
}
