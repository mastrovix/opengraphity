import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GET_SERVICE_CATALOG } from '@/graphql/queries'
import { GET_PORTAL_CATALOG_FORM } from '../graphql/queries'
import {
  CatalogFormRenderer, catalogFormAnswersToSend, catalogFormTableAnswers, visibleCatalogFormItems,
  type CatalogFormFieldView, type CatalogFormFile, type CatalogFormTableRow,
} from '@opengraphity/web-core'
import { isFormAttachmentType } from '@opengraphity/types'
import { uploadFormDraftFile } from '../lib/formDraftUpload'
import type { CatalogFormDefinition, FormAnswerValue, FormAnswers } from '@opengraphity/types'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { notifyError } from '@/lib/notify'
import { errorHasKey } from '@opengraphity/web-core'
import { colors, palette, alpha } from '@/lib/tokens'
import { useTicketCategories } from '@/hooks/useTicketCategories'
import { usePortalCustomFields, portalCustomFieldsInput, portalMissingCustomFields } from '@/hooks/usePortalCustomFields'
import { PortalCustomFields } from '@/components/PortalCustomFields'
import { usePortalAccess } from '@/hooks/usePortalAccess'

interface CatalogItem {
  id: string
  name: string
  description: string | null
  category: string | null
  requiresApproval: boolean
}

export function ServiceCatalogPage() {
  const { t, i18n } = useTranslation()
  // Aprire una richiesta: il permesso `portal.submit` del ruolo (ondata 7).
  const { canSubmit } = usePortalAccess()
  const navigate = useNavigate()
  const { data, loading, error } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG)
  // La categoria della voce è un valore del Dizionario (ondata 2): si mostra con la sua etichetta.
  const { labelOf: categoryLabel } = useTicketCategories()
  const [openItem, setOpenItem] = useState<CatalogItem | null>(null)
  const [details, setDetails] = useState('')
  // I campi del cliente offerti nel portale per le richieste (ondata 4).
  const { fields: customFields } = usePortalCustomFields('service_request')
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({})

  /**
   * IL MODULO DELLA VOCE (moduli del catalogo, ondata 1). Lo rende lo STESSO
   * componente dell'area di lavoro (`CatalogFormRenderer` di web-core), perché
   * un utente finale deve compilare il modulo che l'amministratore ha
   * disegnato, non una versione più povera: prima il portale sapeva fare solo
   * `select` e `input`, senza sezioni, condizioni né aree di testo.
   */
  const { data: formData } = useQuery<{ catalogFormToFill: { itemId: string; revision: number; definition: string; fields: CatalogFormFieldView[] } | null }>(
    GET_PORTAL_CATALOG_FORM,
    { variables: { itemId: openItem?.id ?? '', language: i18n.language }, skip: !openItem, fetchPolicy: 'cache-and-network' },
  )
  const modulo = formData?.catalogFormToFill ?? null
  const definizione: CatalogFormDefinition | null = useMemo(() => {
    if (!modulo) return null
    try { return JSON.parse(modulo.definition) as CatalogFormDefinition } catch { return null }
  }, [modulo])
  const [risposte, setRisposte] = useState<Record<string, FormAnswerValue>>({})

  /**
   * I file dei campi allegato (ondata 2). Si caricano su una BOZZA, perché la
   * richiesta non esiste ancora: prima, dal portale, si poteva allegare solo
   * DOPO la creazione — cioè mai, per un campo del modulo.
   *
   * I campi di RIFERIMENTO non arrivano fin qui: un modulo che li offre
   * all'utente finale viene rifiutato alla pubblicazione, perché scegliere un
   * CI vuol dire cercare nella CMDB.
   */
  /*
   * LA BOZZA È DI QUESTA VOCE, non della pagina.
   *
   * Nasceva una volta per apertura della pagina, e alla creazione il server
   * reclamava TUTTI i file di quella bozza: il difetto, riprodotto dal vivo il
   * 17 set 2026, era caricare un file su «Nuovo portatile», chiudere, inviare
   * «Nuovo mouse» e vedere la richiesta del mouse portarsi dietro il file
   * dell'altra. Il server ora prende solo i file dei campi allegato visibili
   * (`claimDraftAttachments`), che è la difesa vera; qui si chiude la causa:
   * ogni apertura di una voce comincia una bozza sua, e i file di prima non
   * appartengono più a niente — li porta via la passata notturna.
   */
  const [bozzaId, setBozzaId] = useState(() => crypto.randomUUID())
  const [fileDelModulo, setFileDelModulo] = useState<Record<string, CatalogFormFile[]>>({})
  /** Le righe delle tabelle (ondata 7): non sono risposte, quindi stanno a parte. */
  const [righeTabelle, setRigheTabelle] = useState<Record<string, readonly CatalogFormTableRow[]>>({})
  const [inCaricamento, setInCaricamento] = useState<string | null>(null)

  /**
   * APRIRE (o chiudere) UNA VOCE COMINCIA DA ZERO.
   *
   * I campi della libreria sono condivisi fra i moduli, quindi senza questo
   * azzeramento la voce nuova nasceva precompilata con le risposte date a
   * quella di prima, e le sue condizioni si valutavano su risposte che non le
   * appartenevano. Con i file era peggio: restavano sulla stessa bozza e il
   * server li reclamava tutti.
   */
  const apriVoce = (it: CatalogItem | null) => {
    setBozzaId(crypto.randomUUID())
    setFileDelModulo({})
    setRisposte({})
    setRigheTabelle({})
    setOpenItem(it)
  }

  const caricaFile = async (campo: string, file: File) => {
    setInCaricamento(campo)
    try {
      const caricato = await uploadFormDraftFile(bozzaId, campo, file)
      setFileDelModulo((p) => ({ ...p, [campo]: [...(p[campo] ?? []), caricato] }))
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setInCaricamento(null)
    }
  }

  // Una condizione che si spegne fa dimenticare la risposta: il server
  // rifiuterebbe un campo nascosto che arriva comunque.
  const cambiaRisposta = (name: string, value: FormAnswerValue) => {
    setRisposte((precedenti) => {
      const aggiornate: Record<string, FormAnswerValue> = { ...precedenti, [name]: value }
      if (!definizione) return aggiornate
      const visibili = new Set(visibleCatalogFormItems(definizione, aggiornate as FormAnswers, true).map((i) => i.field))
      for (const chiave of Object.keys(aggiornate)) if (!visibili.has(chiave)) delete aggiornate[chiave]
      return aggiornate
    })
  }

  const [createRequest, { loading: submitting }] = useMutation<{ createServiceRequest: { id: string; number: string } }>(
    CREATE_SERVICE_REQUEST,
    {
      // Revisione totale · H-36: si apre la richiesta appena inviata, con la
      // conferma — prima si atterrava su «I miei ticket» con uno stato che
      // nessuno leggeva, e la richiesta non si vedeva nemmeno (H-2).
      onCompleted: (d) => { apriVoce(null); setDetails(''); navigate(`/tickets/${d.createServiceRequest.id}`, { state: { created: true } }) },
      onError: (e) => {
        notifyError(e.message)
        /**
         * Il modulo è cambiato mentre lo si compilava (ondata 8): le risposte
         * sono di un altro modulo, quindi si buttano e si chiude la richiesta.
         * Chi compila riapre la voce e trova il modulo nuovo. Si guarda la
         * CHIAVE, non il messaggio.
         */
        if (errorHasKey(e, 'errors.catalogForm.revisionChanged')) {
          // Anche la BOZZA si azzera: i file caricati per le risposte buttate
          // non appartengono più a niente, e alla seconda prova venivano
          // reclamati comunque (revisione del 17 set 2026).
          apriVoce(null)
        }
      },
    },
  )

  if (loading) return <div style={{ padding: 24, color: colors.slate }}>{t('common.loading')}</div>
  if (error) return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div role="alert" style={{ background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.strong, padding: 12, borderRadius: 8 }}>
        {t('catalog.loadError', { message: error.message })}
      </div>
    </div>
  )

  const items = data?.serviceCatalogItems ?? []
  const byCategory = items.reduce<Record<string, CatalogItem[]>>((acc, it) => {
    const c = it.category ? categoryLabel(it.category) : t('catalog.uncategorized')
    ;(acc[c] ??= []).push(it)
    return acc
  }, {})

  function submit() {
    if (!openItem) return
    const missing = portalMissingCustomFields(customFields, customValues)
    if (missing.length > 0) {
      setCustomErrors(Object.fromEntries(missing.map((m) => [m, t('common.required')])))
      return
    }
    void createRequest({ variables: { input: {
      customFields: portalCustomFieldsInput(customFields, customValues),
      title: openItem.name,
      description: details.trim() || null,
      // Nessuna priorità: la decide la voce del catalogo (verifica «Cosa resta cablato», ondata 1).
      catalogItemId: openItem.id,
      // Le risposte al modulo: la regola sta in web-core, la stessa dell'area di
      // lavoro (solo i campi visibili, mai le note).
      // La revisione compilata (ondata 8): il server rifiuta dicendolo se il
      // modulo è cambiato mentre la pagina era aperta.
      formRevision: modulo?.revision,
      formAnswers: definizione && modulo
        ? [
            ...catalogFormAnswersToSend(definizione, modulo.fields, risposte as FormAnswers, true)
              // Gli allegati non viaggiano come risposta: sono già sulla bozza.
              .filter((a) => !isFormAttachmentType(modulo.fields.find((f) => f.name === a.name)?.fieldType ?? '')),
            // Le righe delle tabelle (ondata 7): stessa regola dell'area di
            // lavoro, perché la funzione è la stessa.
            ...catalogFormTableAnswers(definizione, modulo.fields, risposte as FormAnswers, righeTabelle, true)
              .map((tb) => ({ name: tb.name, rows: tb.rows.map((r) => ({ cells: Object.entries(r).map(([column, value]) => ({ column, value })) })) })),
          ]
        : undefined,
      formDraftId: Object.values(fileDelModulo).some((l) => l.length > 0) ? bozzaId : undefined,
    } } })
  }

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: colors.slateDark, marginBottom: 6 }}>{t('catalog.title')}</h1>
      <p style={{ fontSize: 13, color: colors.slate, marginBottom: 24 }}>{t('catalog.intro')}</p>

      {items.length === 0 && <p style={{ color: colors.slate }}>{t('catalog.empty')}</p>}

      {Object.entries(byCategory).map(([cat, list]) => (
        <div key={cat} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: colors.slateLight, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>{cat}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {list.map(it => (
              <button key={it.id} disabled={!canSubmit} title={canSubmit ? undefined : t('portal.noSubmit')} onClick={() => { apriVoce(it); setDetails(''); setCustomValues({}); setCustomErrors({}) }}
                style={{ textAlign: 'left', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, cursor: canSubmit ? 'pointer' : 'default' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: colors.slateDark, marginBottom: 4 }}>{it.name}</div>
                {it.description && <div style={{ fontSize: 12, color: colors.slate, lineHeight: 1.5 }}>{it.description}</div>}
                {it.requiresApproval && <div style={{ marginTop: 8, fontSize: 11, color: palette.warning.text }}>{t('catalog.requiresApproval')}</div>}
              </button>
            ))}
          </div>
        </div>
      ))}

      {openItem && (
        <div style={{ position: 'fixed', inset: 0, background: alpha.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => apriVoce(null)}>
          <div style={{ background: colors.white, borderRadius: 12, padding: 24, width: 460, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 17, fontWeight: 600, color: colors.slateDark, marginBottom: 4 }}>{openItem.name}</h3>
            {openItem.requiresApproval && <p style={{ fontSize: 12, color: palette.warning.text, marginBottom: 12 }}>{t('catalog.approvalNotice')}</p>}
            <label style={{ fontSize: 12, fontWeight: 600, color: palette.neutral.textStrong, display: 'block', marginBottom: 6 }}>{t('catalog.details')}</label>
            <textarea value={details} onChange={e => setDetails(e.target.value)} rows={4}
              placeholder={t('catalog.detailsPlaceholder')}
              style={{ width: '100%', border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            {customFields.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <PortalCustomFields
                  fields={customFields} values={customValues} errors={customErrors} gap={12}
                  onChange={(name, value) => { setCustomValues((v) => ({ ...v, [name]: value })); setCustomErrors((p) => { const n = { ...p }; delete n[name]; return n }) }}
                  labelStyle={{ fontSize: 12, fontWeight: 600, color: palette.neutral.textStrong, display: 'block', marginBottom: 6 }}
                  inputStyle={{ width: '100%', border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10, fontSize: 13, boxSizing: 'border-box', background: colors.white }}
                />
              </div>
            )}
            {definizione && modulo && (
              <div style={{ marginTop: 14 }}>
                <CatalogFormRenderer
                  definition={definizione}
                  fields={modulo.fields}
                  answers={risposte as FormAnswers}
                  onChange={cambiaRisposta}
                  language={i18n.language}
                  endUser
                  requiredLabel={t('common.required')}
                  emptyChoiceLabel={t('common.select')}
                  yesLabel={t('common.yes')}
                  noLabel={t('common.no')}
                  computedLabel={t('catalog.computed')}
                  tables={righeTabelle}
                  onTablesChange={(campo, rows) => { setRigheTabelle((p) => ({ ...p, [campo]: rows })) }}
                  tableAddRowLabel={t('catalog.addRow')}
                  tableRemoveRowLabel={t('catalog.removeRow')}
                  files={fileDelModulo}
                  uploadingField={inCaricamento}
                  onUploadFile={caricaFile}
                  fileAddLabel={t('catalog.addFile')}
                  fileRemoveLabel={t('catalog.removeFile')}
                />
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => apriVoce(null)} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer', fontSize: 13 }}>{t('common.cancel')}</button>
              <button onClick={submit} disabled={submitting} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: colors.brand, color: colors.white, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? t('catalog.submitting') : t('catalog.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
