/**
 * Dialogo minimale «Crea una mappa» (ondata 1, solo admin): scelta della
 * BusinessApplication fra quelle senza mappa (`serviceMapCandidates`, con
 * ricerca), profondità massima (1–8) e relazioni da seguire → `createServiceMap`
 * (costruzione automatica dal grafo, valutazione immediata) e apertura del
 * dettaglio. La procedura guidata in tre passi con l'anteprima arriva in
 * ondata 2.
 *
 * Errori visibili: la lista dei candidati che fallisce è un testo in chiaro
 * (non un select vuoto), il fallimento della mutation è un toast con il
 * messaggio del server.
 */
import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { enumLabel } from '@/lib/ciEnums'
import { colors } from '@/lib/tokens'
import { GET_SERVICE_MAP_CANDIDATES } from '@/graphql/queries'
import { CREATE_SERVICE_MAP } from '@/graphql/mutations'
import {
  SERVICE_MAP_DEFAULT_DEPTH, SERVICE_MAP_MAX_DEPTH, SERVICE_RELATIONSHIP_TYPES,
  type ServiceMapDetail, type ServiceRef, type ServiceRelationshipType,
} from '@/types/services'

const SEARCH_DEBOUNCE = 300
const CANDIDATES_LIMIT = 50

interface Props {
  open:       boolean
  onClose:    () => void
  /** Dopo la creazione (prima della navigazione al dettaglio): la lista rilegge. */
  onCreated?: (map: ServiceMapDetail) => void
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }

export function CreateServiceMapDialog({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ids = { service: useId(), search: useId(), depth: useId() }

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [depth, setDepth] = useState(SERVICE_MAP_DEFAULT_DEPTH)
  const [rels, setRels] = useState<Set<ServiceRelationshipType>>(() => new Set(SERVICE_RELATIONSHIP_TYPES))

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
  const [create, { loading: creating }] = useMutation<{ createServiceMap: ServiceMapDetail }>(CREATE_SERVICE_MAP)

  const toggleRel = (r: ServiceRelationshipType) => setRels((prev) => {
    const next = new Set(prev)
    if (next.has(r)) next.delete(r); else next.add(r)
    return next
  })

  const canSubmit = serviceId !== '' && rels.size > 0 && depth >= 1 && depth <= SERVICE_MAP_MAX_DEPTH && !creating

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return
    try {
      const res = await create({ variables: { serviceId, maxDepth: depth, relationshipTypes: [...rels] } })
      const map = res.data?.createServiceMap
      if (!map) throw new Error(t('monitoring.services.create.noResult'))
      toast.success(t('toast.services.created', { name: map.name }))
      onCreated?.(map)
      onClose()
      navigate(`/monitoring/services/${map.id}`)
    } catch (err) {
      toast.error(t('toast.services.actionFailed', { error: errorMessage(err) }))
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
              <option key={c.id} value={c.id}>{c.name}{c.criticality ? ` · ${enumLabel(c.criticality)}` : ''}{c.ownerGroup ? ` · ${c.ownerGroup.name}` : ''}</option>
            ))}
          </Select>
          {error && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.create.candidatesError', { error: error.message })}</p>}
          {!error && data && candidates.length === 0 && <p role="status" style={hint}>{t('monitoring.services.create.candidatesEmpty')}</p>}
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
            {SERVICE_RELATIONSHIP_TYPES.map((r) => (
              <label key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
                <input type="checkbox" checked={rels.has(r)} onChange={() => toggleRel(r)} />
                {r}
              </label>
            ))}
          </div>
          <p style={hint}>{t('monitoring.services.create.relationshipsHint')}</p>
          {rels.size === 0 && <p role="alert" style={{ ...hint, color: colors.danger }}>{t('monitoring.services.create.relationshipsRequired')}</p>}
        </fieldset>
      </div>
    </Modal>
  )
}
