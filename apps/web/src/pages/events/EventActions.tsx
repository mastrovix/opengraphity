/**
 * Azioni su un evento (operator/admin): presa in carico, risoluzione con nota,
 * apertura incident, collegamento a un CI. Usato sia nella riga della console
 * sia nel dettaglio: ogni istanza possiede i propri dialoghi, che vengono
 * montati solo quando aperti. Il viewer non vede nulla (il genitore non lo
 * renderizza), la guardia sul ruolo resta comunque nell'API.
 */
import { useState, useId, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Hand, CheckCircle2, AlertCircle, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Input, Textarea, FieldLabel } from '@/components/ui/FormControls'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_ALL_CIS } from '@/graphql/queries'
import { ACKNOWLEDGE_EVENT, RESOLVE_EVENT, LINK_EVENT_TO_CI, CREATE_INCIDENT_FROM_EVENT } from '@/graphql/mutations'
import { isActiveEvent } from './eventShared'
import type { MonitoringEvent } from '@/types/events'

interface CISearchRow { id: string; name: string; type: string; status: string; environment: string }

interface Props {
  event:      MonitoringEvent
  /** Dopo una mutation riuscita (refetch di lista/statistiche). */
  onChanged?: () => void
  /** `xs` nelle righe della tabella, `sm` nel dettaglio. */
  size?:      'xs' | 'sm'
}

export function EventActions({ event, onChanged, size = 'xs' }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [dialog, setDialog] = useState<'resolve' | 'link' | null>(null)

  const [acknowledge, { loading: acking }]     = useMutation(ACKNOWLEDGE_EVENT)
  const [createIncident, { loading: opening }] = useMutation<{ createIncidentFromEvent: { id: string; number: string } }>(CREATE_INCIDENT_FROM_EVENT)

  const active = isActiveEvent(event)
  const canAck     = active && !event.acknowledgedAt
  const canResolve = active
  const canOpen    = !event.incident
  const canLink    = !event.ci

  // I bottoni vivono dentro una riga cliccabile: il click non deve navigare.
  const stop = (e: MouseEvent<HTMLButtonElement>) => e.stopPropagation()

  async function handleAck(e: MouseEvent<HTMLButtonElement>) {
    stop(e)
    try {
      await acknowledge({ variables: { id: event.id } })
      toast.success(t('toast.events.acknowledged'))
      onChanged?.()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  async function handleOpenIncident(e: MouseEvent<HTMLButtonElement>) {
    stop(e)
    const ok = await confirm({ title: t('events.actions.openIncidentTitle'), body: event.title })
    if (!ok) return
    try {
      const res = await createIncident({ variables: { eventId: event.id } })
      const inc = res.data?.createIncidentFromEvent
      if (!inc) throw new Error(t('events.actions.emptyResponse'))
      toast.success(t('toast.events.incidentCreated', { number: inc.number }))
      onChanged?.()
      navigate(`/incidents/${inc.id}`)
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  if (!canAck && !canResolve && !canOpen && !canLink) return null

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {canAck && (
        <Button variant="secondary" size={size} disabled={acking} icon={acking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Hand size={13} aria-hidden="true" />} onClick={(e) => void handleAck(e)}>
          {t('events.actions.acknowledge')}
        </Button>
      )}
      {canResolve && (
        <Button variant="secondary" size={size} icon={<CheckCircle2 size={13} aria-hidden="true" />} onClick={(e) => { stop(e); setDialog('resolve') }}>
          {t('events.actions.resolve')}
        </Button>
      )}
      {canOpen && (
        <Button variant="secondary" size={size} disabled={opening} icon={<AlertCircle size={13} aria-hidden="true" />} onClick={(e) => void handleOpenIncident(e)}>
          {t('events.actions.openIncident')}
        </Button>
      )}
      {canLink && (
        <Button variant="secondary" size={size} icon={<Link2 size={13} aria-hidden="true" />} onClick={(e) => { stop(e); setDialog('link') }}>
          {t('events.actions.linkCI')}
        </Button>
      )}

      {dialog === 'resolve' && (
        <ResolveDialog event={event} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged?.() }} />
      )}
      {dialog === 'link' && (
        <LinkCIDialog event={event} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged?.() }} />
      )}
    </div>
  )
}

// ── Risoluzione manuale (nota facoltativa) ──────────────────────────────────

function ResolveDialog({ event, onClose, onDone }: { event: MonitoringEvent; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const noteId = useId()
  const [note, setNote] = useState('')
  const [resolve, { loading }] = useMutation(RESOLVE_EVENT)

  async function submit() {
    try {
      await resolve({ variables: { id: event.id, note: note.trim() || null } })
      toast.success(t('toast.events.resolved'))
      onDone()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  return (
    <Modal
      open
      onClose={() => { if (!loading) onClose() }}
      title={t('events.actions.resolveTitle')}
      footer={
        <>
          <Button variant="secondary" size="xs" disabled={loading} onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="xs" disabled={loading} icon={loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void submit()}>
            {t('events.actions.resolve')}
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: 500 }}>{event.title}</p>
      <FieldLabel htmlFor={noteId}>{t('events.actions.resolveNote')}</FieldLabel>
      <Textarea id={noteId} rows={3} value={note} onChange={(e) => setNote(e.target.value)} disabled={loading} placeholder={t('common.writeHere')} />
    </Modal>
  )
}

// ── Collegamento a un CI (ricerca + alias) ──────────────────────────────────

function LinkCIDialog({ event, onClose, onDone }: { event: MonitoringEvent; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const searchId = useId()
  const aliasId  = useId()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<CISearchRow | null>(null)
  const [createAlias, setCreateAlias] = useState(true)
  const [link, { loading }] = useMutation(LINK_EVENT_TO_CI)

  const { data, loading: searching, error } = useQuery<{ allCIs: { items: CISearchRow[] } }>(GET_ALL_CIS, {
    variables: { search, limit: 20 },
    skip: search.trim().length < 2,
    fetchPolicy: 'cache-and-network',
  })
  const results = data?.allCIs.items ?? []

  async function submit() {
    if (!selected) return
    try {
      await link({ variables: { eventId: event.id, ciId: selected.id, createAlias } })
      toast.success(t('toast.events.linked', { ci: selected.name }))
      onDone()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  return (
    <Modal
      open
      onClose={() => { if (!loading) onClose() }}
      title={t('events.actions.linkCITitle')}
      width={560}
      footer={
        <>
          <Button variant="secondary" size="xs" disabled={loading} onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="xs" disabled={loading || !selected} icon={loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void submit()}>
            {t('events.actions.linkCI')}
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('events.actions.linkCIHint', { resource: event.resource, kind: event.resourceKind })}
      </p>
      <FieldLabel htmlFor={searchId}>{t('events.actions.searchCI')}</FieldLabel>
      <Input
        id={searchId}
        value={search}
        onChange={(e) => { setSearch(e.target.value); setSelected(null) }}
        placeholder={t('events.actions.searchCIPlaceholder')}
        disabled={loading}
      />
      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', margin: '8px 0 0' }}>{error.message}</p>}
      {search.trim().length >= 2 && (
        <ul aria-label={t('events.actions.searchResults')} style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, border: '1px solid var(--border)', borderRadius: 8, maxHeight: 240, overflowY: 'auto' }}>
          {searching && results.length === 0 && (
            <li style={{ padding: '8px 12px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</li>
          )}
          {!searching && results.length === 0 && (
            <li style={{ padding: '8px 12px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.noResults')}</li>
          )}
          {results.map((ci) => {
            const isSel = selected?.id === ci.id
            return (
              <li key={ci.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <button
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => setSelected(ci)}
                  style={{
                    width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 8,
                    padding: '8px 12px', border: 'none', cursor: 'pointer',
                    background: isSel ? 'var(--color-brand-light)' : 'transparent',
                    fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{ci.name}</span>
                  <span style={{ color: 'var(--color-slate-light)' }}>{ci.type} · {ci.environment}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <label htmlFor={aliasId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', cursor: 'pointer' }}>
        <input id={aliasId} type="checkbox" checked={createAlias} onChange={(e) => setCreateAlias(e.target.checked)} disabled={loading} />
        {t('events.actions.rememberAlias')}
      </label>
    </Modal>
  )
}
