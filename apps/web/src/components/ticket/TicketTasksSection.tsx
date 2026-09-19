/**
 * I COMPITI DI UN TICKET, sulla sua pagina (20 set 2026).
 *
 * Li fa partire un passo del workflow: «Nuovo portatile» approvata crea
 * «prepara la macchina» per il Desk e «crea l'utenza» per i Sistemi. Qui si
 * vedono, si chiudono quando il lavoro è fatto, e si annullano — col motivo —
 * quando non servono più.
 *
 * La sezione non c'è quando non ci sono compiti: un riquadro vuoto su ogni
 * ticket è rumore, e la maggior parte dei ticket non ne avrà mai.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle2, Circle, XCircle, Clock, Users, Hourglass } from 'lucide-react'
import { GET_TICKET_TASKS } from '@/graphql/queries'
import { COMPLETE_TICKET_TASK, CANCEL_TICKET_TASK } from '@/graphql/mutations'
import { SectionCard } from '@/components/ui/SectionCard'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Input } from '@/components/ui/FormControls'
import { showError } from '@/lib/showError'
import { formatDate } from '@/lib/datetime'

export interface TicketTaskRow {
  id: string; code: string; title: string; description: string | null
  state: string; afterTitle: string | null; entityType: string; entityId: string; stepName: string
  dueAt: string | null; teamId: string | null; teamName: string | null
  assigneeId: string | null; assigneeName: string | null
  createdAt: string; completedAt: string | null; completedById: string | null
  cancelReason: string | null
}

const APERTO  = 'open'
const ATTESA  = 'waiting'
/** Da fare: aperto o in attesa del suo turno. Sono questi che tengono fermo il passo. */
const daFare = (state: string) => state === APERTO || state === ATTESA

function Stato({ state }: { state: string }) {
  const { t } = useTranslation()
  if (state === 'completed') return <CheckCircle2 size={16} aria-label={t('tasks.state.completed')} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
  if (state === 'cancelled') return <XCircle size={16} aria-label={t('tasks.state.cancelled')} style={{ color: 'var(--color-slate-light)', flexShrink: 0 }} />
  if (state === ATTESA)      return <Hourglass size={16} aria-label={t('tasks.state.waiting')} style={{ color: 'var(--color-slate-light)', flexShrink: 0 }} />
  return <Circle size={16} aria-label={t('tasks.state.open')} style={{ color: 'var(--color-brand)', flexShrink: 0 }} />
}

export function TicketTasksSection({ entityId }: { entityId: string }) {
  const { t } = useTranslation()
  const { data, refetch } = useQuery<{ ticketTasks: TicketTaskRow[] }>(GET_TICKET_TASKS, {
    variables: { entityId },
    fetchPolicy: 'cache-and-network',
  })
  const [completa] = useMutation(COMPLETE_TICKET_TASK)
  const [annulla]  = useMutation(CANCEL_TICKET_TASK)
  /** Il compito che si sta annullando: il motivo è obbligatorio, quindi si chiede. */
  const [daAnnullare, setDaAnnullare] = useState<TicketTaskRow | null>(null)
  const [motivo, setMotivo] = useState('')

  const compiti = data?.ticketTasks ?? []
  if (compiti.length === 0) return null

  // Il conto sono i compiti DA FARE, in attesa compresi: è quello che tiene
  // fermo il passo, ed è la domanda di chi guarda («quanto manca?»).
  const aperti = compiti.filter((c) => daFare(c.state)).length

  const chiudi = async (task: TicketTaskRow) => {
    try {
      await completa({ variables: { taskId: task.id } })
      toast.success(t('tasks.completed', { code: task.code }))
      await refetch()
    } catch (e) { showError(e) }
  }

  const confermaAnnullamento = async () => {
    if (!daAnnullare) return
    try {
      await annulla({ variables: { taskId: daAnnullare.id, reason: motivo } })
      toast.success(t('tasks.cancelled', { code: daAnnullare.code }))
      setDaAnnullare(null); setMotivo('')
      await refetch()
    } catch (e) { showError(e) }
  }

  return (
    <SectionCard
      collapsible={false}
      defaultOpen
      title={t('tasks.title')}
      count={aperti > 0 ? aperti : undefined}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {compiti.map((task) => {
          const chiuso  = !daFare(task.state)
          const inAttesa = task.state === ATTESA
          return (
            <li
              key={task.id}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '12px 16px', borderBottom: '1px solid var(--color-border)',
                opacity: chiuso ? 0.65 : 1,
              }}
            >
              <div style={{ marginTop: 2 }}><Stato state={task.state} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, textDecoration: chiuso ? 'line-through' : 'none' }}>{task.title}</span>
                  <code style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{task.code}</code>
                </div>
                {task.description && (
                  <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{task.description}</p>
                )}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                  {/*
                    Senza squadra non si scrive «—»: si dice che non c'è nessun
                    destinatario, perché è un problema da sistemare (la squadra
                    del passo è stata cancellata) e non un dettaglio mancante.
                  */}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Users size={12} aria-hidden="true" />
                    {task.teamName ?? <em style={{ color: 'var(--color-warning-text)' }}>{t('tasks.noTeam')}</em>}
                  </span>
                  {task.dueAt && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Clock size={12} aria-hidden="true" />
                      {t('tasks.due', { date: formatDate(task.dueAt) })}
                    </span>
                  )}
                  {inAttesa && task.afterTitle && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Hourglass size={12} aria-hidden="true" />
                      {t('tasks.waitingFor', { title: task.afterTitle })}
                    </span>
                  )}
                  {task.state === 'cancelled' && task.cancelReason && (
                    <span>{t('tasks.cancelledBecause', { reason: task.cancelReason })}</span>
                  )}
                </div>
              </div>
              {!chiuso && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {/* «Fatto» non si offre su un compito in attesa: il suo
                      turno non è arrivato, e il server lo rifiuta. */}
                  {!inAttesa && <Button size="sm" onClick={() => void chiudi(task)}>{t('tasks.complete')}</Button>}
                  <Button size="sm" variant="secondary" onClick={() => { setDaAnnullare(task); setMotivo('') }}>
                    {t('tasks.cancel')}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {daAnnullare && (
        <Modal open onClose={() => setDaAnnullare(null)} title={t('tasks.cancelTitle', { code: daAnnullare.code })}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, color: 'var(--color-slate-dark)' }}>{t('tasks.cancelExplain')}</p>
            <Input
              value={motivo}
              placeholder={t('tasks.cancelReasonPlaceholder')}
              onChange={(e) => setMotivo(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setDaAnnullare(null)}>{t('common.cancel')}</Button>
              <Button disabled={!motivo.trim()} onClick={() => void confermaAnnullamento()}>{t('tasks.cancelConfirm')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </SectionCard>
  )
}
