/**
 * «SEGNALA A OPENGRAFO» (26 Sep 2026).
 *
 * On a Problem of the OpenGrafo CI, a person can tell OpenGrafo it is a fault
 * of the product. The dialog shows EXACTLY what leaves this organization — the
 * server builds it, the page only shows it — and asks for a note, which is
 * what the person adds. Once sent, the button gives way to the date; the
 * answers come back as comments on the Problem.
 */
import { Loading } from '@/components/ui/Loading'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLazyQuery, useMutation } from '@apollo/client/react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Textarea } from '@/components/ui/FormControls'
import { GET_OPENGRAFO_REPORT_DRAFT } from '@/graphql/queries/problem'
import { REPORT_PROBLEM_TO_OPENGRAFO } from '@/graphql/mutations/problem'
import { showError } from '@/lib/showError'
import { formatDate } from '@/lib/datetime'

export const MAX_REPORT_NOTE = 2000

interface Props {
  problemId: string
  state: { canReport: boolean; reportedAt: string | null } | null | undefined
  onSent: () => void
}

export function ReportToOpenGrafo({ problemId, state, onSent }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [loadDraft, draft] = useLazyQuery<{ openGrafoReportDraft: Array<{ name: string; value: string }> }>(GET_OPENGRAFO_REPORT_DRAFT, { fetchPolicy: 'network-only' })
  const [send, { loading: sending }] = useMutation(REPORT_PROBLEM_TO_OPENGRAFO, {
    onCompleted: () => { toast.success(t('pages.problemDetail.openGrafoReport.sent')); setOpen(false); onSent() },
    onError: (e) => showError(e),
  })

  if (state?.reportedAt) {
    return (
      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('pages.problemDetail.openGrafoReport.reportedOn', { date: formatDate(state.reportedAt) })}
      </span>
    )
  }
  if (!state?.canReport) return null

  const rows = draft.data?.openGrafoReportDraft ?? []
  const trimmed = note.trim()
  return (
    <>
      <Button variant="secondary" icon={<Send size={13} />} onClick={() => { setOpen(true); void loadDraft({ variables: { problemId } }) }}>
        {t('pages.problemDetail.openGrafoReport.button')}
      </Button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title={t('pages.problemDetail.openGrafoReport.title')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button disabled={sending || draft.loading || !!draft.error || trimmed.length === 0 || trimmed.length > MAX_REPORT_NOTE}
                onClick={() => send({ variables: { problemId, note: trimmed } })}>
                {t('pages.problemDetail.openGrafoReport.send')}
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', marginTop: 0 }}>
            {t('pages.problemDetail.openGrafoReport.hint')}
          </p>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginTop: 12 }}>
            {t('pages.problemDetail.openGrafoReport.whatLeaves')}
          </div>
          {draft.loading && <Loading />}
          {draft.error && <p role="alert" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{draft.error.message}</p>}
          {rows.length > 0 && (
            <dl aria-label={t('pages.problemDetail.openGrafoReport.whatLeaves')} style={{ margin: '6px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 'var(--font-size-body)' }}>
              {rows.map((r) => (
                <div key={r.name} style={{ display: 'contents' }}>
                  <dt style={{ color: 'var(--color-slate-light)', fontFamily: 'var(--font-mono, monospace)' }}>{r.name}</dt>
                  <dd style={{ margin: 0, color: 'var(--color-slate-dark)', wordBreak: 'break-word' }}>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginTop: 14 }}>
            {t('pages.problemDetail.openGrafoReport.note')} *
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={MAX_REPORT_NOTE}
              placeholder={t('pages.problemDetail.openGrafoReport.notePlaceholder')}
              style={{ marginTop: 4, padding: '8px 12px', border: '1px solid var(--border)', fontWeight: 400 }} />
          </label>
          <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            {t('pages.problemDetail.openGrafoReport.noteHint', { count: MAX_REPORT_NOTE - note.length })}
          </p>
        </Modal>
      )}
    </>
  )
}
