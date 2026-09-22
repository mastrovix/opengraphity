import { useState, useMemo } from 'react'
import { useQuery, useMutation, useApolloClient } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GET_SERVICE_CATALOG } from '@/graphql/queries'
import { GET_PORTAL_CATALOG_FORM, GET_PORTAL_REFERENCE_CHOICES } from '../graphql/queries'
import {
  CatalogFormRenderer, catalogFormAnswersToSend, catalogFormTableAnswers, visibleCatalogFormItems,
  type CatalogFormFieldView, type CatalogFormFile, type CatalogFormTableRow,
} from '@opengraphity/web-core'
import { isFormAttachmentType, isFormReferenceType } from '@opengraphity/types'
import { uploadFormDraftFile } from '../lib/formDraftUpload'
import type { CatalogFormDefinition, FormAnswerValue, FormAnswers } from '@opengraphity/types'
import { CREATE_SERVICE_REQUEST, DELETE_FORM_ATTACHMENT } from '@/graphql/mutations'
import { notifyError } from '@/lib/notify'
import { errorFieldName, errorHasKey } from '@opengraphity/web-core'
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
  /** I campi CALCOLATI del modulo: il loro valore non è una risposta da cancellare. */
  const calcolati = useMemo(
    () => new Set((modulo?.fields ?? []).filter((f) => f.formula && f.formula.trim() !== '').map((f) => f.name)),
    [modulo],
  )

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
  /**
   * I CI scelti nei campi «riferimento» (20 set 2026). Non sono risposte:
   * viaggiano in `refIds` e diventano relazioni, come nell'area di lavoro.
   */
  const [riferimenti, setRiferimenti] = useState<Record<string, { id: string; label: string }[]>>({})
  const apollo = useApolloClient()

  /**
   * Le scelte di un campo «riferimento»: le chiede al PRODOTTO, non alla
   * CMDB. Il server risponde con i CI dei tipi che quel campo dichiara — se
   * non ne dichiara nessuno il campo non è nemmeno offerto qui.
   */
  const cercaRiferimento = async (campo: { name: string }, query: string): Promise<{ id: string; label: string }[]> => {
    if (!openItem) return []
    const r = await apollo.query<{ portalReferenceChoices: { id: string; label: string }[] }>({
      query: GET_PORTAL_REFERENCE_CHOICES,
      variables: { itemId: openItem.id, field: campo.name, search: query || null },
      fetchPolicy: 'network-only',
    })
    return r.data?.portalReferenceChoices ?? []
  }

  /** Le righe delle tabelle (ondata 7): non sono risposte, quindi stanno a parte. */
  const [righeTabelle, setRigheTabelle] = useState<Record<string, readonly CatalogFormTableRow[]>>({})
  const [inCaricamento, setInCaricamento] = useState<string | null>(null)
  /**
   * Il rifiuto del server acceso ACCANTO al campo che accusa: il portale non
   * passava affatto `errors` al renderer, quindi l'unico segnale era l'avviso
   * all'angolo, che sparisce dopo pochi secondi e su un modulo lungo lascia
   * indovinare quale casella (revisione del 17 set 2026).
   */
  const [erroriModulo, setErroriModulo] = useState<Record<string, string>>({})

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
    setErroriModulo({})
    setOpenItem(it)
  }

  /**
   * Toglie un file caricato per sbaglio. Si CANCELLA, non si dimentica: il
   * reclamo alla creazione guarda il grafo, quindi un file dimenticato solo
   * dalla pagina tornerebbe sul ticket.
   */
  const togliFile = async (campo: string, id: string) => {
    const r = await cancellaAllegato({ variables: { id } })
    if (!r.data) return
    setFileDelModulo((p) => ({ ...p, [campo]: (p[campo] ?? []).filter((f) => f.id !== id) }))
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

  /*
   * UN VALORE CALCOLATO NON SI CANCELLA, anche se il suo campo è nascosto.
   *
   * La pulizia serve alle risposte DATE: una condizione che si spegne fa
   * dimenticare quello che era stato scritto, perché il server rifiuta un
   * campo nascosto che arriva comunque. Ma un campo CALCOLATO non è una
   * risposta: è un valore che il renderer produce e che le condizioni
   * guardano, esattamente come fa il server dal 17 set 2026 (le formule
   * girano per tutti i campi calcolati del modulo, la visibilità decide solo
   * cosa finisce sul ticket). E nell'invio i calcolati sono già esclusi da
   * `catalogFormAnswersToSend`.
   *
   * Cancellarlo faceva un CICLO INFINITO, misurato nel portale: il renderer lo
   * riscriveva, la pagina lo cancellava, l'oggetto cambiava identità, l'effetto
   * ripartiva — un giro di QuickJS ogni ~330 ms con il modulo fermo, per tutto
   * il tempo che la pagina resta aperta.
   */
  // Una condizione che si spegne fa dimenticare la risposta: il server
  // rifiuterebbe un campo nascosto che arriva comunque.
  const cambiaRisposta = (name: string, value: FormAnswerValue) => {
    setRisposte((precedenti) => {
      const aggiornate: Record<string, FormAnswerValue> = { ...precedenti, [name]: value }
      if (!definizione) return aggiornate
      const visibili = new Set(visibleCatalogFormItems(definizione, aggiornate as FormAnswers, true).map((i) => i.field))
      for (const chiave of Object.keys(aggiornate)) {
        if (!visibili.has(chiave) && !calcolati.has(chiave)) delete aggiornate[chiave]
      }
      return aggiornate
    })
  }

  const [cancellaAllegato] = useMutation(DELETE_FORM_ATTACHMENT, { onError: (e) => notifyError(e.message) })
  const [createRequest, { loading: submitting }] = useMutation<{ createServiceRequest: { id: string; number: string } }>(
    CREATE_SERVICE_REQUEST,
    {
      // Revisione totale · H-36: si apre la richiesta appena inviata, con la
      // conferma — prima si atterrava su «I miei ticket» con uno stato che
      // nessuno leggeva, e la richiesta non si vedeva nemmeno (H-2).
      onCompleted: (d) => { apriVoce(null); setDetails(''); navigate(`/tickets/${d.createServiceRequest.id}`, { state: { created: true } }) },
      onError: (e) => {
        notifyError(e.message)
        const campo = errorFieldName(e)
        if (campo) setErroriModulo({ [campo]: e.message })
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
              .filter((a) => !isFormAttachmentType(modulo.fields.find((f) => f.name === a.name)?.fieldType ?? ''))
              // Un riferimento viaggia in `refIds`: il server verifica che il
              // nodo esista nel tenant e scrive una relazione (come nell'area
              // di lavoro).
              .map((a) => {
                const tipo = modulo.fields.find((f) => f.name === a.name)?.fieldType ?? ''
                if (!isFormReferenceType(tipo)) return a
                const scelto = riferimenti[a.name]?.[0]
                return { name: a.name, refIds: scelto ? [scelto.id] : [] }
              }),
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
        /*
         * IL MODULO DEVE SCORRERE, E IL MODALE DEVE ESSERE UN DIALOGO
         * (revisione del 17 set 2026).
         *
         * Il pannello era centrato in un contenitore `fixed` senza
         * `max-height` né `overflow`: un modulo più alto della finestra veniva
         * tagliato SOPRA e SOTTO — i pulsanti «Annulla / Invia» finivano fuori
         * schermo e i primi campi erano irraggiungibili. Ed è esattamente il
         * modulo ricco per cui l'ondata 1 esiste.
         *
         * E non era un dialogo: nessun ruolo, nessun nome, nessun Escape,
         * nessun fuoco spostato. Con un lettore di schermo il modulo non
         * veniva annunciato e si continuava a tabulare nella pagina sotto.
         */
        /*
         * Lo sfondo è DECORAZIONE (`role="presentation"`, 21 set 2026):
         * chiudere cliccandoci sopra è una comodità del mouse, e
         * l'equivalente da tastiera è Escape — che sta qui e funziona perché
         * il fuoco è sul dialogo qui dentro e l'evento risale.
         *
         * E il clic chiude solo se arriva PROPRIO sullo sfondo: prima il
         * pannello doveva fermare l'evento con uno `stopPropagation`, e un
         * gestore di clic su un dialogo è esattamente ciò che un lettore di
         * schermo non sa come annunciare.
         */
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, background: alpha.scrim, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, padding: 24, overflowY: 'auto' }}
          onClick={(e) => { if (e.target === e.currentTarget) apriVoce(null) }}
          onKeyDown={(e) => { if (e.key === 'Escape') apriVoce(null) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="og-catalog-modal-title"
            ref={(el) => { el?.focus() }}
            tabIndex={-1}
            style={{ background: colors.white, borderRadius: 12, padding: 24, width: 460, maxWidth: '90vw', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', outline: 'none' }}
          >
            <h3 id="og-catalog-modal-title" style={{ fontSize: 17, fontWeight: 600, color: colors.slateDark, marginBottom: 4 }}>{openItem.name}</h3>
            {openItem.requiresApproval && <p style={{ fontSize: 12, color: palette.warning.text, marginBottom: 12 }}>{t('catalog.approvalNotice')}</p>}
            <label style={{ fontSize: 12, fontWeight: 600, color: palette.neutral.textStrong, display: 'block', marginBottom: 6 }}>{t('catalog.details')}</label>
            <textarea aria-label={t('catalog.details')} value={details} onChange={e => setDetails(e.target.value)} rows={4}
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
                  errors={erroriModulo}
                  files={fileDelModulo}
                  uploadingField={inCaricamento}
                  onUploadFile={caricaFile}
                  /* Un file caricato per sbaglio si deve poter togliere: la × del
                     renderer compare solo con questa prop, e il portale non la
                     passava (nel web sì). */
                  onRemoveFile={togliFile}
                  fileAddLabel={t('catalog.addFile')}
                  fileRemoveLabel={t('catalog.removeFile')}
                  /*
                   * I campi «riferimento» (20 set 2026): non si naviga la
                   * CMDB, si sceglie fra i CI dei TIPI che il campo dichiara
                   * — è il prodotto a dire quali sono, con
                   * `portalReferenceChoices`.
                   */
                  references={riferimenti}
                  onSearchReference={cercaRiferimento}
                  onPickReference={(campo, scelto) => { setRiferimenti((p) => ({ ...p, [campo]: scelto ? [scelto] : [] })) }}
                  referenceSearchLabel={t('catalog.searchReference')}
                  referenceNoResultsLabel={t('catalog.noResults')}
                  referenceClearLabel={t('catalog.clearReference')}
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
