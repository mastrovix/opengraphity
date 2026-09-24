/**
 * «DESCRIVIMI LA SERVICE REQUEST E TE LA DISEGNO» — l'interfaccia (19 set 2026).
 *
 * Tre passi, in un modale solo:
 *
 *  1. **la descrizione**: una casella di testo e un bottone. Niente moduli da
 *     compilare: se chi configura dovesse già sapere quali campi vuole, non
 *     avrebbe bisogno di chiederlo;
 *  2. **la revisione**: la proposta pezzo per pezzo, e accanto a ogni campo il
 *     PERCHÉ — da quale pezzo della frase nasce, e se è un campo che esisteva
 *     già («riuso») o uno nuovo. È la cautela che il proprietario ha chiesto:
 *     «rende la revisione veloce invece che un atto di fede». Qui si vedono
 *     anche gli SCARTI, il JavaScript proposto e i vocabolari da creare;
 *  3. **l'accettazione**: prima si creano le cose che devono esistere (i
 *     vocabolari nel Dizionario, i campi nella libreria), poi le sezioni
 *     atterrano sulla tela come bozza NON salvata. Pubblicare resta un gesto
 *     a parte, con il suo bottone.
 *
 * ## Perché la creazione avviene accettando, e non prima
 * Un modulo cita i campi per NOME: per metterli sulla tela devono esistere in
 * libreria, esattamente come quando si trascina un tipo dalla palette. Ma
 * fino a «Metti sulla tela» non si è creato niente — chi guarda una proposta e
 * la scarta non lascia in giro dodici campi orfani.
 *
 * ## Se una creazione fallisce si ferma tutto lì
 * I campi si creano in fila e alla prima che il server rifiuta (nome
 * riservato, libreria piena, vocabolario inesistente) si ferma: si dice quali
 * sono stati creati e quali no, e la tela non si tocca. Mettere sulla tela un
 * campo che non esiste vorrebbe dire un modulo che non si può salvare, e la
 * spiegazione arriverebbe dieci minuti dopo.
 */
import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Sparkles, AlertTriangle, Recycle, Plus, Code2, Eye } from 'lucide-react'
import { showError } from '@/lib/showError'
import { CREATE_ENUM_TYPE } from '@/graphql/mutations'
import { CREATE_FORM_FIELD, PROPOSE_SERVICE_REQUEST_DESIGN } from '@/graphql/mutations/catalogForm'
import { Button } from '@/components/Button'
import { colors, fontWeight } from '@/lib/tokens'
import { ModaleCentrato } from './ModaleCentrato'

// ── La forma della proposta, come arriva dal server ─────────────────────────

export interface VoceProgettata {
  name: string
  description: string | null
  category: string | null
  priority: string | null
  requiresApproval: boolean
  workflowDefinitionId: string | null
  workflowDefinitionName: string | null
  why: string
}

export interface CampoProgettato {
  name: string
  fieldType: string
  labelIt: string
  labelEn: string
  helpIt: string | null
  helpEn: string | null
  vocabulary: string | null
  refTypes: string[]
  formula: string | null
  validationScript: string | null
  why: string
}

export interface VoceDiSezioneProgettata {
  field: string
  source: 'library' | 'new'
  required: boolean
  width: 'full' | 'half'
  endUser: boolean
  readOnly: boolean
  visibleWhen: string | null
  why: string
}

export interface SezioneProgettata {
  id: string
  titleIt: string
  titleEn: string
  columns: number
  items: VoceDiSezioneProgettata[]
}

export interface Progetto {
  prompt: string
  maxFieldsPerForm: number
  item: VoceProgettata | null
  sections: SezioneProgettata[]
  newFields: CampoProgettato[]
  newVocabularies: { name: string; label: string; values: string[]; why: string }[]
  discarded: { what: string; key: string; params: string }[]
  notes: string[]
}

/** Gli scarti arrivano come chiave + parametri JSON: si rendono nella lingua del cliente. */
function useScarto() {
  const { t } = useTranslation()
  return (s: { what: string; key: string; params: string }): string => {
    let params: Record<string, unknown> = {}
    try { params = JSON.parse(s.params) as Record<string, unknown> }
    catch (err) { console.error('Unreadable params on a discarded proposal item', err) }
    return t(s.key, params)
  }
}

export function ModaleProgettoAI({ itemId, nomeVoce, etichettaDi, onChiudi, onApplicato }: {
  /** La voce a cui aggiungere campi; `null` = una service request nuova. */
  itemId: string | null
  nomeVoce: string | null
  /**
   * L'etichetta di un campo della LIBRERIA, per nome.
   *
   * Serve perché un campo riusato qui si chiamava col nome tecnico
   * (`motivazione_della_richiesta`): è il nome della proprietà sul ticket, non
   * la domanda — e chi rivede una proposta legge la domanda.
   */
  etichettaDi: (nome: string) => string
  onChiudi: () => void
  /**
   * Chiamato quando i campi (e i vocabolari) esistono: chi ha la tela ci mette
   * le sezioni.
   *
   * Risponde `'done'` se sono già sulla tela, `'pending'` se prima serve
   * un altro gesto (creare la service request). La differenza sta nel MESSAGGIO:
   * dire «cinque campi sulla tela» quando la tela non li ha ancora è una
   * bugia piccola che fa cercare qualcosa che non c'è.
   */
  onApplicato: (progetto: Progetto) => Promise<'done' | 'pending'> | 'done' | 'pending'
}) {
  const { t } = useTranslation()
  const rendiScarto = useScarto()
  const [descrizione, setDescrizione] = useState('')
  const [progetto, setProgetto] = useState<Progetto | null>(null)
  const [applicando, setApplicando] = useState(false)

  const [proponi, { loading: pensando }] = useMutation(PROPOSE_SERVICE_REQUEST_DESIGN, { onError: (e) => showError(e) })
  const [creaVocabolario] = useMutation(CREATE_ENUM_TYPE, { onError: (e) => showError(e) })
  const [creaCampo] = useMutation(CREATE_FORM_FIELD, { onError: (e) => showError(e) })

  const chiedi = () => {
    void (async () => {
      let r: Awaited<ReturnType<typeof proponi>>
      try {
        r = await proponi({ variables: { prompt: descrizione.trim(), itemId } })
      } catch {
        // The mutation's onError has already told the user; the description stays, so nobody retypes it.
        return
      }
      // The proposal is non-null in the schema: a refusal rejects, it never resolves empty.
      setProgetto((r.data as { proposeServiceRequestDesign: Progetto }).proposeServiceRequestDesign)
    })()
  }

  /** Crea quello che deve esistere, poi passa la tela a chi la sa toccare. */
  const applica = () => {
    if (!progetto) return
    void (async () => {
      setApplicando(true)
      const fatti: string[] = []
      /*
       * `creati` distingue i due fallimenti (19 set 2026, dalla revisione).
       * Se a rompersi era l'ATTERRAGGIO sulla tela — non la creazione — il
       * messaggio diceva lo stesso «creati solo A, B, C. La tela non è stata
       * toccata», mandando a cercare in libreria dei campi che c'erano già:
       * e chi non li trova li rifà, con `_2` in coda.
       */
      let creati = false
      try {
        for (const v of progetto.newVocabularies) {
          // `shared`: un elenco di valori nato per un modulo non appartiene né
          // all'ITIL né alla CMDB, e da lì lo può pescare qualunque campo.
          await creaVocabolario({ variables: { input: { name: v.name, label: v.label, values: v.values, scope: 'shared' } } })
          fatti.push(v.label)
        }
        for (const c of progetto.newFields) {
          await creaCampo({ variables: { input: {
            name: c.name, fieldType: c.fieldType,
            label: c.labelIt || c.labelEn,
            labels: [
              ...(c.labelIt === '' ? [] : [{ language: 'it', text: c.labelIt }]),
              ...(c.labelEn === '' ? [] : [{ language: 'en', text: c.labelEn }]),
            ],
            ...(c.helpIt === null && c.helpEn === null ? {} : { helps: [
              ...(c.helpIt === null ? [] : [{ language: 'it', text: c.helpIt }]),
              ...(c.helpEn === null ? [] : [{ language: 'en', text: c.helpEn }]),
            ] }),
            // Obbligatorio lo decide il MODULO (`required` sulla voce di
            // sezione), non la libreria: lo stesso campo può servire sempre in
            // una richiesta e mai in un'altra.
            required: false,
            vocabulary: c.vocabulary,
            refTypes: c.refTypes,
            formula: c.formula,
            validationScript: c.validationScript,
            // Privato del modulo che lo ha fatto nascere: è la regola di
            // default della libreria, e vale anche per i campi dell'AI.
            shared: false,
          } } })
          fatti.push(c.labelIt || c.name)
        }
        creati = true
        const esito = await onApplicato(progetto)
        toast.success(esito === 'done'
          ? t('pages.catalogForms.ai.applied', { count: progetto.sections.reduce((n, s) => n + s.items.length, 0) })
          : t('pages.catalogForms.ai.appliedPending', { count: progetto.newFields.length }))
        onChiudi()
      } catch {
        // Si dice cosa è stato creato prima di fermarsi: senza, resterebbero
        // campi in libreria che nessuno sa da dove vengono.
        if (creati) toast.error(t('pages.catalogForms.ai.landingFailed'))
        else if (fatti.length > 0) toast.error(t('pages.catalogForms.ai.partial', { done: fatti.join(', ') }))
      } finally { setApplicando(false) }
    })()
  }

  const campi = progetto?.sections.reduce((n, s) => n + s.items.length, 0) ?? 0

  return (
    <ModaleCentrato
      titolo={t('pages.catalogForms.ai.title')}
      sottotitolo={itemId === null
        ? t('pages.catalogForms.ai.subtitleNew')
        : t('pages.catalogForms.ai.subtitleExisting', { item: nomeVoce ?? '' })}
      largo={760}
      onChiudi={onChiudi}
    >
      {progetto === null ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <label htmlFor="ai-description" style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
            {t('pages.catalogForms.ai.promptLabel')}
          </label>
          <textarea
            id="ai-description"
            value={descrizione}
            onChange={(e) => { setDescrizione(e.target.value) }}
            rows={6}
            placeholder={t('pages.catalogForms.ai.promptPlaceholder')}
            style={{
              width: '100%', padding: 10, borderRadius: 8, border: `1px solid ${colors.border}`,
              fontSize: 'var(--font-size-body)', fontFamily: 'inherit', resize: 'vertical',
            }}
          />
          <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
            {t('pages.catalogForms.ai.promptHelp')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={chiedi} disabled={descrizione.trim().length < 10 || pensando}>
              <Sparkles size={14} style={{ marginRight: 6 }} />
              {pensando ? t('pages.catalogForms.ai.thinking') : t('pages.catalogForms.ai.design')}
            </Button>
            <Button variant="secondary" onClick={onChiudi}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* La frase da cui è nata: si rilegge accanto al risultato. */}
          <div style={{ background: 'var(--color-surface-2)', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('pages.catalogForms.ai.youAsked')}</div>
            <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{progetto.prompt}</div>
          </div>

          {progetto.item !== null && (
            <section>
              <Titolo testo={t('pages.catalogForms.ai.itemHeading')} />
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: fontWeight.medium }}>{progetto.item.name}</div>
              {progetto.item.description !== null && (
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>{progetto.item.description}</div>
              )}
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                <li>{t('pages.catalogForms.ai.itemCategory', { value: progetto.item.category ?? t('pages.catalogForms.ai.notChosen') })}</li>
                <li>{t('pages.catalogForms.ai.itemPriority', { value: progetto.item.priority ?? t('pages.catalogForms.ai.notChosen') })}</li>
                <li>{progetto.item.requiresApproval ? t('pages.catalogForms.ai.itemApprovalYes') : t('pages.catalogForms.ai.itemApprovalNo')}</li>
                <li>{t('pages.catalogForms.ai.itemWorkflow', { value: progetto.item.workflowDefinitionName ?? t('pages.catalogForms.ai.workflowByCategory') })}</li>
              </ul>
              <Perche testo={progetto.item.why} />
            </section>
          )}

          <section>
            <Titolo testo={t('pages.catalogForms.ai.sectionsHeading', { sections: progetto.sections.length, fields: campi })} />
            {progetto.sections.map((s) => (
              <div key={s.id} style={{ marginTop: 8 }}>
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium, color: 'var(--color-slate-dark)' }}>
                  {s.titleIt || s.titleEn}
                  <span style={{ fontWeight: fontWeight.regular, color: 'var(--color-slate-light)' }}>
                    {' · '}{t('pages.catalogForms.ai.columns', { count: s.columns })}
                  </span>
                </div>
                <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 6 }}>
                  {s.items.map((i) => {
                    const nuovo = progetto.newFields.find((c) => c.name === i.field)
                    return (
                      <li key={i.field} style={{ borderLeft: `2px solid ${colors.border}`, paddingLeft: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                            {nuovo ? (nuovo.labelIt || nuovo.labelEn) : etichettaDi(i.field)}
                          </span>
                          <Pillola tipo={i.source} />
                          {nuovo && <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                            {t(`pages.catalogForms.fieldType.${nuovo.fieldType}`)}
                          </span>}
                          {i.required && <Etichetta testo={t('pages.catalogForms.ai.required')} />}
                          {i.readOnly && <Etichetta testo={t('pages.catalogForms.ai.readOnly')} />}
                          {!i.endUser && <Etichetta testo={t('pages.catalogForms.ai.internal')} />}
                          {i.visibleWhen !== null && <Etichetta testo={t('pages.catalogForms.ai.conditional')} icona={<Eye size={11} />} />}
                          {nuovo?.formula != null && <Etichetta testo={t('pages.catalogForms.ai.computed')} icona={<Code2 size={11} />} />}
                        </div>
                        <Perche testo={i.why} />
                        {/* Il JavaScript si LEGGE prima di accettarlo: è codice
                            che girerà sui dati del cliente. */}
                        {nuovo?.formula != null && <Codice titolo={t('pages.catalogForms.ai.formula')} codice={nuovo.formula} />}
                        {nuovo?.validationScript != null && <Codice titolo={t('pages.catalogForms.ai.validation')} codice={nuovo.validationScript} />}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </section>

          {progetto.newVocabularies.length > 0 && (
            <section>
              <Titolo testo={t('pages.catalogForms.ai.vocabulariesHeading')} />
              <p style={{ margin: '0 0 4px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                {t('pages.catalogForms.ai.vocabulariesHelp')}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-dark)' }}>
                {progetto.newVocabularies.map((v) => (
                  <li key={v.name}>
                    <strong style={{ fontWeight: fontWeight.medium }}>{v.label}</strong>{' — '}{v.values.join(', ')}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {progetto.discarded.length > 0 && (
            <section>
              <Titolo testo={t('pages.catalogForms.ai.discardedHeading')} />
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
                {progetto.discarded.map((s, i) => (
                  <li key={`${s.key}-${String(i)}`} style={{ display: 'flex', gap: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-warning-dark)' }} />
                    <span><strong style={{ fontWeight: fontWeight.medium }}>{s.what}</strong>{' — '}{rendiScarto(s)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {progetto.notes.length > 0 && (
            <section>
              <Titolo testo={t('pages.catalogForms.ai.notesHeading')} />
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                {progetto.notes.map((n, i) => <li key={String(i)}>{n}</li>)}
              </ul>
            </section>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={applica} disabled={applicando || progetto.sections.length === 0}>
              {applicando ? t('common.saving') : t('pages.catalogForms.ai.apply')}
            </Button>
            <Button variant="secondary" onClick={() => { setProgetto(null) }}>{t('pages.catalogForms.ai.again')}</Button>
            <Button variant="secondary" onClick={onChiudi}>{t('common.cancel')}</Button>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
            {t('pages.catalogForms.ai.applyHelp')}
          </p>
        </div>
      )}
    </ModaleCentrato>
  )
}

function Titolo({ testo }: { testo: string }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-table)', textTransform: 'uppercase', letterSpacing: '0.04em',
      color: 'var(--color-slate-light)', fontWeight: fontWeight.medium, marginBottom: 4,
    }}>{testo}</div>
  )
}

/** Il PERCHÉ: da quale pezzo della frase nasce. Senza, la revisione è un atto di fede. */
function Perche({ testo }: { testo: string }) {
  if (testo.trim() === '') return null
  return <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontStyle: 'italic' }}>{testo}</div>
}

function Pillola({ tipo }: { tipo: 'library' | 'new' }) {
  const { t } = useTranslation()
  const riuso = tipo === 'library'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 999,
      fontSize: 'var(--font-size-table)',
      background: riuso ? 'var(--color-surface-2)' : 'var(--color-brand-a13)',
      color: riuso ? 'var(--color-slate)' : 'var(--color-brand)',
    }}>
      {riuso ? <Recycle size={11} /> : <Plus size={11} />}
      {riuso ? t('pages.catalogForms.ai.reused') : t('pages.catalogForms.ai.new')}
    </span>
  )
}

function Etichetta({ testo, icona }: { testo: string; icona?: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)',
    }}>{icona}{testo}</span>
  )
}

function Codice({ titolo, codice }: { titolo: string; codice: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{titolo}</div>
      <pre style={{
        margin: 0, padding: 8, borderRadius: 6, background: 'var(--color-surface-2)',
        fontSize: 'var(--font-size-table)', overflowX: 'auto', whiteSpace: 'pre-wrap',
      }}><code>{codice}</code></pre>
    </div>
  )
}
