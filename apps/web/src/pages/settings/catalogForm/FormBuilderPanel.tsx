/**
 * IL COSTRUTTORE del modulo di una voce di catalogo (ondata 1).
 *
 * Si scelgono la voce e poi le sezioni; dentro ogni sezione si pescano i campi
 * dalla LIBRERIA (non si creano qui: un campo è una proprietà dei ticket, e
 * nasce in libreria). Per ogni campo il modulo può sovrascrivere
 * obbligatorietà, larghezza, aiuto e la condizione che lo mostra.
 *
 * L'ANTEPRIMA usa lo STESSO componente che compilano l'area di lavoro e il
 * portale (`CatalogFormRenderer`), non una finta: quello che si vede qui è
 * quello che vedrà chi compila, condizioni comprese — si può rispondere
 * nell'anteprima e guardare i campi comparire. Il disegnatore dei tipi ITIL ha
 * un'anteprima che azzera gli script e rende un modulo piatto; questa no.
 *
 * SALVARE PUBBLICA. Non ci sono bozze nell'ondata 1: si salva e la revisione
 * sale. I ticket già compilati non cambiano, perché portano la loro revisione.
 *
 * ## Quello che il 18 set 2026 ha cambiato, e perché
 * Il proprietario ha costruito un modulo dal vivo e ha trovato quattro cose.
 *
 *  - **Il campo è finito sulla voce sbagliata.** La tendina si apriva già
 *    posizionata sulla prima voce attiva, e pubblicare scriveva lì. Ora non
 *    c'è nessuna voce preselezionata e la pubblicazione chiede conferma
 *    NOMINANDO la voce: l'errore non si previene con un avviso, si previene
 *    togliendo il default che lo causava.
 *  - **Una sezione senza titolo si pubblicava in silenzio.** Ora il titolo si
 *    scrive in tutte e due le lingue e il server rifiuta: una sezione anonima
 *    la scopre chi apre il modulo, che è la persona sbagliata.
 *  - **Le sezioni non si potevano riordinare**, e per due colonne bisognava
 *    spuntare «Mezza larghezza» campo per campo.
 *  - **I campi si pescavano da una tendina.** Ora si TRASCINANO dalla scheda
 *    «Campi» sulla destra. Il trascinamento non esiste da tastiera: ogni
 *    maniglia è un bottone che si sposta con ↑ e ↓, e ogni campo della palette
 *    si aggiunge anche con Invio — senza questo, il costruttore sarebbe
 *    diventato inutilizzabile per chi non usa il mouse.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  CATALOG_FORM_VERSION, FORM_CONDITION_OPS, FORM_CONDITION_OPS_WITHOUT_VALUE, FORM_FIELD_TYPES_WITHOUT_ANSWER,
  canBeConditionSubject, emptyCatalogForm, isFormReferenceType, larghezzaEffettiva, localizedText,
  type CatalogFormDefinition, type CatalogFormItem, type CatalogFormSection,
  type FormAnswerValue, type FormAnswers, type FormCondition, type FormConditionOp,
} from '@opengraphity/types'
import { CatalogFormRenderer } from '@opengraphity/web-core'
import { GET_CATALOG_FORM, GET_FORM_FIELDS, GET_SERVICE_CATALOG_ADMIN, GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { SAVE_CATALOG_FORM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { useConfirm } from '@/hooks/useConfirm'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select } from '@/components/ui/FormControls'
import type { FormFieldRow } from './FieldLibraryPanel'

interface CatalogItem { id: string; name: string; active: boolean; category: string | null }

const bottone: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer',
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}
const iconaAzione: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 3 }

/**
 * LA MANIGLIA: si trascina col dito e si sposta con la tastiera.
 *
 * È un BOTTONE, non un `div` con `draggable`: così entra nel giro dei tab, la
 * legge un lettore di schermo, e `↑`/`↓` spostano l'elemento senza trascinare
 * niente. Il trascinamento è il gesto comodo; la tastiera è quello che rende
 * la pagina usabile — e questa è l'unica pagina da cui si compone un modulo,
 * quindi non poteva restare solo col mouse (18 set 2026).
 */
function Maniglia({ etichetta, onDragStart, onDragEnd, onSu, onGiu, onDragOver, onDrop, evidenziata }: {
  etichetta: string
  onDragStart: () => void
  onDragEnd: () => void
  onSu: () => void
  onGiu: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  evidenziata?: boolean
}) {
  return (
    <button
      type="button"
      draggable
      aria-label={etichetta}
      title={etichetta}
      onDragStart={(e) => {
        // Un payload c'è comunque: senza, Safari non avvia il trascinamento.
        e.dataTransfer.setData('text/plain', etichetta)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      {...(onDragOver ? { onDragOver } : {})}
      {...(onDrop ? { onDrop } : {})}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp')   { e.preventDefault(); onSu() }
        if (e.key === 'ArrowDown') { e.preventDefault(); onGiu() }
      }}
      style={{
        background: evidenziata ? 'var(--color-brand-light)' : 'none',
        border: evidenziata ? '1px solid var(--color-brand)' : '1px solid transparent',
        borderRadius: 5, cursor: 'grab', color: 'var(--color-slate-light)', padding: '3px 1px',
        display: 'flex', alignItems: 'center', flex: '0 0 auto',
      }}
    >
      <GripVertical size={14} />
    </button>
  )
}

/** Un identificativo di sezione stabile e valido (minuscole, cifre, trattino basso). */
function idSezione(esistenti: readonly string[]): string {
  for (let i = 1; i < 999; i++) {
    const candidato = `section_${i}`
    if (!esistenti.includes(candidato)) return candidato
  }
  return `section_${Date.now()}`
}

export function FormBuilderPanel() {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const lingua = i18n.language

  const { data: catalogData } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const voci = (catalogData?.serviceCatalogItems ?? []).filter((v) => v.active)
  /*
   * NESSUNA VOCE PRESELEZIONATA (18 set 2026).
   *
   * Qui c'era un `useEffect` che sceglieva `voci[0]`. Dal vivo è costato un
   * campo pubblicato sulla voce sbagliata: il costruttore si apriva su
   * «Accesso a un'applicazione» — la prima attiva — e chi voleva disegnare il
   * modulo di un'altra voce non se n'è accorto. Un default comodo che sceglie
   * al posto tuo su un'operazione che scrive è un difetto, non una comodità.
   */
  const [voceId, setVoceId] = useState('')
  const voceScelta = voci.find((v) => v.id === voceId) ?? null

  /** Le lingue del prodotto, dal server: sono le stesse che la pubblicazione pretende sul titolo. */
  const { data: lingueData } = useQuery<{ tenantLanguageSettings: { available: string[] } }>(GET_TENANT_LANGUAGE_SETTINGS)
  const lingue = lingueData?.tenantLanguageSettings.available ?? ['en', 'it']

  const { data: libreriaData } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language: lingua }, fetchPolicy: 'cache-and-network',
  })
  // `?? []` crea un array nuovo a ogni render: dentro le dipendenze di un
  // useMemo lo farebbe ricalcolare sempre (avviso react-hooks).
  const libreria = useMemo(() => libreriaData?.formFields ?? [], [libreriaData])
  const perNome = useMemo(() => {
    const m = new Map<string, FormFieldRow>()
    for (const f of libreria) m.set(f.name, f)
    return m
  }, [libreria])

  const { data: formData, refetch } = useQuery<{ catalogForm: { itemId: string; itemName: string; revision: number; definition: string } }>(
    GET_CATALOG_FORM, { variables: { itemId: voceId }, skip: !voceId, fetchPolicy: 'network-only' },
  )

  const [bozza, setBozza] = useState<CatalogFormDefinition>(emptyCatalogForm())
  const [toccato, setToccato] = useState(false)
  useEffect(() => {
    if (!formData?.catalogForm) return
    try { setBozza(JSON.parse(formData.catalogForm.definition) as CatalogFormDefinition) }
    catch { setBozza(emptyCatalogForm()) }
    setToccato(false)
  }, [formData])

  /**
   * CAMBIARE VOCE NON BUTTA IL DISEGNO SENZA CHIEDERE.
   *
   * `toccato` disabilitava solo il pulsante «Pubblica»: sfiorare la tendina
   * delle voci — o passare alla «Libreria dei campi» per aggiungere un campo
   * che serve, cioè il caso descritto nel commento in testa a questa pagina —
   * ricaricava la definizione salvata e il lavoro svaniva in silenzio
   * (revisione del 17 set 2026).
   */
  const chiediPrimaDiPerdere = async (): Promise<boolean> => {
    if (!toccato) return true
    return await confirm({
      title: t('pages.catalogForms.builder.discardTitle'),
      body:  t('pages.catalogForms.builder.discardBody'),
      danger: true,
    })
  }
  const cambiaVoce = async (id: string) => {
    if (!(await chiediPrimaDiPerdere())) return
    setVoceId(id)
  }

  const [risposteAnteprima, setRisposteAnteprima] = useState<Record<string, FormAnswerValue>>({})
  const [salva, { loading: salvando }] = useMutation(SAVE_CATALOG_FORM, { onError: (e) => showError(e) })

  const cambia = (f: (d: CatalogFormDefinition) => CatalogFormDefinition) => {
    setBozza((d) => f(d))
    setToccato(true)
  }

  const sostituisciSezione = (indice: number, s: CatalogFormSection) =>
    cambia((d) => ({ ...d, sections: d.sections.map((x, i) => (i === indice ? s : x)) }))

  /*
   * IL TRASCINAMENTO, con la tastiera accanto.
   *
   * `trascinato` è cosa si sta portando in giro: un campo della palette, una
   * voce già nel modulo, o una sezione intera. Sta nello stato e non solo in
   * `dataTransfer` perché serve anche per DIPINGERE il bersaglio mentre il
   * dito è ancora in aria — senza, si trascina alla cieca.
   *
   * Ogni maniglia è un bottone: `↑` e `↓` spostano senza trascinare. Il
   * trascinamento non esiste da tastiera, e questa pagina è l'unico posto da
   * cui si compone un modulo.
   */
  type Trascinato =
    | { tipo: 'palette'; campo: string }
    | { tipo: 'item'; sezione: number; voce: number }
    | { tipo: 'section'; sezione: number }
  const [trascinato, setTrascinato] = useState<Trascinato | null>(null)
  const [bersaglio, setBersaglio] = useState<string | null>(null)

  /** La sezione che riceve un campo aggiunto da tastiera: l'ultima toccata. */
  const [sezioneCorrente, setSezioneCorrente] = useState(0)
  /** La colonna destra: i campi da trascinare, oppure il modulo vero. */
  const [schedaDestra, setSchedaDestra] = useState<'fields' | 'preview'>('fields')

  const sostituisciVoce = (iSez: number, iVoce: number, v: CatalogFormItem) =>
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i !== iSez ? s : { ...s, items: s.items.map((x, j) => (j === iVoce ? v : x)) })),
    }))

  /** Sposta una sezione da una posizione all'altra. */
  const muoviSezione = (da: number, a: number) => {
    if (a < 0 || a >= bozza.sections.length || a === da) return
    cambia((d) => ({ ...d, sections: sposta(d.sections, da, a) }))
    setSezioneCorrente(a)
  }

  /**
   * Sposta un campo, anche DA UNA SEZIONE A UN'ALTRA: è la cosa che si vuole
   * fare più spesso quando un modulo cresce, e con le sole frecce non si
   * poteva fare affatto.
   */
  const muoviVoce = (daSez: number, daVoce: number, aSez: number, aVoce: number) => {
    if (daSez === aSez && (aVoce === daVoce || aVoce === daVoce + 1)) return
    cambia((d) => {
      const item = d.sections[daSez]?.items[daVoce]
      if (!item) return d
      const sezioni = d.sections.map((s, i) => (i !== daSez ? s : { ...s, items: s.items.filter((_, j) => j !== daVoce) }))
      const indice = daSez === aSez && aVoce > daVoce ? aVoce - 1 : aVoce
      return {
        ...d,
        sections: sezioni.map((s, i) => (i !== aSez ? s : { ...s, items: [...s.items.slice(0, indice), item, ...s.items.slice(indice)] })),
      }
    })
  }

  /**
   * Aggiunge un campo della libreria a una sezione, in una posizione.
   *
   * Un RIFERIMENTO nasce non offerto nel portale: scegliere un CI o una
   * persona vuol dire cercarli, e un utente finale non naviga la CMDB. L'API
   * rifiuta il modulo che lo offre, quindi è giusto che il costruttore non ci
   * arrivi nemmeno.
   */
  const aggiungiCampo = (iSez: number, nome: string, indice?: number) => {
    const scelto = perNome.get(nome)
    const voceNuova: CatalogFormItem = scelto && isFormReferenceType(scelto.fieldType)
      ? { field: nome, endUser: false }
      : { field: nome }
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => {
        if (i !== iSez) return s
        const dove = indice ?? s.items.length
        return { ...s, items: [...s.items.slice(0, dove), voceNuova, ...s.items.slice(dove)] }
      }),
    }))
    setSezioneCorrente(iSez)
  }

  /** Larghezza in blocco: la fatica vera erano dodici spunte, non la scelta. */
  const larghezzaInBlocco = (iSez: number, larghezza: 'full' | 'half') =>
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i !== iSez ? s : { ...s, items: s.items.map((it) => ({ ...it, width: larghezza })) })),
    }))

  const usati = new Set(bozza.sections.flatMap((s) => s.items.map((i) => i.field)))
  const disponibili = libreria.filter((f) => !usati.has(f.name))
  /**
   * I campi che una condizione può guardare: quelli già nel modulo che
   * diventano una PROPRIETÀ. Un allegato o un riferimento andrebbero letti dal
   * grafo, e il valutatore gira anche nel browser su quello che ha in mano.
   */
  const soggettiCondizione = [...usati].filter((n) => {
    const f = perNome.get(n)
    return f != null && canBeConditionSubject(f.fieldType)
  })

  const salvaModulo = async () => {
    /*
     * LA CONFERMA NOMINA LA VOCE, e per questo esiste: pubblicare scrive sul
     * modulo di UNA voce, e il 18 set 2026 un campo è finito su quella
     * sbagliata senza che niente lo dicesse. Non è una conferma di cortesia —
     * è l'ultimo punto in cui si legge il nome prima che il modulo cambi.
     */
    const sicuro = await confirm({
      title: t('pages.catalogForms.builder.publishConfirmTitle'),
      body:  t('pages.catalogForms.builder.publishConfirmBody', { item: voceScelta?.name ?? '' }),
    })
    if (!sicuro) return
    const r = await salva({ variables: { itemId: voceId, definition: JSON.stringify({ ...bozza, version: CATALOG_FORM_VERSION }) } })
    if (!r.data) return
    toast.success(t('pages.catalogForms.builder.published', { revision: (r.data as { saveCatalogForm: { revision: number } }).saveCatalogForm.revision }))
    setToccato(false)
    void refetch()
  }

  if (voci.length === 0) {
    return <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.catalogForms.builder.noItems')}</p>
  }

  return (
    <div className="og-split">
      {/* ── Il disegno ─────────────────────────────────────────────────── */}
      <div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <label style={{ flex: '1 1 220px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
              {t('pages.catalogForms.builder.item')}
            </span>
            <Select value={voceId} onChange={(e) => void cambiaVoce(e.target.value)}>
              <option value="">{t('pages.catalogForms.builder.chooseItem')}</option>
              {voci.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </label>
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', paddingBottom: 8 }}>
            {formData?.catalogForm?.revision
              ? t('pages.catalogForms.builder.revision', { revision: formData.catalogForm.revision })
              : t('pages.catalogForms.builder.neverPublished')}
          </span>
          <button type="button" onClick={() => void salvaModulo()} disabled={salvando || !toccato || !voceId}
            style={{ ...bottone, border: 'none', background: 'var(--color-brand)', color: colors.white, fontWeight: fontWeight.medium, padding: '7px 14px', opacity: salvando || !toccato ? 0.55 : 1, cursor: salvando || !toccato ? 'not-allowed' : 'pointer' }}>
            {salvando ? t('common.saving') : t('pages.catalogForms.builder.publish')}
          </button>
        </div>

        {/*
          Senza una voce scelta non si disegna niente: mostrare un modulo
          modificabile che non appartiene a nessuno invita a lavorare per poi
          scoprire che non si può pubblicare.
        */}
        {voceId === '' && (
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
            {t('pages.catalogForms.builder.pickItemFirst')}
          </p>
        )}

        {voceId !== '' && bozza.sections.map((sezione, iSez) => (
          <div
            key={sezione.id}
            onMouseDown={() => setSezioneCorrente(iSez)}
            onFocus={() => setSezioneCorrente(iSez)}
            /* La sezione è un bersaglio: ci si lascia cadere un campo della
               palette (va in fondo) o una voce presa da un'altra sezione. */
            onDragOver={(e) => { if (trascinato && trascinato.tipo !== 'section') { e.preventDefault(); setBersaglio(`sec-${String(iSez)}`) } }}
            onDragLeave={() => setBersaglio((b) => (b === `sec-${String(iSez)}` ? null : b))}
            onDrop={(e) => {
              e.preventDefault()
              setBersaglio(null)
              if (!trascinato) return
              if (trascinato.tipo === 'palette') aggiungiCampo(iSez, trascinato.campo)
              if (trascinato.tipo === 'item') muoviVoce(trascinato.sezione, trascinato.voce, iSez, sezione.items.length)
              setTrascinato(null)
            }}
            style={{
              border: `1px solid ${bersaglio === `sec-${String(iSez)}` ? 'var(--color-brand)' : colors.border}`,
              boxShadow: bersaglio === `sec-${String(iSez)}` ? '0 0 0 3px var(--color-brand-light)' : 'none',
              borderRadius: 10, padding: 14, marginBottom: 12, background: colors.white,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
              <Maniglia
                etichetta={t('pages.catalogForms.builder.moveSection', { title: localizedText(sezione.title, lingua, '') || sezione.id })}
                onDragStart={() => setTrascinato({ tipo: 'section', sezione: iSez })}
                onDragEnd={() => { setTrascinato(null); setBersaglio(null) }}
                onSu={() => muoviSezione(iSez, iSez - 1)}
                onGiu={() => muoviSezione(iSez, iSez + 1)}
                /* Cadere sull'intestazione di un'altra sezione riordina: è
                   l'unico punto in cui il bersaglio è «qui, fra le sezioni». */
                onDragOver={(e) => { if (trascinato?.tipo === 'section') { e.preventDefault(); setBersaglio(`ord-${String(iSez)}`) } }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (trascinato?.tipo === 'section') muoviSezione(trascinato.sezione, iSez)
                  setTrascinato(null); setBersaglio(null)
                }}
                evidenziata={bersaglio === `ord-${String(iSez)}`}
              />
              {/*
                IL TITOLO IN TUTTE LE LINGUE DEL PRODOTTO. Prima ce n'era una
                casella sola, in quella corrente, e l'altra lingua restava
                vuota senza che si vedesse: a schermo, per metà dei clienti,
                una sezione anonima. La pubblicazione ora le pretende entrambe.
              */}
              <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                {lingue.map((codice) => (
                  <Input
                    key={codice}
                    value={(sezione.title as Record<string, string | undefined>)[codice] ?? ''}
                    aria-label={t('pages.catalogForms.builder.sectionTitleIn', { language: codice.toUpperCase() })}
                    placeholder={t('pages.catalogForms.builder.sectionTitleIn', { language: codice.toUpperCase() })}
                    onChange={(e) => sostituisciSezione(iSez, { ...sezione, title: { ...sezione.title, [codice]: e.target.value } })}
                  />
                ))}
              </div>
              <button type="button" aria-label={t('pages.catalogForms.builder.removeSection')}
                onClick={() => cambia((d) => ({ ...d, sections: d.sections.filter((_, i) => i !== iSez) }))}
                style={{ ...iconaAzione, color: 'var(--color-danger)' }}>
                <Trash2 size={14} />
              </button>
            </div>

            {/* Le colonne della sezione, e la scorciatoia per i casi misti. */}
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 'var(--font-size-body)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-slate-dark)' }}>
                {t('pages.catalogForms.builder.columns')}
                <Select
                  value={String(sezione.columns ?? 1)}
                  aria-label={t('pages.catalogForms.builder.columns')}
                  onChange={(e) => sostituisciSezione(iSez, { ...sezione, columns: e.target.value === '2' ? 2 : 1 })}
                  style={{ width: 'auto' }}
                >
                  <option value="1">{t('pages.catalogForms.builder.columnsOne')}</option>
                  <option value="2">{t('pages.catalogForms.builder.columnsTwo')}</option>
                </Select>
              </label>
              {sezione.items.length > 0 && (
                <>
                  <button type="button" style={{ ...bottone, padding: '3px 8px' }} onClick={() => larghezzaInBlocco(iSez, 'half')}>
                    {t('pages.catalogForms.builder.allHalf')}
                  </button>
                  <button type="button" style={{ ...bottone, padding: '3px 8px' }} onClick={() => larghezzaInBlocco(iSez, 'full')}>
                    {t('pages.catalogForms.builder.allFull')}
                  </button>
                </>
              )}
            </div>

            {sezione.items.length === 0 && (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 10px' }}>
                {t('pages.catalogForms.builder.sectionEmpty')}
              </p>
            )}

            {sezione.items.map((item, iVoce) => {
              const campo = perNome.get(item.field)
              const senzaRisposta = campo && (FORM_FIELD_TYPES_WITHOUT_ANSWER as readonly string[]).includes(campo.fieldType)
              return (
                <div
                  key={item.field}
                  /* Cadere SU una voce la inserisce PRIMA: è come si legge un
                     elenco, e senza un bersaglio per riga si potrebbe solo
                     accodare in fondo alla sezione. */
                  onDragOver={(e) => { if (trascinato && trascinato.tipo !== 'section') { e.preventDefault(); e.stopPropagation(); setBersaglio(`item-${String(iSez)}-${String(iVoce)}`) } }}
                  onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    setBersaglio(null)
                    if (!trascinato) return
                    if (trascinato.tipo === 'palette') aggiungiCampo(iSez, trascinato.campo, iVoce)
                    if (trascinato.tipo === 'item') muoviVoce(trascinato.sezione, trascinato.voce, iSez, iVoce)
                    setTrascinato(null)
                  }}
                  style={{
                    borderTop: bersaglio === `item-${String(iSez)}-${String(iVoce)}` ? '2px solid var(--color-brand)' : `1px solid ${colors.slateBg}`,
                    padding: '10px 0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Maniglia
                      etichetta={t('pages.catalogForms.builder.moveField', { field: campo?.label ?? item.field })}
                      onDragStart={() => setTrascinato({ tipo: 'item', sezione: iSez, voce: iVoce })}
                      onDragEnd={() => { setTrascinato(null); setBersaglio(null) }}
                      onSu={() => sostituisciSezione(iSez, { ...sezione, items: scambia(sezione.items, iVoce, Math.max(0, iVoce - 1)) })}
                      onGiu={() => sostituisciSezione(iSez, { ...sezione, items: scambia(sezione.items, iVoce, Math.min(sezione.items.length - 1, iVoce + 1)) })}
                    />
                    <strong style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                      {campo?.label ?? item.field}
                    </strong>
                    <span style={{ fontSize: 'var(--font-size-table)', fontFamily: 'var(--font-mono)', color: 'var(--color-slate-light)' }}>
                      {item.field} · {t(`pages.catalogForms.fieldType.${campo?.fieldType ?? 'text'}`)}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                      <button type="button" aria-label={t('pages.catalogForms.builder.removeField')}
                        onClick={() => sostituisciSezione(iSez, { ...sezione, items: sezione.items.filter((_, j) => j !== iVoce) })}
                        style={{ ...iconaAzione, color: 'var(--color-danger)' }}>
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                    {/* Una nota non porta risposta: non può essere obbligatoria (l'API lo rifiuta). */}
                    {!senzaRisposta && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <input type="checkbox" checked={item.required ?? campo?.required ?? false}
                          onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, required: e.target.checked })} />
                        {t('pages.catalogForms.builder.required')}
                      </label>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      {/* La spunta mostra la larghezza VERA: se la sezione è a
                          due colonne, un campo che non dice niente è già a
                          metà — e vederla spenta sarebbe una bugia. */}
                      <input type="checkbox" checked={larghezzaEffettiva(sezione, item) === 'half'}
                        onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, width: e.target.checked ? 'half' : 'full' })} />
                      {t('pages.catalogForms.builder.halfWidth')}
                    </label>
                    {campo && isFormReferenceType(campo.fieldType) ? (
                      <span style={{ color: 'var(--color-slate-light)' }} title={t('pages.catalogForms.builder.referenceStaffOnlyWhy')}>
                        {t('pages.catalogForms.builder.referenceStaffOnly')}
                      </span>
                    ) : (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <input type="checkbox" checked={item.endUser !== false}
                          onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, endUser: e.target.checked })} />
                        {t('pages.catalogForms.builder.endUser')}
                      </label>
                    )}
                  </div>

                  <EditorCondizione
                    condizione={item.visibleWhen}
                    soggetti={soggettiCondizione.filter((n) => n !== item.field)}
                    etichettaDi={(n) => perNome.get(n)?.label ?? n}
                    campoDi={(n) => perNome.get(n)}
                    onChange={(c) => sostituisciVoce(iSez, iVoce, c ? { ...item, visibleWhen: c } : omettiCondizione(item))}
                  />
                </div>
              )
            })}

            {trascinato?.tipo === 'palette' && (
              <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-brand)', margin: '8px 0 0' }}>
                {t('pages.catalogForms.builder.dropHere')}
              </p>
            )}
          </div>
        ))}

        <button type="button" style={{ ...bottone, display: voceId === '' ? 'none' : undefined }}
          onClick={() => cambia((d) => ({ ...d, sections: [...d.sections, { id: idSezione(d.sections.map((s) => s.id)), title: {}, items: [] }] }))}>
          <Plus size={14} /> {t('pages.catalogForms.builder.addSection')}
        </button>

        {libreria.length === 0 && (
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 12 }}>
            {t('pages.catalogForms.builder.libraryEmpty')}
          </p>
        )}
      </div>

      {/* ── A destra: i campi da trascinare, oppure il modulo vero ──────── */}
      <div>
        {/*
          DUE SCHEDE e non due pannelli impilati: mentre si costruisce si
          guarda la palette, mentre si controlla si guarda l'anteprima, e
          tenerle entrambe a metà altezza avrebbe reso scomode tutte e due.
        */}
        <div role="tablist" aria-label={t('pages.catalogForms.builder.rightPanel')}
          style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: `1px solid ${colors.border}` }}>
          {(['fields', 'preview'] as const).map((scheda) => (
            <button
              key={scheda}
              type="button"
              role="tab"
              aria-selected={schedaDestra === scheda}
              onClick={() => setSchedaDestra(scheda)}
              style={{
                border: 'none', background: 'none', cursor: 'pointer', padding: '7px 12px',
                fontSize: 'var(--font-size-body)', fontWeight: schedaDestra === scheda ? fontWeight.medium : 400,
                color: schedaDestra === scheda ? 'var(--color-brand)' : 'var(--color-slate)',
                borderBottom: `2px solid ${schedaDestra === scheda ? 'var(--color-brand)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {scheda === 'fields' ? t('pages.catalogForms.builder.paletteTab') : t('pages.catalogForms.builder.preview')}
            </button>
          ))}
        </div>

        {schedaDestra === 'fields' ? (
          <div>
            <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>
              {t('pages.catalogForms.builder.paletteHelp')}
            </p>
            {disponibili.length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
                {libreria.length === 0 ? t('pages.catalogForms.builder.libraryEmpty') : t('pages.catalogForms.builder.paletteEmpty')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {disponibili.map((f) => {
                  const dove = bozza.sections[Math.min(sezioneCorrente, bozza.sections.length - 1)]
                  const titoloDove = dove ? (localizedText(dove.title, lingua, '') || dove.id) : ''
                  return (
                    /*
                      LA MANIGLIA TRASCINA, IL «+» AGGIUNGE (18 set 2026).
                      Due gesti separati: il trascinamento per il dito e il
                      mouse, il bottone per la tastiera — con l'etichetta che
                      dice DOVE finirà il campo, perché «aggiungi» senza «a
                      cosa» è la domanda che ha fatto finire un campo sulla
                      voce sbagliata.
                    */
                    <div
                      key={f.name}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.white,
                        padding: '8px 10px',
                      }}
                    >
                      {/*
                        SI TRASCINA DALLA MANIGLIA, non da tutta la riga: si
                        afferra il puntino, com'è l'abitudine, e il testo resta
                        selezionabile. Il «+» accanto fa la stessa cosa con un
                        clic o con Invio — due gesti, due bersagli distinti,
                        nessun elemento che è insieme bottone e oggetto da
                        trascinare.
                      */}
                      <span
                        draggable
                        aria-hidden="true"
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', f.name)
                          e.dataTransfer.effectAllowed = 'copy'
                          setTrascinato({ tipo: 'palette', campo: f.name })
                        }}
                        onDragEnd={() => { setTrascinato(null); setBersaglio(null) }}
                        style={{ display: 'flex', color: 'var(--color-slate-light)', flex: '0 0 auto', cursor: 'grab' }}
                      >
                        <GripVertical size={14} />
                      </span>
                      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: fontWeight.medium }}>{f.label}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-table)', fontFamily: 'var(--font-mono)', color: 'var(--color-slate-light)' }}>
                        {t(`pages.catalogForms.fieldType.${f.fieldType}`)}
                      </span>
                      <button
                        type="button"
                        aria-label={dove ? t('pages.catalogForms.builder.addToSection', { field: f.label, section: titoloDove }) : f.label}
                        title={dove ? t('pages.catalogForms.builder.addToSection', { field: f.label, section: titoloDove }) : ''}
                        disabled={!dove}
                        onClick={() => { if (dove) aggiungiCampo(Math.min(sezioneCorrente, bozza.sections.length - 1), f.name) }}
                        style={{ ...iconaAzione, color: dove ? 'var(--color-brand)' : 'var(--color-slate-light)', cursor: dove ? 'pointer' : 'not-allowed' }}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {bozza.sections.length === 0 && voceId !== '' && (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 10 }}>
                {t('pages.catalogForms.builder.addSectionFirst')}
              </p>
            )}
          </div>
        ) : (
        <div>
        <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>
          {t('pages.catalogForms.builder.previewHelp')}
        </p>
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, background: colors.white }}>
          <CatalogFormRenderer
            definition={bozza}
            fields={libreria}
            answers={risposteAnteprima as FormAnswers}
            onChange={(nome, valore) => setRisposteAnteprima((p) => ({ ...p, [nome]: valore }))}
            language={lingua}
            requiredLabel={t('forms.fieldRequired')}
            emptyChoiceLabel={t('common.select')}
            yesLabel={t('common.yes')}
            noLabel={t('common.no')}
          />
        </div>
        </div>
        )}
      </div>
    </div>
  )
}

/** Sposta un elemento da una posizione all'altra, mantenendo l'ordine del resto. */
function sposta<T>(list: readonly T[], da: number, a: number): T[] {
  const out = [...list]
  const [x] = out.splice(da, 1)
  if (x === undefined) return [...list]
  out.splice(a, 0, x)
  return out
}

function scambia<T>(list: readonly T[], a: number, b: number): T[] {
  const out = [...list]
  const x = out[a]!, y = out[b]!
  out[a] = y; out[b] = x
  return out
}

/** Togliere la condizione vuol dire togliere la chiave: `undefined` non è JSON. */
function omettiCondizione(item: CatalogFormItem): CatalogFormItem {
  const { visibleWhen: _, ...resto } = item
  return resto
}

/**
 * IL VALORE DI UNA REGOLA, SCELTO E NON DIGITATO.
 *
 * Era una casella di testo sempre, anche quando il campo sceglie da un
 * vocabolario del Dizionario: l'amministratore doveva conoscere il valore
 * INTERNO (`production`), e chi scriveva «Produzione» — cioè l'etichetta che
 * il prodotto gli mostra ovunque — otteneva una condizione che non sarebbe
 * scattata mai, in silenzio. È lo stesso difetto chiuso per le business rule
 * nell'ondata 5 dei moduli e rimasto aperto qui; l'ho visto nel browser
 * guardando la regola di «Costo stimato» (revisione del 17 set 2026).
 *
 * Le scelte arrivano dalla libreria (`options`, già con le etichette nella
 * lingua di chi guarda). Un sì/no offre Sì e No. Tutto il resto resta testo,
 * perché è testo davvero.
 */
function ValoreDellaRegola({ campo, valore, onValore }: {
  campo: FormFieldRow | undefined
  valore: string
  onValore: (v: string) => void
}) {
  const { t } = useTranslation()
  const stile = { width: 'auto', minWidth: 120, padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }

  if (campo && campo.options.length > 0) {
    return (
      <Select value={valore} style={stile} onChange={(e) => onValore(e.target.value)}>
        <option value="">{t('common.select')}</option>
        {campo.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {/* Un valore salvato che il Dizionario non ha più resta visibile invece
            di sembrare un'altra scelta. */}
        {valore !== '' && !campo.options.some((o) => o.value === valore) && (
          <option value={valore}>{valore}</option>
        )}
      </Select>
    )
  }
  if (campo?.fieldType === 'boolean') {
    return (
      <Select value={valore} style={stile} onChange={(e) => onValore(e.target.value)}>
        <option value="">{t('common.select')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </Select>
    )
  }
  return (
    <Input value={valore} style={{ width: 120, padding: '2px 6px', fontSize: 'var(--font-size-table)' }}
      onChange={(e) => onValore(e.target.value)} />
  )
}

/**
 * L'editor di una condizione. Dichiarativa, non uno script: così si può
 * mostrare, spiegare e verificare — e il server la rivaluta con la stessa
 * funzione, senza eseguire codice del cliente.
 */
function EditorCondizione({ condizione, soggetti, etichettaDi, campoDi, onChange }: {
  condizione?: FormCondition
  soggetti: readonly string[]
  etichettaDi: (name: string) => string
  /** Il campo della libreria: da lì vengono il tipo e le scelte del Dizionario. */
  campoDi: (name: string) => FormFieldRow | undefined
  onChange: (c: FormCondition | undefined) => void
}) {
  const { t } = useTranslation()
  const regole = condizione?.rules ?? []

  if (soggetti.length === 0 && regole.length === 0) return null

  return (
    <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: `2px solid ${colors.slateBg}` }}>
      {regole.length === 0 ? (
        <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
          onClick={() => onChange({ match: 'all', rules: [{ field: soggetti[0]!, op: 'eq', value: '' }] })}>
          <Plus size={12} /> {t('pages.catalogForms.builder.addCondition')}
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
            <span>{t('pages.catalogForms.builder.showWhen')}</span>
            <Select value={condizione!.match} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
              onChange={(e) => onChange({ ...condizione!, match: e.target.value as 'all' | 'any' })}>
              <option value="all">{t('pages.catalogForms.builder.matchAll')}</option>
              <option value="any">{t('pages.catalogForms.builder.matchAny')}</option>
            </Select>
          </div>
          {regole.map((regola, i) => (
            <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 5, flexWrap: 'wrap' }}>
              <Select value={regola.field} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)) })}>
                {soggetti.map((n) => <option key={n} value={n}>{etichettaDi(n)}</option>)}
              </Select>
              <Select value={regola.op} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => {
                  const op = e.target.value as FormConditionOp
                  const senzaValore = (FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(op)
                  onChange({
                    ...condizione!,
                    rules: condizione!.rules.map((r, j) => (j === i ? (senzaValore ? { field: r.field, op } : { field: r.field, op, value: r.value ?? '' }) : r)),
                  })
                }}>
                {FORM_CONDITION_OPS.map((op) => <option key={op} value={op}>{t(`pages.catalogForms.conditionOp.${op}`)}</option>)}
              </Select>
              {!(FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(regola.op) && (
                <ValoreDellaRegola
                  campo={campoDi(regola.field)}
                  valore={regola.value ?? ''}
                  onValore={(v) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, value: v } : r)) })}
                />
              )}
              <button type="button" aria-label={t('pages.catalogForms.builder.removeCondition')}
                onClick={() => {
                  const restanti = condizione!.rules.filter((_, j) => j !== i)
                  onChange(restanti.length === 0 ? undefined : { ...condizione!, rules: restanti })
                }}
                style={iconaAzione}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
            onClick={() => onChange({ ...condizione!, rules: [...condizione!.rules, { field: soggetti[0]!, op: 'eq', value: '' }] })}>
            <Plus size={12} /> {t('pages.catalogForms.builder.addRule')}
          </button>
        </>
      )}
    </div>
  )
}
