/**
 * «Modifica ambito» (solo admin) — revisione del 15 set 2026 · SV-6.
 *
 * Tipi di relazione e profondità di una mappa si fissavano alla creazione e
 * nessuna schermata li cambiava: una relazione aggiunta dal cliente dopo non
 * veniva mai seguita, e una tolta bloccava la sincronizzazione. Qui si
 * cambiano con `updateServiceMapScope`, con la versione letta come per ogni
 * scrittura della mappa.
 *
 * Un tipo che la mappa segue ma che il metamodello non dichiara più compare
 * lo stesso, NON spuntato e con la frase che lo dice: salvando si toglie. Mai
 * sparito in silenzio dalla lista, mai rimandato all'API che lo rifiuterebbe.
 * Il rifiuto dell'API (versione cambiata, validazione) è una riga
 * `role="alert"` con «Ricarica».
 */
import { useId, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { colors, palette } from '@/lib/tokens'
import { GET_SERVICE_RELATIONSHIP_TYPES } from '@/graphql/queries'
import { UPDATE_SERVICE_MAP_SCOPE } from '@/graphql/mutations'
import { SERVICE_MAP_MAX_DEPTH, type ServiceMapDetail } from '@/types/services'

interface Props {
  map:      ServiceMapDetail
  onClose:  () => void
  /** Rilegge la mappa dopo un conflitto di versione. */
  onReload: () => void
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }

export function ServiceMapScopeDialog({ map, onClose, onReload }: Props) {
  const { t } = useTranslation()
  const depthId = useId()
  const [depth, setDepth] = useState(map.maxDepth)
  const { data: relData, error: relError, loading: relLoading } = useQuery<{ serviceRelationshipTypes: string[] }>(GET_SERVICE_RELATIONSHIP_TYPES)
  const declared = relData?.serviceRelationshipTypes ?? null
  const [rels, setRels] = useState<Set<string>>(() => new Set(map.relationshipTypes))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [update, { loading: saving }] = useMutation<{ updateServiceMapScope: ServiceMapDetail }>(UPDATE_SERVICE_MAP_SCOPE)

  // I tipi seguiti che il cliente non dichiara più: si mostrano, non spuntati.
  const stale = declared ? map.relationshipTypes.filter((r) => !declared.includes(r)) : []
  const chosen = declared ? [...rels].filter((r) => declared.includes(r)) : []

  const toggle = (r: string) => setRels((prev) => {
    const next = new Set(prev)
    if (next.has(r)) next.delete(r); else next.add(r)
    return next
  })

  const unchanged = depth === map.maxDepth && stale.length === 0
    && chosen.length === map.relationshipTypes.length && chosen.every((r) => map.relationshipTypes.includes(r))
  const depthValid = Number.isInteger(depth) && depth >= 1 && depth <= SERVICE_MAP_MAX_DEPTH
  const canSubmit = declared !== null && chosen.length > 0 && depthValid && !unchanged && !saving

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return
    setSaveError(null)
    try {
      const res = await update({ variables: { id: map.id, expectedVersion: map.version, relationshipTypes: chosen, maxDepth: depth } })
      const next = res.data?.updateServiceMapScope
      if (!next) throw new Error(t('monitoring.services.scope.noResult'))
      toast.success(t('toast.services.scopeChanged', { version: next.version }))
      onClose()
    } catch (err) {
      setSaveError(errorMessage(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('monitoring.services.scope.title')}
      as="form"
      onSubmit={(e) => void submit(e)}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!canSubmit} icon={saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined}>
            {t('monitoring.services.scope.submit')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <FieldLabel htmlFor={depthId}>{t('monitoring.services.scope.depth')}</FieldLabel>
          <Input id={depthId} type="number" min={1} max={SERVICE_MAP_MAX_DEPTH} value={depth} onChange={(e) => setDepth(Number.parseInt(e.target.value, 10) || 0)} style={{ width: 120 }} />
          <p style={hint}>{t('monitoring.services.scope.depthHint', { max: SERVICE_MAP_MAX_DEPTH })}</p>
        </div>
        <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend style={{ display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, padding: 0 }}>
            {t('monitoring.services.scope.relationships')}
          </legend>
          {relLoading && !relData && <p role="status" style={hint}>{t('common.loading')}</p>}
          {relError && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.scope.relationshipsError', { error: relError.message })}</p>}
          {declared && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
              {declared.map((r) => (
                <label key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
                  <input type="checkbox" checked={rels.has(r)} onChange={() => toggle(r)} />
                  {r}
                </label>
              ))}
            </div>
          )}
          {stale.map((r) => (
            <p key={r} data-testid="scope-not-declared" style={{ ...hint, color: palette.warning.text }}>{t('monitoring.services.scope.notDeclared', { type: r })}</p>
          ))}
          <p style={hint}>{t('monitoring.services.scope.relationshipsHint')}</p>
          {declared && chosen.length === 0 && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.scope.relationshipsRequired')}</p>}
        </fieldset>
        {unchanged && declared && <p role="status" style={hint}>{t('monitoring.services.scope.unchanged')}</p>}
        {saveError && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
            <span>{saveError}</span>
            <Button variant="secondary" size="xs" onClick={() => { onReload(); onClose() }}>{t('monitoring.services.rulesEdit.reload')}</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
