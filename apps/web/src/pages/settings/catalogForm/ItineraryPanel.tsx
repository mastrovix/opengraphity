/**
 * L'ITER DI UNA VOCE DI CATALOGO (moduli del catalogo, ondata 3).
 *
 * Un modulo ricco senza un iter proprio è mezzo lavoro: «nuovo accesso» e
 * «nuovo portatile» non hanno gli stessi passi né gli stessi approvatori. Il
 * motore sapeva già scegliere il workflow per categoria o per identificativo;
 * mancavano due cose, e sono qui:
 *
 *  - dire a una VOCE quale workflow usare (prima si poteva solo per categoria,
 *    quindi due voci della stessa categoria erano costrette allo stesso iter);
 *  - DUPLICARE una definizione, perché prima si potevano solo modificare
 *    quelle seminate — «un iter per ogni voce» era una promessa senza il modo
 *    di crearne uno.
 *
 * Gli APPROVATORI non si configurano qui ma nel disegnatore del workflow, sul
 * passo di approvazione: sono una proprietà dell'iter, non della voce, e
 * metterli in due posti vorrebbe dire due verità. Il pannello lo dice e porta
 * il collegamento.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { Link } from 'react-router-dom'
import { Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { GET_CATALOG_ITEMS_WITH_WORKFLOW, GET_WORKFLOW_LIST } from '@/graphql/queries'
import { DUPLICATE_WORKFLOW_DEFINITION, SET_WORKFLOW_DEFINITION_ACTIVE, UPDATE_SERVICE_CATALOG_ITEM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select } from '@/components/ui/FormControls'

interface Voce {
  id: string
  name: string
  category: string | null
  active: boolean
  workflowDefinitionId: string | null
  workflowDefinitionName: string | null
}

interface Definizione {
  id: string
  name: string
  entityType: string
  category: string | null
  active: boolean
  version: number
}

/**
 * QUALE ITER USA DAVVERO «per categoria» (18 set 2026).
 *
 * La tendina offriva «Per categoria (come prima)» e i workflow, ma non diceva
 * a COSA corrisponde il default — e il proprietario, guardando cinque righe
 * tutte uguali, ha chiesto «non posso scegliere un workflow?». Le scelte
 * c'erano; era il default a non dire niente.
 *
 * La regola è quella del motore (`initialStepSelection`), e va tenuta uguale:
 * prima l'iter con la STESSA categoria della voce, se no quello SENZA
 * categoria; a parità, la versione più alta. Uno spento non entra: una
 * richiesta nuova non lo userebbe.
 *
 * Quando non ne applica nessuno non si tace: quella voce, oggi, non riesce a
 * creare una richiesta — e si scoprirebbe solo aprendone una.
 */
export function iterPerCategoria(definizioni: readonly Definizione[], categoria: string | null): Definizione | null {
  const candidati = definizioni
    .filter((d) => d.active)
    .filter((d) => (d.category != null && d.category === categoria) || d.category == null)
    .sort((a, b) => {
      const pa = a.category != null ? 0 : 1
      const pb = b.category != null ? 0 : 1
      return pa !== pb ? pa - pb : b.version - a.version
    })
  return candidati[0] ?? null
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${colors.border}` }
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', borderBottom: `1px solid ${colors.slateBg}`, verticalAlign: 'middle' }

export function ItineraryPanel() {
  const { t } = useTranslation()
  const { data: vociData, refetch: rileggiVoci } = useQuery<{ serviceCatalogItems: Voce[] }>(
    GET_CATALOG_ITEMS_WITH_WORKFLOW, { fetchPolicy: 'cache-and-network' },
  )
  const { data: defData, refetch: rileggiDefinizioni } = useQuery<{ workflowDefinitions: Definizione[] }>(
    // `includeInactive`: una copia appena duplicata nasce spenta, e senza
    // questo non comparirebbe — quindi non si potrebbe finire né accendere.
    GET_WORKFLOW_LIST, { variables: { includeInactive: true }, fetchPolicy: 'cache-and-network' },
  )
  const voci = (vociData?.serviceCatalogItems ?? []).filter((v) => v.active)
  /** Solo gli iter delle richieste: un workflow di change non c'entra con una voce di catalogo. */
  const definizioni = (defData?.workflowDefinitions ?? []).filter((d) => d.entityType === 'service_request')

  const [aggiornaVoce] = useMutation(UPDATE_SERVICE_CATALOG_ITEM, { onError: (e) => showError(e) })
  const [duplica, { loading: duplicando }] = useMutation(DUPLICATE_WORKFLOW_DEFINITION, { onError: (e) => showError(e) })
  const [accendi] = useMutation(SET_WORKFLOW_DEFINITION_ACTIVE, { onError: (e) => showError(e) })

  const cambiaStato = async (d: Definizione, attivo: boolean) => {
    const r = await accendi({ variables: { definitionId: d.id, active: attivo } })
    if (!r.data) return
    toast.success(attivo ? t('pages.catalogForms.itinerary.activated') : t('pages.catalogForms.itinerary.deactivated'))
    void rileggiDefinizioni()
  }

  const [daDuplicare, setDaDuplicare] = useState('')
  const [nomeCopia, setNomeCopia] = useState('')

  /**
   * SCEGLIERE UN ITER SPENTO LO ACCENDE, e lo dice.
   *
   * La tendina offre anche le definizioni spente — deve, perché un iter
   * duplicato nasce spento ed è la strada normale per farsene uno — ma l'API
   * rifiuta di assegnarne uno non attivo, giustamente: con un iter spento
   * nessuno potrebbe più aprire quella richiesta. Il risultato era un menu che
   * offre quello che il server rifiuta, con un messaggio che manda a cercare
   * la cosa sbagliata (revisione del 17 set 2026).
   *
   * Assegnare un iter È la decisione di usarlo: lo si accende qui, e il toast
   * dice che è successo — invece di far tornare l'amministratore su un altro
   * interruttore per capire perché il salvataggio non passava.
   */
  const scegliIter = async (voce: Voce, definitionId: string) => {
    const scelto = definizioni.find((d) => d.id === definitionId)
    if (scelto && !scelto.active) {
      const acceso = await accendi({ variables: { definitionId, active: true } })
      if (!acceso.data) return
      void rileggiDefinizioni()
    }
    const r = await aggiornaVoce({ variables: { id: voce.id, input: { workflowDefinitionId: definitionId || null } } })
    if (!r.data) return
    toast.success(scelto && !scelto.active
      ? t('pages.catalogForms.itinerary.savedAndActivated', { name: scelto.name })
      : t('pages.catalogForms.itinerary.saved'))
    void rileggiVoci()
  }

  const duplicaIter = async () => {
    if (!daDuplicare || nomeCopia.trim() === '') return
    const r = await duplica({ variables: { definitionId: daDuplicare, name: nomeCopia.trim(), category: null } })
    if (!r.data) return
    toast.success(t('pages.catalogForms.itinerary.duplicated'))
    setNomeCopia('')
    void rileggiDefinizioni()
  }

  return (
    <div>
      <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', maxWidth: '70ch' }}>
        {t('pages.catalogForms.itinerary.intro')}
      </p>

      {/* ── Duplicare un iter ─────────────────────────────────────────────── */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, marginBottom: 20, background: colors.white }}>
        <strong style={{ display: 'block', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)', marginBottom: 4 }}>
          {t('pages.catalogForms.itinerary.duplicateTitle')}
        </strong>
        <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
          {t('pages.catalogForms.itinerary.duplicateHelp')}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 220px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
              {t('pages.catalogForms.itinerary.duplicateFrom')}
            </span>
            <Select value={daDuplicare} onChange={(e) => setDaDuplicare(e.target.value)}>
              <option value="">{t('common.select')}</option>
              {definizioni.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.category ? ` · ${d.category}` : ''}{d.active ? '' : ` · ${t('pages.catalogForms.itinerary.inactive')}`}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ flex: '1 1 220px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
              {t('pages.catalogForms.itinerary.copyName')}
            </span>
            <Input value={nomeCopia} onChange={(e) => setNomeCopia(e.target.value)} placeholder={t('pages.catalogForms.itinerary.copyNamePlaceholder')} />
          </label>
          <button type="button" onClick={() => void duplicaIter()} disabled={duplicando || !daDuplicare || nomeCopia.trim() === ''}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none',
              background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium,
              cursor: duplicando || !daDuplicare || nomeCopia.trim() === '' ? 'not-allowed' : 'pointer',
              opacity: duplicando || !daDuplicare || nomeCopia.trim() === '' ? 0.55 : 1,
            }}>
            <Copy size={14} /> {t('pages.catalogForms.itinerary.duplicate')}
          </button>
        </div>
      </div>

      {/* ── Gli iter delle richieste, con il loro stato ───────────────────── */}
      {definizioni.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <strong style={{ display: 'block', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)', marginBottom: 6 }}>
            {t('pages.catalogForms.itinerary.definitionsTitle')}
          </strong>
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
            {t('pages.catalogForms.itinerary.definitionsHelp')}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {definizioni.map((d) => (
              <li key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 6, background: colors.white, border: `1px solid ${colors.border}` }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                  {d.name}
                  {d.category && <span style={{ color: 'var(--color-slate-light)' }}> · {d.category}</span>}
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-body)', color: d.active ? 'var(--color-slate-dark)' : 'var(--color-slate-light)' }}>
                  <input type="checkbox" checked={d.active} onChange={(e) => void cambiaStato(d, e.target.checked)} />
                  {d.active ? t('pages.catalogForms.itinerary.active') : t('pages.catalogForms.itinerary.inactive')}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── L'iter di ogni voce ───────────────────────────────────────────── */}
      <div className="og-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{t('pages.catalogForms.itinerary.item')}</th>
              <th style={th}>{t('pages.catalogForms.itinerary.category')}</th>
              <th style={th}>{t('pages.catalogForms.itinerary.workflow')}</th>
            </tr>
          </thead>
          <tbody>
            {voci.map((v) => (
              <tr key={v.id}>
                <td style={td}>{v.name}</td>
                <td style={{ ...td, color: 'var(--color-slate-light)' }}>{v.category ?? '—'}</td>
                <td style={td}>
                  <Select value={v.workflowDefinitionId ?? ''} onChange={(e) => void scegliIter(v, e.target.value)}>
                    {/* Il vuoto NON è «nessun iter»: è «scegli per categoria», che è il comportamento di sempre. */}
                    <option value="">{t('pages.catalogForms.itinerary.byCategory')}</option>
                    {definizioni.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}{d.active ? '' : ` · ${t('pages.catalogForms.itinerary.inactive')}`}
                      </option>
                    ))}
                  </Select>
                  {/* Col default, QUALE iter viene usato: senza, «per
                      categoria» è una promessa che non si può verificare. */}
                  {v.workflowDefinitionId == null && (() => {
                    const scelto = iterPerCategoria(definizioni, v.category)
                    return scelto ? (
                      <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                        {t('pages.catalogForms.itinerary.resolvesTo', { workflow: scelto.name })}
                      </p>
                    ) : (
                      <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-danger)' }}>
                        {t('pages.catalogForms.itinerary.resolvesToNothing')}
                      </p>
                    )
                  })()}
                </td>
              </tr>
            ))}
            {voci.length === 0 && (
              <tr><td style={{ ...td, color: 'var(--color-slate-light)', textAlign: 'center', padding: 24 }} colSpan={3}>{t('pages.catalogForms.builder.noItems')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 18, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
        {t('pages.catalogForms.itinerary.approversElsewhere')}{' '}
        <Link to="/workflow" style={{ color: 'var(--color-brand)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {t('sidebar.workflowDesigner')} <ExternalLink size={11} />
        </Link>
      </p>
    </div>
  )
}
