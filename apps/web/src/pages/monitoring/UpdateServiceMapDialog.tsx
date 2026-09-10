/**
 * «Aggiorna mappa» (ondata 2, solo admin): il diff fra la mappa attuale e
 * quella che si costruirebbe adesso dal grafo (`serviceMapProposal`, nessuna
 * scrittura) in tre elenchi — nuovi, spariti, spostati — con una spunta per
 * componente. Niente entra o esce senza un clic: le spunte partono vuote.
 *
 *   nuovi   → «Includi» (entra con le impostazioni proposte) oppure
 *             «Escludi» (non verrà più riproposto): le due si escludono;
 *   spariti → «Togli» (il CI non è più raggiungibile nel grafo);
 *   spostati → informativi: livello e «via» si ricalcolano da soli.
 *
 * In fondo le esclusioni attive con «Riammetti»: il CI torna nella prossima
 * proposta. Ogni scrittura porta `expectedVersion` = la versione letta; il
 * rifiuto dell'API è una riga `role="alert"`, mai un silenzio.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_SERVICE_MAP_PROPOSAL } from '@/graphql/queries'
import { APPLY_SERVICE_MAP_PROPOSAL, REMOVE_SERVICE_MAP_EXCLUSION } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
import { propagationLabel, roleLabel } from './servicesShared'
import type { ServiceMapDetail, ServiceMapProposal } from '@/types/services'

interface Props {
  map:     ServiceMapDetail
  open:    boolean
  onClose: () => void
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }
const sectionTitle: React.CSSProperties = { margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '6px 8px', borderBottom: '1px solid var(--color-border-light)', fontSize: 'var(--font-size-body)', color: colors.slateDark }
const checkLabel: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-table)', color: colors.slate, cursor: 'pointer' }

/** Insieme con un elemento acceso/spento (le spunte del diff). */
function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}

export function UpdateServiceMapDialog({ map, open, onClose }: Props) {
  const { t } = useTranslation()
  const [add, setAdd] = useState<ReadonlySet<string>>(new Set())
  const [exclude, setExclude] = useState<ReadonlySet<string>>(new Set())
  const [remove, setRemove] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, loading, error, refetch } = useQuery<{ serviceMapProposal: ServiceMapProposal }>(GET_SERVICE_MAP_PROPOSAL, {
    variables: { id: map.id }, skip: !open, fetchPolicy: 'network-only',
  })
  const [apply, { loading: applying }] = useMutation<{ applyServiceMapProposal: ServiceMapDetail }>(APPLY_SERVICE_MAP_PROPOSAL)
  const [readmit, { loading: readmitting }] = useMutation<{ removeServiceMapExclusion: ServiceMapDetail }>(REMOVE_SERVICE_MAP_EXCLUSION)

  // Ogni apertura riparte da zero: nessuna spunta ereditata dalla volta prima.
  useEffect(() => {
    if (!open) return
    setAdd(new Set()); setExclude(new Set()); setRemove(new Set()); setActionError(null)
  }, [open])

  const proposal = data?.serviceMapProposal ?? null
  const busy = applying || readmitting
  const nothingChosen = add.size === 0 && exclude.size === 0 && remove.size === 0
  const aligned = proposal !== null && proposal.added.length === 0 && proposal.removed.length === 0 && proposal.moved.length === 0

  // «Includi» ed «escludi» si escludono a vicenda sullo stesso componente.
  const chooseAdd = (id: string) => { setAdd((s) => toggle(s, id)); setExclude((s) => { const n = new Set(s); n.delete(id); return n }) }
  const chooseExclude = (id: string) => { setExclude((s) => toggle(s, id)); setAdd((s) => { const n = new Set(s); n.delete(id); return n }) }

  async function onApply() {
    if (nothingChosen) return
    setActionError(null)
    try {
      const res = await apply({ variables: { id: map.id, expectedVersion: map.version, add: [...add], exclude: [...exclude], remove: [...remove] } })
      if (!res.data?.applyServiceMapProposal) throw new Error(t('monitoring.services.detail.noResult', { operation: 'applyServiceMapProposal' }))
      toast.success(t('toast.services.mapUpdated', { added: add.size, removed: remove.size, excluded: exclude.size }))
      onClose()
    } catch (e) { setActionError(errorMessage(e)) }
  }

  async function onReadmit(ciId: string, name: string) {
    setActionError(null)
    try {
      const res = await readmit({ variables: { id: map.id, expectedVersion: map.version, ciId } })
      if (!res.data?.removeServiceMapExclusion) throw new Error(t('monitoring.services.detail.noResult', { operation: 'removeServiceMapExclusion' }))
      toast.success(t('toast.services.exclusionRemoved', { name }))
      // Il CI torna proponibile: la proposta va riletta.
      await refetch()
    } catch (e) { setActionError(errorMessage(e)) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('monitoring.services.update.title', { name: map.name })}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button disabled={busy || nothingChosen} icon={applying ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void onApply()}>
            {t('monitoring.services.update.apply')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Mappa viva: qui si viene a rivedere ed escludere, l'aggiunta e la rimozione le fa già la sincronizzazione (ondata 5). */}
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.6 }}>
          {map.autoSync ? t('monitoring.services.update.introLive') : t('monitoring.services.update.intro')}
        </p>

        {loading && !data && <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('common.loading')}</p>}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.danger, fontWeight: 500 }}>
            {t('monitoring.services.update.loadFailed', { error: error.message })}
          </p>
        )}
        {actionError && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
            {t('monitoring.services.update.actionFailed', { error: actionError })}
          </div>
        )}

        {proposal && aligned && (
          <p role="status" style={{ margin: 0, padding: '10px 14px', borderRadius: 8, background: palette.success.bg, color: palette.success.text, fontSize: 'var(--font-size-body)' }}>
            {t('monitoring.services.update.aligned')}
          </p>
        )}

        {proposal && proposal.added.length > 0 && (
          <section aria-label={t('monitoring.services.update.addedTitle', { count: proposal.added.length })}>
            <h3 style={sectionTitle}>{t('monitoring.services.update.addedTitle', { count: proposal.added.length })}</h3>
            <p style={hint}>{t('monitoring.services.update.addedHint')}</p>
            <div style={{ marginTop: 8 }}>
              {proposal.added.map((n) => (
                <div key={n.ci.id} style={row} data-testid="proposal-added" data-ci-id={n.ci.id}>
                  <span style={{ fontWeight: 600, marginRight: 'auto' }}>{n.ci.name}</span>
                  <span style={{ color: colors.slateLight, fontSize: 'var(--font-size-table)' }}>
                    {t('monitoring.services.update.nodeMeta', { level: n.level, role: roleLabel(t, n.role), propagate: propagationLabel(t, n.propagate), weight: n.weight })}
                  </span>
                  <label style={checkLabel}>
                    <input type="checkbox" checked={add.has(n.ci.id)} disabled={busy} aria-label={t('monitoring.services.update.includeLabel', { name: n.ci.name })} onChange={() => chooseAdd(n.ci.id)} />
                    {t('monitoring.services.update.include')}
                  </label>
                  <label style={checkLabel}>
                    <input type="checkbox" checked={exclude.has(n.ci.id)} disabled={busy} aria-label={t('monitoring.services.update.excludeLabel', { name: n.ci.name })} onChange={() => chooseExclude(n.ci.id)} />
                    {t('monitoring.services.update.exclude')}
                  </label>
                </div>
              ))}
            </div>
          </section>
        )}

        {proposal && proposal.removed.length > 0 && (
          <section aria-label={t('monitoring.services.update.removedTitle', { count: proposal.removed.length })}>
            <h3 style={sectionTitle}>{t('monitoring.services.update.removedTitle', { count: proposal.removed.length })}</h3>
            <p style={hint}>{t('monitoring.services.update.removedHint')}</p>
            <div style={{ marginTop: 8 }}>
              {proposal.removed.map((n) => (
                <div key={n.ci.id} style={row} data-testid="proposal-removed" data-ci-id={n.ci.id}>
                  <span style={{ fontWeight: 600, marginRight: 'auto' }}>{n.ci.name}</span>
                  <span style={{ color: colors.slateLight, fontSize: 'var(--font-size-table)' }}>
                    {t('monitoring.services.map.level', { level: n.level })} · {roleLabel(t, n.role)}
                  </span>
                  <label style={checkLabel}>
                    <input type="checkbox" checked={remove.has(n.ci.id)} disabled={busy} aria-label={t('monitoring.services.update.removeLabel', { name: n.ci.name })} onChange={() => setRemove((s) => toggle(s, n.ci.id))} />
                    {t('monitoring.services.update.remove')}
                  </label>
                </div>
              ))}
            </div>
          </section>
        )}

        {proposal && proposal.moved.length > 0 && (
          <section aria-label={t('monitoring.services.update.movedTitle', { count: proposal.moved.length })}>
            <h3 style={sectionTitle}>{t('monitoring.services.update.movedTitle', { count: proposal.moved.length })}</h3>
            <p style={hint}>{t('monitoring.services.update.movedHint')}</p>
            <div style={{ marginTop: 8 }}>
              {proposal.moved.map((n) => (
                <div key={n.ci.id} style={row} data-testid="proposal-moved" data-ci-id={n.ci.id}>
                  <span style={{ fontWeight: 600, marginRight: 'auto' }}>{n.ci.name}</span>
                  <span style={{ color: colors.slate, fontSize: 'var(--font-size-table)' }}>
                    {t('monitoring.services.update.movedRow', { from: n.level, to: n.proposedLevel })}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {proposal && (
          <p role="status" data-testid="proposal-summary" style={{ margin: 0, fontSize: 'var(--font-size-body)', fontWeight: 600, color: nothingChosen ? colors.slateLight : palette.warning.text }}>
            {t('monitoring.services.update.summary', { add: add.size, remove: remove.size, exclude: exclude.size })}
          </p>
        )}

        {proposal && (
          <section aria-label={t('monitoring.services.update.exclusionsTitle', { count: proposal.excluded.length })}>
            <h3 style={sectionTitle}>{t('monitoring.services.update.exclusionsTitle', { count: proposal.excluded.length })}</h3>
            <p style={hint}>{t('monitoring.services.update.exclusionsHint')}</p>
            {proposal.excluded.length === 0
              ? <p style={{ ...hint, marginTop: 8 }}>{t('monitoring.services.update.exclusionsEmpty')}</p>
              : (
                <div style={{ marginTop: 8 }}>
                  {proposal.excluded.map((ci) => (
                    <div key={ci.id} style={row} data-testid="proposal-excluded" data-ci-id={ci.id}>
                      <span style={{ fontWeight: 600, marginRight: 'auto' }}>{ci.name}</span>
                      <Button variant="secondary" size="xs" disabled={busy} aria-label={t('monitoring.services.update.readmitLabel', { name: ci.name })} onClick={() => void onReadmit(ci.id, ci.name)}>
                        {t('monitoring.services.update.readmit')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
          </section>
        )}
      </div>
    </Modal>
  )
}
