/**
 * THE MOVE TO KNOWN ERROR (tour of 24 Sep 2026, G22).
 *
 * A known error is a problem with its cause and its workaround: the API
 * refuses the move without them. The dialog asks for both, saves them when
 * they changed — the fields first, because the move reads them from the
 * problem — and only then moves. A failed save leaves the dialog open with
 * what was typed.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Textarea } from '@/components/ui/FormControls'

interface KnownErrorDialogProps {
  stepLabel: string
  rootCause: string
  workaround: string
  busy: boolean
  onClose: () => void
  /** Saves the two fields; true when they were saved. */
  save: (rootCause: string, workaround: string) => Promise<boolean>
  /** The move itself, with the cause as its notes when the transition asks for some. */
  move: (notes: string) => Promise<unknown>
}

const LABEL = { display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)' } as const
const FIELD = { marginTop: 4, padding: '8px 12px', border: '1px solid var(--border)', fontWeight: 400 } as const

export function KnownErrorDialog({ stepLabel, rootCause: savedCause, workaround: savedWorkaround, busy, onClose, save, move }: KnownErrorDialogProps) {
  const { t } = useTranslation()
  const [rootCause, setRootCause] = useState(savedCause)
  const [workaround, setWorkaround] = useState(savedWorkaround)

  const confirm = async () => {
    const cause = rootCause.trim()
    const fix = workaround.trim()
    const changed = cause !== savedCause.trim() || fix !== savedWorkaround.trim()
    if (changed && !(await save(cause, fix))) return
    onClose()
    await move(cause)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('pages.incidents.transitionTo', { step: stepLabel })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={busy || !rootCause.trim() || !workaround.trim()} onClick={confirm}>
            {busy ? t('pages.incidentDetail.running') : t('common.confirm')}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
        {t('pages.problemDetail.knownErrorHint')}
      </p>
      <label style={{ ...LABEL, marginBottom: 4 }}>
        {t('pages.problemDetail.rootCause')} *
        <Textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={3} style={FIELD} />
      </label>
      <label style={{ ...LABEL, marginTop: 12 }}>
        {t('pages.problemDetail.workaround')} *
        <Textarea value={workaround} onChange={(e) => setWorkaround(e.target.value)} rows={3} style={FIELD} />
      </label>
    </Modal>
  )
}
