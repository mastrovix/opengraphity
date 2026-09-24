/**
 * Dialogo «Crea una mappa» (solo admin): scelta della BusinessApplication
 * fra quelle senza mappa (`serviceMapCandidates`, con ricerca), profondità
 * massima (1–8), relazioni da seguire e la spunta «crea come bozza» (ondata
 * 2: `status: draft` — la mappa non viene valutata finché non si attiva) →
 * `createServiceMap` e apertura del dettaglio.
 *
 * Errori visibili: la lista dei candidati che fallisce è un testo in chiaro
 * (non un select vuoto), il fallimento della mutation è un toast con il
 * messaggio del server.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { useCriticalityLabel } from '@/hooks/useCILabels'
import { colors } from '@/lib/tokens'
import { GET_SERVICE_MAP_CANDIDATES, GET_SERVICE_MAP_CREATION_PREVIEW, GET_SERVICE_RELATIONSHIP_TYPES } from '@/graphql/queries'
import { useCILabels } from '@/hooks/useCILabels'
import { roleLabel } from './servicesShared'
import { CREATE_SERVICE_MAP } from '@/graphql/mutations'
import {
  SERVICE_MAP_DEFAULT_DEPTH, SERVICE_MAP_MAX_DEPTH, SHIPPED_SERVICE_RELATIONSHIP_TYPES,
  type ServiceMapDetail, type ServiceRef,
} from '@/types/services'
import { showError } from '@/lib/showError'

const SEARCH_DEBOUNCE = 300
const CANDIDATES_LIMIT = 50
/** Quanti componenti l'anteprima elenca per nome; gli altri si contano. */
const PREVIEW_LISTED = 12

interface Props {
  open:       boolean
  onClose:    () => void
  /** Dopo la creazione (prima della navigazione al dettaglio): la lista rilegge. */
  onCreated?: (map: ServiceMapDetail) => void
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }

export function CreateServiceMapDialog({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation()
  const criticalityLabel = useCriticalityLabel()
  const navigate = useNavigate()
  const ids = { service: useId(), search: useId(), depth: useId() }

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [depth, setDepth] = useState(SERVICE_MAP_DEFAULT_DEPTH)
  /**
   * Ondata 6 · C-3: i tipi percorribili sono quelli del CLIENTE (spediti +
   * suoi), non quattro caselle scritte qui.
   *
   * Revisione totale · G-MON-5: erano ACCESE solo le quattro spedite, mentre
   * l'API, quando `relationshipTypes` è omesso, percorre TUTTE le relazioni di
   * servizio del cliente. Un cliente con `RUNS_ON` vedeva la casella spenta e,
   * se non la notava, creava una mappa che non la seguiva. Adesso partono
   * accese tutte quelle del cliente, come farebbe l'API: l'effetto di
   * «non scelgo niente» e quello di «apro e salvo» coincidono.
   */
  const [rels, setRels] = useState<Set<string> | null>(null)
  const [asDraft, setAsDraft] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [search])

  const { data, loading, error } = useQuery<{ serviceMapCandidates: ServiceRef[] }>(GET_SERVICE_MAP_CANDIDATES, {
    variables: { search: debounced || null, limit: CANDIDATES_LIMIT },
    skip: !open,
    fetchPolicy: 'network-only',
  })
  const candidates = data?.serviceMapCandidates ?? []
  const { data: relData, error: relError } = useQuery<{ serviceRelationshipTypes: string[] }>(GET_SERVICE_RELATIONSHIP_TYPES, { skip: !open })
  // Nessun ripiego silenzioso su una lista scritta nel web: finché la risposta
  // non c'è si mostrano i quattro spediti (la scelta predefinita dell'API), e
  // un errore si vede.
  const relTypes = relData?.serviceRelationshipTypes ?? SHIPPED_SERVICE_RELATIONSHIP_TYPES
  // G-MON-5: untouched (`rels` null), every type of the tenant is selected, as
  // the list arrives. The effect that fixed `rels` on the first list fixed it
  // on the shipped fallback — the dialog is mounted closed, with the query
  // skipped — and the tenant's own types came unticked (review of 23 Sep 2026).
  // Only the types shown count: a shipped type the tenant does not have is
  // neither previewed nor sent.
  // useMemo: altrimenti l'insieme cambia identità a ogni render e l'effetto
  // dell'anteprima ripartirebbe ogni volta.
  const selectedRels = useMemo(
    () => (rels ? new Set(relTypes.filter((r) => rels.has(r))) : new Set(relTypes)),
    [rels, relTypes],
  )
  const [create, { loading: creating }] = useMutation<{ createServiceMap: ServiceMapDetail }>(CREATE_SERVICE_MAP)

  /*
    L'ANTEPRIMA (secondo giro UI del 15 set 2026): i componenti si vedevano solo
    dopo aver creato la mappa. Scelto il servizio, la stessa costruzione della
    creazione dice quanti e quali, e si rifà quando cambiano profondità e relazioni.
  */
  const ciLabels = useCILabels()
  const [previewVars, setPreviewVars] = useState<{ serviceId: string; maxDepth: number; relationshipTypes: string[] } | null>(null)
  useEffect(() => {
    const ok = serviceId !== '' && selectedRels.size > 0 && depth >= 1 && depth <= SERVICE_MAP_MAX_DEPTH
    const timer = setTimeout(() => setPreviewVars(ok ? { serviceId, maxDepth: depth, relationshipTypes: [...selectedRels].sort() } : null), SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [serviceId, depth, selectedRels])
  const { data: previewData, loading: previewLoading, error: previewError } = useQuery<{ serviceMapCreationPreview: { serviceName: string; nodes: { ci: { id: string; name: string; type: string | null }; level: number; role: string }[] } }>(
    GET_SERVICE_MAP_CREATION_PREVIEW, { variables: previewVars ?? undefined, skip: !open || previewVars === null, fetchPolicy: 'network-only' },
  )
  const previewNodes = previewVars ? (previewData?.serviceMapCreationPreview.nodes ?? null) : null

  const toggleRel = (r: string) => setRels((prev) => {
    // G-MON-5: prima del caricamento «tutte» è lo stato di partenza.
    const next = new Set(prev ?? relTypes)
    if (next.has(r)) next.delete(r); else next.add(r)
    return next
  })

  const canSubmit = serviceId !== '' && selectedRels.size > 0 && depth >= 1 && depth <= SERVICE_MAP_MAX_DEPTH && !creating

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return
    try {
      const res = await create({ variables: { serviceId, maxDepth: depth, relationshipTypes: [...selectedRels], status: asDraft ? 'draft' : 'active' } })
      const map = res.data?.createServiceMap
      if (!map) throw new Error(t('monitoring.services.create.noResult'))
      toast.success(t('toast.services.created', { name: map.name }))
      onCreated?.(map)
      onClose()
      navigate(`/monitoring/services/${map.id}`)
    } catch (err) {
      showError(err, t('toast.services.actionFailed', { error: errorMessage(err) }))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('monitoring.services.create.title')}
      as="form"
      onSubmit={(e) => void submit(e)}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={creating}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!canSubmit} icon={creating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined}>
            {t('monitoring.services.create.submit')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <FieldLabel htmlFor={ids.search}>{t('monitoring.services.create.search')}</FieldLabel>
          <Input id={ids.search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('monitoring.services.filters.searchPlaceholder')} />
        </div>
        <div>
          <FieldLabel htmlFor={ids.service}>{t('monitoring.services.create.service')}</FieldLabel>
          <Select id={ids.service} value={serviceId} onChange={(e) => setServiceId(e.target.value)} required disabled={loading && !data}>
            <option value="">{loading && !data ? t('common.loading') : t('monitoring.services.create.servicePlaceholder')}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.criticality ? ` · ${criticalityLabel(c.criticality)}` : ''}{c.ownerGroup ? ` · ${c.ownerGroup.name}` : ''}</option>
            ))}
          </Select>
          {error && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.create.candidatesError', { error: error.message })}</p>}
          {!error && data && candidates.length === 0 && <p role="status" style={hint}>{t('monitoring.services.create.candidatesEmpty')}</p>}
          {/* La mappa parte dalle applicazioni che il servizio REALIZZA: senza quella relazione nasce vuota, e prima lo si scopriva solo dopo. */}
          <p style={hint}>{t('monitoring.services.create.realizesHint')}</p>
        </div>
        <div>
          <FieldLabel htmlFor={ids.depth}>{t('monitoring.services.create.depth')}</FieldLabel>
          <Input id={ids.depth} type="number" min={1} max={SERVICE_MAP_MAX_DEPTH} value={depth} onChange={(e) => setDepth(Number.parseInt(e.target.value, 10) || 0)} style={{ width: 120 }} />
          <p style={hint}>{t('monitoring.services.create.depthHint', { max: SERVICE_MAP_MAX_DEPTH })}</p>
        </div>
        <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend style={{ display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 500, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, padding: 0 }}>
            {t('monitoring.services.create.relationships')}
          </legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {relTypes.map((r) => (
              <label key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
                <input type="checkbox" checked={selectedRels.has(r)} onChange={() => toggleRel(r)} />
                {r}
              </label>
            ))}
          </div>
          <p style={hint}>{t('monitoring.services.create.relationshipsHint')}</p>
          {relError && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.create.relationshipsError', { error: relError.message })}</p>}
          {selectedRels.size === 0 && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.create.relationshipsRequired')}</p>}
        </fieldset>
        {previewVars && (
          <section aria-labelledby={`${ids.service}-preview`} aria-busy={previewLoading} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 12px' }}>
            <h3 id={`${ids.service}-preview`} style={{ margin: '0 0 6px', fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('monitoring.services.create.preview')}</h3>
            {previewError ? (
              <p role="alert" style={{ ...hint, marginTop: 0, color: colors.danger }}>{t('monitoring.services.create.previewError', { error: previewError.message })}</p>
            ) : previewLoading || previewNodes === null ? (
              <p role="status" style={{ ...hint, marginTop: 0 }}>{t('monitoring.services.create.previewLoading')}</p>
            ) : previewNodes.length === 0 ? (
              <p role="status" style={{ ...hint, marginTop: 0 }}>{t('monitoring.services.create.previewEmpty')}</p>
            ) : (
              <div role="status">
                <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>{t('monitoring.services.create.previewCount', { count: previewNodes.length })}</p>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 'var(--font-size-table)', color: colors.slate, lineHeight: 1.6 }}>
                  {previewNodes.slice(0, PREVIEW_LISTED).map((n) => (
                    <li key={n.ci.id}>{t('monitoring.services.create.previewNode', { name: n.ci.name, type: n.ci.type ? ciLabels.typeLabel(n.ci.type) : '—', level: n.level, role: roleLabel(t, n.role) })}</li>
                  ))}
                </ul>
                {previewNodes.length > PREVIEW_LISTED && <p style={{ ...hint, marginTop: 2 }}>{t('monitoring.services.create.previewMore', { count: previewNodes.length - PREVIEW_LISTED })}</p>}
              </div>
            )}
          </section>
        )}
        <div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: colors.slateDark, cursor: 'pointer' }}>
            <input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />
            {t('monitoring.services.create.draft')}
          </label>
          <p style={hint}>{t('monitoring.services.create.draftHint')}</p>
        </div>
      </div>
    </Modal>
  )
}
